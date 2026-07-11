import { afterEach, describe, expect, test } from 'bun:test';

import { ArenaApplication } from '../../src/application/arena-application.ts';
import type { TicketVerifier } from '../../src/auth/ticket-verifier.ts';
import { loadArenaConfig } from '../../src/config.ts';
import { createRoomDirectory } from '../../src/rooms/room-directory.ts';
import { startArenaServer, type ArenaServerHandle } from '../../src/transport/start-server.ts';
import { FakePasswordHasher } from '../helpers/fake-password-hasher.ts';

let handle: ArenaServerHandle | undefined;

afterEach(async () => {
	await handle?.shutdown({ drainMs: 0 });
	handle = undefined;
});

function startHealthServer(
	verifier: TicketVerifier,
	overrides: Readonly<{
		now?: () => number;
		peerUpgradePolicy?: Readonly<{ maxAttempts: number; windowMs: number }>;
	}> = {}
): ArenaServerHandle {
	const application = new ArenaApplication({
		ticketVerifier: verifier,
		roomDirectory: createRoomDirectory(
			{ roomCapacity: 16, reconnectGraceMs: 60_000, chatBacklog: 200 },
			new FakePasswordHasher()
		),
		now: Date.now,
		newNonce: () => crypto.randomUUID()
	});
	return startArenaServer({
		application,
		config: loadArenaConfig({ HOST: '127.0.0.1' }),
		portOverride: 0,
		maintenanceIntervalMs: 60_000,
		...overrides
	});
}

describe('Arena HTTP surface', () => {
	test('arms one exact room-deadline sweep independently of coarse maintenance', async () => {
		let deadlineMs = Date.now() + 40;
		const expectedDeadlineMs = deadlineMs;
		let sweptAtMs: number | undefined;
		let resolveSweep!: () => void;
		const swept = new Promise<void>((resolve) => {
			resolveSweep = resolve;
		});
		const application = {
			connect: () => [],
			disconnect: () => [],
			receive: async () => [],
			receiveBinary: async () => [],
			sweep: (nowMs: number) => {
				sweptAtMs = nowMs;
				deadlineMs = Number.NaN;
				resolveSweep();
				return [];
			},
			nextDeadlineMs: () => (Number.isNaN(deadlineMs) ? undefined : deadlineMs),
			shutdown: () => []
		} as unknown as ArenaApplication;
		handle = startArenaServer({
			application,
			config: loadArenaConfig({ HOST: '127.0.0.1' }),
			portOverride: 0,
			maintenanceIntervalMs: 60_000
		});
		await Promise.race([
			swept,
			Bun.sleep(2_000).then(() => {
				throw new Error('deadline sweep timed out');
			})
		]);
		expect(sweptAtMs).toBeGreaterThanOrEqual(expectedDeadlineMs);
		expect(sweptAtMs).toBeDefined();
	});

	test('serves process health without consulting ticket verification', async () => {
		let verificationCalls = 0;
		handle = startHealthServer({
			async verify() {
				verificationCalls += 1;
				throw new Error('sentinel verifier outage');
			}
		});
		const response = await fetch(`http://127.0.0.1:${handle.port}/healthz`);

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.json()).toEqual({
			status: 'ok',
			protocolMajor: 1,
			protocolMinor: 2
		});
		expect(verificationCalls).toBe(0);
	});

	test.each([
		['wrong path', '/missing', { method: 'GET' }, 404, null],
		['wrong method', '/ws', { method: 'POST' }, 405, 'GET'],
		['missing upgrade', '/ws', { method: 'GET' }, 426, null],
		['query credentials', '/ws?ticket=sentinel', { method: 'GET' }, 400, null]
	] as const)('returns the exact status for %s', async (_label, path, init, status, allow) => {
		handle = startHealthServer({
			async verify() {
				throw new Error('not used');
			}
		});
		const response = await fetch(`http://127.0.0.1:${handle.port}${path}`, init);
		expect(response.status).toBe(status);
		expect(response.headers.get('allow')).toBe(allow);
	});

	test('expires direct-peer upgrade limits and ignores untrusted forwarded addresses', async () => {
		let nowMs = 1_000;
		handle = startHealthServer(
			{
				async verify() {
					throw new Error('not used');
				}
			},
			{
				now: () => nowMs,
				peerUpgradePolicy: { maxAttempts: 2, windowMs: 60_000 }
			}
		);
		const request = (forwardedFor: string) =>
			fetch(`http://127.0.0.1:${handle!.port}/ws`, {
				headers: { 'X-Forwarded-For': forwardedFor }
			});
		expect((await request('198.51.100.1')).status).toBe(426);
		expect((await request('198.51.100.2')).status).toBe(426);
		const limited = await request('198.51.100.3');
		expect(limited.status).toBe(429);
		expect(limited.headers.get('retry-after')).toBe('60');

		nowMs += 60_000;
		expect((await request('198.51.100.4')).status).toBe(426);
	});
});
