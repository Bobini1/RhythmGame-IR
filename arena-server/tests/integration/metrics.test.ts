import { afterEach, describe, expect, test } from 'bun:test';

import { ArenaApplication } from '../../src/application/arena-application.ts';
import type { VerifiedArenaTicket } from '../../src/auth/identity.ts';
import { TicketVerificationError } from '../../src/auth/ticket-verifier.ts';
import { loadArenaConfig } from '../../src/config.ts';
import { createOperationalMetrics } from '../../src/observability/operational-metrics.ts';
import type { ClientMessage } from '../../src/protocol/messages.ts';
import { createRoomDirectory } from '../../src/rooms/room-directory.ts';
import {
	constantTimeBearerTokenMatches,
	startArenaServer,
	type ArenaServerHandle
} from '../../src/transport/start-server.ts';
import { FakePasswordHasher } from '../helpers/fake-password-hasher.ts';

const token = 'phase4-metrics-token-abcdefghijklmnopqrstuvwxyz';
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
		shutdown: () => []
	} as unknown as ArenaApplication;
}

function startMetricsServer(
	environment: Record<string, string | undefined> = {},
	logger?: (...args: unknown[]) => void
): ArenaServerHandle {
	const metrics = createOperationalMetrics();
	metrics.setRooms(4);
	return startArenaServer({
		application: fakeApplication(),
		config: loadArenaConfig({ HOST: '127.0.0.1', ...environment }),
		operationalMetrics: metrics,
		portOverride: 0,
		maintenanceIntervalMs: 60_000,
		...(logger === undefined ? {} : { logger })
	});
}

describe('Arena operational metrics HTTP surface', () => {
	test('returns 404 when metrics are disabled', async () => {
		handle = startMetricsServer();
		expect((await fetch(`http://127.0.0.1:${handle.port}/metrics`)).status).toBe(404);
	});

	test('requires exact GET and a correct bearer token without logging credentials', async () => {
		const captured: unknown[] = [];
		handle = startMetricsServer(
			{ METRICS_ENABLED: 'true', METRICS_BEARER_TOKEN: token },
			(...args) => captured.push(args)
		);
		const origin = `http://127.0.0.1:${handle.port}`;
		for (const authorization of [undefined, 'Basic sentinel', 'Bearer wrong-token']) {
			const response = await fetch(`${origin}/metrics`, {
				headers: authorization === undefined ? {} : { Authorization: authorization }
			});
			expect(response.status).toBe(401);
			expect(response.headers.get('cache-control')).toBe('no-store');
			expect(await response.text()).toBe('');
		}
		expect(
			(
				await fetch(`${origin}/metrics`, {
					method: 'POST',
					headers: { Authorization: `Bearer ${token}` }
				})
			).status
		).toBe(404);
		expect(
			(
				await fetch(`${origin}/metrics?sentinel=1`, {
					headers: { Authorization: `Bearer ${token}` }
				})
			).status
		).toBe(404);

		const response = await fetch(`${origin}/metrics`, {
			headers: { Authorization: `Bearer ${token}` }
		});
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
		const rendered = await response.text();
		expect(rendered).toContain('arena_rooms_current 4\n');
		expect(rendered).not.toContain(token);
		expect(JSON.stringify(captured)).not.toContain(token);
		expect(JSON.stringify(captured)).not.toContain('wrong-token');
	});

	test('compares only an exact bearer value and handles unequal byte lengths safely', () => {
		expect(constantTimeBearerTokenMatches(`Bearer ${token}`, token)).toBe(true);
		expect(constantTimeBearerTokenMatches(`bearer ${token}`, token)).toBe(false);
		expect(constantTimeBearerTokenMatches(`Bearer ${token} `, token)).toBe(false);
		expect(constantTimeBearerTokenMatches('Bearer short', token)).toBe(false);
		expect(constantTimeBearerTokenMatches(null, token)).toBe(false);
	});

	test('instruments application transitions with aggregates and closed reasons only', async () => {
		const metrics = createOperationalMetrics();
		const directory = createRoomDirectory(
			{ roomCapacity: 32, reconnectGraceMs: 60_000, chatBacklog: 200 },
			new FakePasswordHasher()
		);
		const application = new ArenaApplication({
			ticketVerifier: {
				async verify(ticket, now): Promise<VerifiedArenaTicket> {
					if (ticket === 'replayed') throw new TicketVerificationError('ticket_replayed');
					return {
						identity: { userId: 'metric-user', displayName: 'Metric User', avatarUrl: null },
						emailVerified: true,
						jti: 'metric-jti',
						issuedAt: new Date(now.getTime() - 1_000),
						expiresAt: new Date(now.getTime() + 60_000),
						protocolMajor: 1,
						protocolMinor: 0
					};
				}
			},
			roomDirectory: directory,
			now: () => 1_000,
			newNonce: () => 'metric-nonce',
			operationalMetrics: metrics
		});
		application.connect('valid');
		await application.receive('valid', authenticatedHello('valid'), 1_000);
		await application.receive(
			'valid',
			{ type: 'room_create', requestId: 'create', data: { name: 'SENTINEL-PRIVATE-ROOM' } },
			1_001
		);
		await application.receive(
			'valid',
			{ type: 'room_create', requestId: 'reject', data: { name: 'Ignored' } },
			1_002
		);
		application.disconnect('valid', 1_003);
		application.connect('invalid');
		await application.receive('invalid', authenticatedHello('replayed'), 1_004);

		let rendered = metrics.renderPrometheus();
		expect(rendered).toContain('arena_rooms_current 1\n');
		expect(rendered).toContain('arena_reserved_seats_current 1\n');
		expect(rendered).toContain('arena_command_rejections_total{code="already_in_room"} 1\n');
		expect(rendered).toContain('arena_auth_failures_total{reason="ticket_replayed"} 1\n');
		expect(rendered).not.toContain('metric-user');
		expect(rendered).not.toContain('SENTINEL-PRIVATE-ROOM');

		application.finalizeShutdown();
		rendered = metrics.renderPrometheus();
		expect(rendered).toContain('arena_rooms_current 0\n');
		expect(rendered).toContain('arena_reserved_seats_current 0\n');
	});
});

function authenticatedHello(ticket: string): ClientMessage {
	return {
		type: 'client_hello' as const,
		data: {
			protocolMajor: 1 as const,
			protocolMinor: 0 as const,
			clientVersion: 'metrics-test',
			capabilities: ['rooms-v1', 'rounds-v1', 'competition-v1'],
			ticket
		}
	};
}
