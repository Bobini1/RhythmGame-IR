import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';

import { InventoryUploadManager } from '../../src/inventory/inventory-upload-manager.ts';
import { createOperationalMetrics } from '../../src/observability/operational-metrics.ts';
import { encodeHashChunk, MAX_HASHES_PER_CHUNK } from '../../src/protocol/binary.ts';
import type { InventoryDeclaration } from '../../src/protocol/messages.ts';

function packedHashes(count: number, start = 1): Uint8Array {
	const bytes = new Uint8Array(count * 32);
	for (let index = 0; index < count; ++index) {
		new DataView(bytes.buffer, index * 32, 32).setUint32(28, start + index, false);
	}
	return bytes;
}

function declaration(bytes: Uint8Array, libraryGeneration = 1): InventoryDeclaration {
	const hashCount = bytes.byteLength / 32;
	return {
		libraryGeneration,
		hashCount,
		byteCount: bytes.byteLength,
		chunkCount: Math.ceil(hashCount / MAX_HASHES_PER_CHUNK),
		vectorDigest: createHash('sha256').update(bytes).digest('hex')
	};
}

function deterministicIds(): () => Uint8Array {
	let value = 1;
	return () => new Uint8Array(16).fill(value++);
}

function begin(
	manager: InventoryUploadManager,
	connectionId: string,
	bytes: Uint8Array,
	nowMs = 0,
	identityId = connectionId,
	libraryGeneration = 1
) {
	const declared = declaration(bytes, libraryGeneration);
	const result = manager.begin(connectionId, identityId, declared, nowMs);
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error('Expected upload begin success.');
	return { ...result, declared };
}

describe('InventoryUploadManager', () => {
	test('commits an empty inventory without binary chunks', () => {
		const manager = new InventoryUploadManager({ newTransferId: deterministicIds() });
		const bytes = new Uint8Array();
		const started = begin(manager, 'c1', bytes);
		const committed = manager.commit('c1', started.uploadId, started.declared, 1);
		expect(committed.ok).toBe(true);
		if (!committed.ok) return;
		expect(committed.inventory.count).toBe(0);
		expect(committed.inventory.copyBytes()).toEqual(bytes);
		expect(manager.pendingReservedBytes).toBe(0);
		expect(manager.committedBytes).toBe(0);
	});

	test('validates ordering across chunks and commits one immutable packed inventory', () => {
		const metrics = createOperationalMetrics();
		const manager = new InventoryUploadManager({
			newTransferId: deterministicIds(),
			operationalMetrics: metrics
		});
		const bytes = packedHashes(MAX_HASHES_PER_CHUNK + 1);
		const started = begin(manager, 'c1', bytes);
		const first = bytes.slice(0, MAX_HASHES_PER_CHUNK * 32);
		const second = bytes.slice(MAX_HASHES_PER_CHUNK * 32);
		expect(
			manager.append(
				'c1',
				encodeHashChunk({ kind: 1, transferId: started.rawUploadId, chunkIndex: 0, hashes: first }),
				1
			)
		).toEqual({ ok: true, receivedChunks: 1, receivedHashes: MAX_HASHES_PER_CHUNK });
		expect(
			manager.append(
				'c1',
				encodeHashChunk({
					kind: 1,
					transferId: started.rawUploadId,
					chunkIndex: 1,
					hashes: second
				}),
				2
			)
		).toEqual({ ok: true, receivedChunks: 2, receivedHashes: MAX_HASHES_PER_CHUNK + 1 });

		const committed = manager.commit('c1', started.uploadId, started.declared, 3);
		expect(committed.ok).toBe(true);
		if (!committed.ok) return;
		expect(committed.inventory.copyBytes()).toEqual(bytes);
		expect(manager.committedBytes).toBe(bytes.byteLength);
		expect(metrics.renderPrometheus()).toContain(
			`arena_inventory_committed_bytes ${bytes.byteLength}\n`
		);
		expect(metrics.renderPrometheus()).toContain('arena_inventory_upload_seconds_count 1\n');
		const copy = committed.inventory.copyBytes();
		copy.fill(0);
		expect(committed.inventory.copyBytes()).toEqual(bytes);
		manager.releaseCommitted(committed.inventory);
		expect(manager.committedBytes).toBe(0);
		expect(metrics.renderPrometheus()).toContain('arena_inventory_committed_bytes 0\n');
	});

	test('rejects wrong kind, transfer, index, empty chunks, duplicates, and declaration mismatch', () => {
		const bytes = packedHashes(2);
		const invalidFrames: Array<(started: ReturnType<typeof begin>) => Uint8Array> = [
			(started) =>
				encodeHashChunk({ kind: 2, transferId: started.rawUploadId, chunkIndex: 0, hashes: bytes }),
			() =>
				encodeHashChunk({
					kind: 1,
					transferId: new Uint8Array(16).fill(99),
					chunkIndex: 0,
					hashes: bytes
				}),
			(started) =>
				encodeHashChunk({ kind: 1, transferId: started.rawUploadId, chunkIndex: 1, hashes: bytes }),
			(started) =>
				encodeHashChunk({
					kind: 1,
					transferId: started.rawUploadId,
					chunkIndex: 0,
					hashes: new Uint8Array()
				}),
			(started) =>
				encodeHashChunk({
					kind: 1,
					transferId: started.rawUploadId,
					chunkIndex: 0,
					hashes: Uint8Array.from([...bytes.slice(0, 32), ...bytes.slice(0, 32)])
				})
		];
		for (const frame of invalidFrames) {
			const manager = new InventoryUploadManager({ newTransferId: deterministicIds() });
			const started = begin(manager, 'c1', bytes);
			expect(manager.append('c1', frame(started), 1)).toEqual({
				ok: false,
				code: 'malformed_inventory'
			});
			expect(manager.pendingReservedBytes).toBe(0);
		}

		const manager = new InventoryUploadManager({ newTransferId: deterministicIds() });
		const started = begin(manager, 'c1', bytes);
		expect(
			manager.append(
				'c1',
				encodeHashChunk({ kind: 1, transferId: started.rawUploadId, chunkIndex: 0, hashes: bytes }),
				1
			)
		).toEqual({ ok: true, receivedChunks: 1, receivedHashes: 2 });
		expect(
			manager.commit(
				'c1',
				started.uploadId,
				{ ...started.declared, vectorDigest: '00'.repeat(32) },
				2
			)
		).toEqual({ ok: false, code: 'inventory_invalid' });
	});

	test('supersedes, aborts, disconnects, and expires at the exact 60-second boundary', () => {
		const manager = new InventoryUploadManager({ newTransferId: deterministicIds() });
		const first = begin(manager, 'c1', packedHashes(1), 0, 'alice', 1);
		const second = begin(manager, 'c1', packedHashes(2), 1, 'alice', 2);
		expect(first.uploadId).not.toBe(second.uploadId);
		expect(manager.commit('c1', first.uploadId, first.declared, 2)).toEqual({
			ok: false,
			code: 'inventory_stale'
		});
		expect(manager.abort('c1', second.uploadId)).toBe(true);
		expect(manager.pendingReservedBytes).toBe(0);

		begin(manager, 'c2', packedHashes(1), 10);
		manager.abortConnection('c2');
		expect(manager.pendingReservedBytes).toBe(0);

		const expiring = begin(manager, 'c3', packedHashes(1), 100);
		expect(manager.sweep(60_099)).toEqual([]);
		expect(manager.sweep(60_100)).toEqual([
			{ connectionId: 'c3', uploadId: expiring.uploadId, libraryGeneration: 1 }
		]);
		expect(manager.pendingReservedBytes).toBe(0);
	});

	test('enforces six accepted begins per identity per minute', () => {
		const manager = new InventoryUploadManager({ newTransferId: deterministicIds() });
		for (let index = 0; index < 6; ++index) {
			expect(manager.begin(`c${index}`, 'alice', declaration(new Uint8Array()), index).ok).toBe(
				true
			);
		}
		expect(manager.begin('c6', 'alice', declaration(new Uint8Array()), 5).ok).toBe(false);
		expect(manager.begin('c7', 'alice', declaration(new Uint8Array()), 60_000).ok).toBe(true);
	});

	test('enforces pending and committed process budgets without allocating declarations', () => {
		const manager = new InventoryUploadManager({
			newTransferId: deterministicIds(),
			maxPendingBytes: 64,
			maxCommittedBytes: 64
		});
		const firstBytes = packedHashes(2);
		const first = begin(manager, 'c1', firstBytes);
		expect(manager.begin('c2', 'bob', declaration(packedHashes(1)), 0)).toEqual({
			ok: false,
			code: 'inventory_capacity_exceeded'
		});
		manager.append(
			'c1',
			encodeHashChunk({
				kind: 1,
				transferId: first.rawUploadId,
				chunkIndex: 0,
				hashes: firstBytes
			}),
			1
		);
		const committed = manager.commit('c1', first.uploadId, first.declared, 2);
		expect(committed.ok).toBe(true);
		const next = begin(manager, 'c2', packedHashes(1), 3);
		manager.append(
			'c2',
			encodeHashChunk({
				kind: 1,
				transferId: next.rawUploadId,
				chunkIndex: 0,
				hashes: packedHashes(1)
			}),
			4
		);
		expect(manager.commit('c2', next.uploadId, next.declared, 5)).toEqual({
			ok: false,
			code: 'inventory_capacity_exceeded'
		});
	});
});
