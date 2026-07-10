import { describe, expect, test } from 'bun:test';

import { loadArenaConfig } from '../../src/config.ts';

describe('loadArenaConfig', () => {
	test('uses the production process and competition defaults', () => {
		const config = loadArenaConfig({});

		expect(config).toEqual({
			host: '0.0.0.0',
			port: 3001,
			irJwksUrl: new URL('https://rhythmgame.eu/api/auth/jwks'),
			irIssuer: 'https://rhythmgame.eu',
			arenaAudience: 'https://arena.rhythmgame.eu',
			reconnectGraceMs: 60_000,
			roomCapacity: 16,
			chatBacklog: 200,
			inventoryUploadTimeoutMs: 60_000,
			maxPendingInventoryBytes: 128 * 1024 * 1024,
			maxCommittedInventoryBytes: 512 * 1024 * 1024,
			maxRooms: 1_000,
			maxConnections: 5_000,
			telemetryIntervalMs: 200,
			trustedProxyCidrs: [],
			upgradeAttemptsPerAddressPerMinute: 120,
			maxConnectionsPerAddress: 20,
			clientHelloTimeoutMs: 10_000,
			maxTrackedAddresses: 20_000
		});
	});

	test('coerces validated environment strings', () => {
		const config = loadArenaConfig({
			HOST: '127.0.0.1',
			PORT: '4100',
			IR_JWKS_URL: 'http://127.0.0.1:5173/api/auth/jwks',
			IR_ISSUER: 'http://127.0.0.1:5173',
			ARENA_AUDIENCE: 'http://127.0.0.1:3001',
			RECONNECT_GRACE_MS: '90000',
			ROOM_CAPACITY: '16',
			CHAT_BACKLOG: '300',
			INVENTORY_UPLOAD_TIMEOUT_MS: '45000',
			MAX_PENDING_INVENTORY_BYTES: '67108864',
			MAX_COMMITTED_INVENTORY_BYTES: '268435456',
			MAX_ROOMS: '750',
			MAX_CONNECTIONS: '4000',
			TELEMETRY_INTERVAL_MS: '200',
			TRUSTED_PROXY_CIDRS: '10.1.2.3/8,2001:0db8::/32',
			UPGRADE_ATTEMPTS_PER_ADDRESS_PER_MINUTE: '240',
			MAX_CONNECTIONS_PER_ADDRESS: '12',
			CLIENT_HELLO_TIMEOUT_MS: '15000',
			MAX_TRACKED_ADDRESSES: '10000'
		});

		expect(config.port).toBe(4100);
		expect(config.reconnectGraceMs).toBe(90_000);
		expect(config.chatBacklog).toBe(300);
		expect(config.inventoryUploadTimeoutMs).toBe(45_000);
		expect(config.maxPendingInventoryBytes).toBe(64 * 1024 * 1024);
		expect(config.maxCommittedInventoryBytes).toBe(256 * 1024 * 1024);
		expect(config.maxRooms).toBe(750);
		expect(config.maxConnections).toBe(4_000);
		expect(config.telemetryIntervalMs).toBe(200);
		expect(config.trustedProxyCidrs).toEqual(['10.0.0.0/8', '2001:db8::/32']);
		expect(config.upgradeAttemptsPerAddressPerMinute).toBe(240);
		expect(config.maxConnectionsPerAddress).toBe(12);
		expect(config.clientHelloTimeoutMs).toBe(15_000);
		expect(config.maxTrackedAddresses).toBe(10_000);
	});

	test('rejects malformed, duplicate, or globally broad trusted proxy networks', () => {
		for (const value of [
			'not-a-network',
			'0.0.0.0/0',
			'::/0',
			'10.0.0.0/8,10.2.3.4/8',
			'10.0.0.0/8,',
			'203.0.113.7/SECRET'
		]) {
			try {
				loadArenaConfig({ TRUSTED_PROXY_CIDRS: value });
				throw new Error('expected rejection');
			} catch (error) {
				expect(String(error)).not.toContain(value);
			}
		}
	});

	test('rejects unsafe address admission capacities', () => {
		for (const environment of [
			{ UPGRADE_ATTEMPTS_PER_ADDRESS_PER_MINUTE: '0' },
			{ MAX_CONNECTIONS_PER_ADDRESS: '0' },
			{ CLIENT_HELLO_TIMEOUT_MS: '999' },
			{ MAX_TRACKED_ADDRESSES: '0' }
		]) {
			expect(() => loadArenaConfig(environment)).toThrow();
		}
	});

	test('rejects unsafe process capacities and a noncanonical telemetry interval', () => {
		for (const environment of [
			{ MAX_ROOMS: '0' },
			{ MAX_CONNECTIONS: '0' },
			{ TELEMETRY_INTERVAL_MS: '199' },
			{ TELEMETRY_INTERVAL_MS: '201' }
		]) {
			expect(() => loadArenaConfig(environment)).toThrow();
		}
	});

	test.each(['0', '-1', '65536', '3001.5'])('rejects an invalid port value %s', (port) => {
		expect(() => loadArenaConfig({ PORT: port })).toThrow();
	});

	test.each(['   ', 'h'.repeat(254)])('rejects an invalid host value', (host) => {
		expect(() => loadArenaConfig({ HOST: host })).toThrow();
	});

	test('rejects a room capacity other than the Phase 1 fixed capacity', () => {
		expect(() => loadArenaConfig({ ROOM_CAPACITY: '15' })).toThrow();
		expect(() => loadArenaConfig({ ROOM_CAPACITY: '17' })).toThrow();
	});

	test.each(['9999', '300001'])(
		'rejects reconnect grace outside the ten-second to five-minute safety window',
		(reconnectGraceMs) => {
			expect(() => loadArenaConfig({ RECONNECT_GRACE_MS: reconnectGraceMs })).toThrow();
		}
	);

	test.each(['file:///run/secrets/jwks.json', 'ftp://example.test/jwks', 'not-a-url'])(
		'rejects a non-HTTP JWKS URL %s',
		(irJwksUrl) => {
			expect(() => loadArenaConfig({ IR_JWKS_URL: irJwksUrl })).toThrow();
		}
	);

	test('rejects insecure remote JWKS while allowing explicit loopback HTTP', () => {
		expect(() =>
			loadArenaConfig({ IR_JWKS_URL: 'http://identity.example.test/api/auth/jwks' })
		).toThrow();
		expect(
			loadArenaConfig({ IR_JWKS_URL: 'http://localhost:5173/api/auth/jwks' }).irJwksUrl
		).toEqual(new URL('http://localhost:5173/api/auth/jwks'));
	});

	test.each(['IR_ISSUER', 'ARENA_AUDIENCE'] as const)(
		'rejects malformed, non-HTTP, and remote plain HTTP values for %s',
		(variable) => {
			for (const value of [
				'not-a-url',
				'file:///run/arena-identity',
				'ftp://identity.example.test',
				'http://identity.example.test'
			]) {
				expect(() => loadArenaConfig({ [variable]: value })).toThrow();
			}

			expect(loadArenaConfig({ [variable]: 'http://127.0.0.1:5173' })).toBeDefined();
		}
	);

	test.each(['0', '1001'])(
		'rejects a chat backlog outside the bounded in-memory range',
		(chatBacklog) => {
			expect(() => loadArenaConfig({ CHAT_BACKLOG: chatBacklog })).toThrow();
		}
	);

	test('rejects unsafe inventory timeout and process budgets', () => {
		for (const environment of [
			{ INVENTORY_UPLOAD_TIMEOUT_MS: '999' },
			{ INVENTORY_UPLOAD_TIMEOUT_MS: '300001' },
			{ MAX_PENDING_INVENTORY_BYTES: '0' },
			{ MAX_PENDING_INVENTORY_BYTES: '536870913' },
			{ MAX_COMMITTED_INVENTORY_BYTES: '0' },
			{ MAX_COMMITTED_INVENTORY_BYTES: '2147483649' }
		]) {
			expect(() => loadArenaConfig(environment)).toThrow();
		}
	});
});
