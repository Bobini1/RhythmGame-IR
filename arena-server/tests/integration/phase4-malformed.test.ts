import { createHash } from 'node:crypto';
import { afterEach, describe, expect, test } from 'bun:test';

import type { ArenaApplication } from '../../src/application/arena-application.ts';
import { loadArenaConfig } from '../../src/config.ts';
import { InventoryUploadManager } from '../../src/inventory/inventory-upload-manager.ts';
import { createOperationalMetrics } from '../../src/observability/operational-metrics.ts';
import {
	BINARY_HEADER_BYTES,
	MAX_BINARY_FRAME_BYTES,
	MAX_HASHES_PER_CHUNK,
	decodeHashChunk,
	encodeHashChunk
} from '../../src/protocol/binary.ts';
import { decodeClientMessage } from '../../src/protocol/codec.ts';
import { ProtocolError } from '../../src/protocol/errors.ts';
import type { InventoryDeclaration } from '../../src/protocol/messages.ts';
import {
	BACKPRESSURE_LIMIT_BYTES,
	classifySocketDelivery,
	startArenaServer,
	type ArenaServerHandle
} from '../../src/transport/start-server.ts';

let handle: ArenaServerHandle | undefined;

afterEach(async () => {
	await handle?.shutdown({ drainMs: 0 });
	handle = undefined;
});

function fakeApplication(): ArenaApplication {
	return {
		connect: () => [],
		disconnect: () => [],
		receive: async () => [],
		receiveBinary: async () => [],
		sweep: () => [],
		nextDeadlineMs: () => undefined,
		shutdown: () => [],
		finalizeShutdown: () => undefined
	} as unknown as ArenaApplication;
}

function startHttpCorpus(environment: Record<string, string | undefined> = {}): ArenaServerHandle {
	return startArenaServer({
		application: fakeApplication(),
		config: loadArenaConfig({ HOST: '127.0.0.1', ...environment }),
		portOverride: 0,
		maintenanceIntervalMs: 60_000
	});
}

describe('Phase 4 deterministic malformed and privacy corpus', () => {
	test('keeps the exact HTTP surface and private metrics closed under malformed requests', async () => {
		handle = startHttpCorpus({
			METRICS_ENABLED: 'true',
			METRICS_BEARER_TOKEN: 'phase4-malformed-metrics-token-1234567890'
		});
		const origin = `http://127.0.0.1:${handle.port}`;
		for (const [path, init, status] of [
			['/missing', {}, 404],
			['/ws', { method: 'POST' }, 405],
			['/ws?ticket=SENTINEL-URL-SECRET', {}, 400],
			['/metrics?token=SENTINEL-METRIC-SECRET', {}, 404],
			['/metrics', { headers: { Authorization: 'Bearer SENTINEL-WRONG-TOKEN' } }, 401]
		] as const) {
			const response = await fetch(`${origin}${path}`, init);
			expect(response.status).toBe(status);
			expect(await response.text()).not.toContain('SENTINEL');
		}
		expect((await fetch(`${origin}/healthz`)).status).toBe(200);
	});

	test('falls back to one direct-peer bucket for oversized, overlong, or invalid forwarding chains', async () => {
		for (const forwarded of [
			`${'198.51.100.1'.padEnd(512, ' ')} `,
			Array.from({ length: 9 }, (_, index) => `198.51.100.${index + 1}`).join(','),
			'198.51.100.1,,10.0.0.1',
			'198.51.100.1:443',
			'fe80::1%eth0',
			'SENTINEL-FORWARDED-HOST'
		]) {
			handle = startHttpCorpus({
				TRUSTED_PROXY_CIDRS: '127.0.0.0/8',
				UPGRADE_ATTEMPTS_PER_ADDRESS_PER_MINUTE: '1'
			});
			const request = () =>
				fetch(`http://127.0.0.1:${handle!.port}/ws`, {
					headers: { 'X-Forwarded-For': forwarded }
				});
			expect((await request()).status).toBe(426);
			expect((await request()).status).toBe(429);
			await handle.shutdown({ drainMs: 0 });
			handle = undefined;
		}

		handle = startHttpCorpus({
			TRUSTED_PROXY_CIDRS: '127.0.0.0/8',
			UPGRADE_ATTEMPTS_PER_ADDRESS_PER_MINUTE: '1'
		});
		const exact512 = '198.51.100.1'.padEnd(512, ' ');
		expect(
			(
				await fetch(`http://127.0.0.1:${handle.port}/ws`, {
					headers: { 'X-Forwarded-For': exact512 }
				})
			).status
		).toBe(426);
		expect(
			(
				await fetch(`http://127.0.0.1:${handle.port}/ws`, {
					headers: { 'X-Forwarded-For': '198.51.100.2' }
				})
			).status
		).toBe(426);
	});

	test('rejects malformed and oversized JSON while a canonical control hello remains valid', () => {
		const control = JSON.stringify({
			type: 'client_hello',
			data: {
				protocolMajor: 1,
				protocolMinor: 0,
				clientVersion: 'phase4-control',
				capabilities: ['rooms-v1']
			}
		});
		expect(decodeClientMessage(control).type).toBe('client_hello');
		for (const malformed of [
			'',
			'{',
			'null',
			'[]',
			'{"type":"client_hello","data":{},"SENTINEL-EXTRA":true}',
			`${control}${' '.repeat(65_537 - Buffer.byteLength(control, 'utf8'))}`
		]) {
			try {
				decodeClientMessage(malformed);
				expect.unreachable('malformed text accepted');
			} catch (error) {
				expect(error).toBeInstanceOf(ProtocolError);
				expect(['malformed_message', 'frame_too_large']).toContain((error as ProtocolError).code);
				expect(String(error)).not.toContain('SENTINEL');
			}
		}
		expect(decodeClientMessage(control).type).toBe('client_hello');
	});

	test('rejects every structural RGA1 field mutation without corrupting the control frame', () => {
		const hashes = packedHashes(1);
		const control = encodeHashChunk({
			kind: 1,
			transferId: new Uint8Array(16).fill(7),
			chunkIndex: 3,
			hashes
		});
		const mutations: Uint8Array[] = [
			control.subarray(0, BINARY_HEADER_BYTES - 1),
			mutate(control, 0, 0),
			mutate(control, 4, 2),
			mutate(control, 5, 0),
			mutate(control, 6, 1),
			mutate(control, 7, 1),
			control.subarray(0, control.byteLength - 1),
			new Uint8Array(MAX_BINARY_FRAME_BYTES + 1)
		];
		const impossibleCount = control.slice();
		new DataView(impossibleCount.buffer).setUint32(28, MAX_HASHES_PER_CHUNK + 1, false);
		mutations.push(impossibleCount);
		for (const malformed of mutations) {
			expect(() => decodeHashChunk(malformed)).toThrow(ProtocolError);
		}
		expect(decodeHashChunk(control)).toMatchObject({ kind: 1, chunkIndex: 3, hashes });
	});

	test('contains transfer order, digest, count, and budget failures without changing a control upload', () => {
		const bytes = packedHashes(1);
		const declared = declaration(bytes);
		const control = new InventoryUploadManager({
			newTransferId: () => new Uint8Array(16).fill(1)
		});
		const controlBegin = control.begin('control', 'control-user', declared, 0);
		if (!controlBegin.ok) throw new Error('control begin failed');
		expect(
			control.append(
				'control',
				encodeHashChunk({
					kind: 1,
					transferId: controlBegin.rawUploadId,
					chunkIndex: 0,
					hashes: bytes
				}),
				1
			)
		).toMatchObject({ ok: true });

		const outOfOrder = new InventoryUploadManager({
			newTransferId: () => new Uint8Array(16).fill(2)
		});
		const attackBegin = outOfOrder.begin('attack', 'attack-user', declared, 0);
		if (!attackBegin.ok) throw new Error('attack begin failed');
		expect(
			outOfOrder.append(
				'attack',
				encodeHashChunk({
					kind: 1,
					transferId: attackBegin.rawUploadId,
					chunkIndex: 1,
					hashes: bytes
				}),
				1
			)
		).toEqual({ ok: false, code: 'malformed_inventory' });

		const badDigest = new InventoryUploadManager({
			newTransferId: () => new Uint8Array(16).fill(3)
		});
		const digestDeclaration = { ...declared, vectorDigest: '00'.repeat(32) };
		const digestBegin = badDigest.begin('digest', 'digest-user', digestDeclaration, 0);
		if (!digestBegin.ok) throw new Error('digest begin failed');
		badDigest.append(
			'digest',
			encodeHashChunk({
				kind: 1,
				transferId: digestBegin.rawUploadId,
				chunkIndex: 0,
				hashes: bytes
			}),
			1
		);
		expect(badDigest.commit('digest', digestBegin.uploadId, digestDeclaration, 2)).toEqual({
			ok: false,
			code: 'inventory_invalid'
		});

		const bounded = new InventoryUploadManager({ maxPendingBytes: 31 });
		expect(bounded.begin('bounded', 'bounded-user', declared, 0)).toEqual({
			ok: false,
			code: 'inventory_capacity_exceeded'
		});
		expect(control.commit('control', controlBegin.uploadId, declared, 2)).toMatchObject({
			ok: true
		});
		expect(control.committedBytes).toBe(32);
	});

	test('drops only ephemeral slow-reader traffic and keeps metric text free of sentinels', () => {
		expect(classifySocketDelivery(true, false, BACKPRESSURE_LIMIT_BYTES, 1)).toBe('drop');
		expect(classifySocketDelivery(false, false, BACKPRESSURE_LIMIT_BYTES, 1)).toBe('close');
		const metrics = createOperationalMetrics();
		metrics.commandRejected('SENTINEL-DYNAMIC-CODE' as never);
		metrics.authFailure('SENTINEL-DYNAMIC-AUTH' as never);
		const rendered = metrics.renderPrometheus();
		expect(rendered).toContain('arena_command_rejections_total{code="other"} 1');
		expect(rendered).toContain('arena_auth_failures_total{reason="other"} 1');
		expect(rendered).not.toContain('SENTINEL');
	});
});

function mutate(source: Uint8Array, index: number, value: number): Uint8Array {
	const copy = source.slice();
	copy[index] = value;
	return copy;
}

function packedHashes(count: number): Uint8Array {
	const bytes = new Uint8Array(count * 32);
	for (let index = 0; index < count; index += 1) {
		new DataView(bytes.buffer, index * 32, 32).setUint32(28, index + 1, false);
	}
	return bytes;
}

function declaration(bytes: Uint8Array): InventoryDeclaration {
	return {
		libraryGeneration: 1,
		hashCount: bytes.byteLength / 32,
		byteCount: bytes.byteLength,
		chunkCount: 1,
		vectorDigest: createHash('sha256').update(bytes).digest('hex')
	};
}
