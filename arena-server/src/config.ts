import { z } from 'zod';

import { parseTrustedProxyCidrs } from './transport/client-address.ts';

export const DEFAULT_ARENA_PORT = 3001;
export const FIXED_ROOM_CAPACITY = 16;
export const MIN_RECONNECT_GRACE_MS = 10_000;
export const MAX_RECONNECT_GRACE_MS = 5 * 60_000;
export const MAX_CHAT_BACKLOG = 1_000;
export const DEFAULT_INVENTORY_UPLOAD_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_PENDING_INVENTORY_BYTES = 128 * 1024 * 1024;
export const DEFAULT_MAX_COMMITTED_INVENTORY_BYTES = 512 * 1024 * 1024;
export const DEFAULT_MAX_ROOMS = 1_000;
export const DEFAULT_MAX_CONNECTIONS = 5_000;
export const DEFAULT_TELEMETRY_INTERVAL_MS = 200;
export const DEFAULT_UPGRADE_ATTEMPTS_PER_ADDRESS_PER_MINUTE = 120;
export const DEFAULT_MAX_CONNECTIONS_PER_ADDRESS = 20;
export const DEFAULT_CLIENT_HELLO_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_TRACKED_ADDRESSES = 20_000;
export const DEFAULT_SHUTDOWN_DRAIN_MS = 8_000;

const loopbackHosts = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

const secureHttpUrl = z
	.string()
	.url()
	.refine((value) => {
		const url = new URL(value);
		return (
			url.protocol === 'https:' || (url.protocol === 'http:' && loopbackHosts.has(url.hostname))
		);
	}, 'URL must use HTTPS, except for explicit loopback HTTP');

const jwksUrl = secureHttpUrl.transform((value) => new URL(value));

const environmentSchema = z.object({
	HOST: z.string().trim().min(1).max(253).default('0.0.0.0'),
	PORT: z.coerce.number().int().min(1).max(65_535).default(DEFAULT_ARENA_PORT),
	IR_JWKS_URL: jwksUrl.default(new URL('https://rhythmgame.eu/api/auth/jwks')),
	IR_ISSUER: secureHttpUrl.default('https://rhythmgame.eu'),
	ARENA_AUDIENCE: secureHttpUrl.default('https://arena.rhythmgame.eu'),
	RECONNECT_GRACE_MS: z.coerce
		.number()
		.int()
		.min(MIN_RECONNECT_GRACE_MS)
		.max(MAX_RECONNECT_GRACE_MS)
		.default(60_000),
	ROOM_CAPACITY: z.coerce
		.number()
		.int()
		.refine((value) => value === FIXED_ROOM_CAPACITY, {
			message: `ROOM_CAPACITY must be ${FIXED_ROOM_CAPACITY} in protocol 1.0`
		})
		.default(FIXED_ROOM_CAPACITY),
	CHAT_BACKLOG: z.coerce.number().int().min(1).max(MAX_CHAT_BACKLOG).default(200),
	INVENTORY_UPLOAD_TIMEOUT_MS: z.coerce
		.number()
		.int()
		.min(1_000)
		.max(5 * 60_000)
		.default(DEFAULT_INVENTORY_UPLOAD_TIMEOUT_MS),
	MAX_PENDING_INVENTORY_BYTES: z.coerce
		.number()
		.int()
		.min(1)
		.max(512 * 1024 * 1024)
		.default(DEFAULT_MAX_PENDING_INVENTORY_BYTES),
	MAX_COMMITTED_INVENTORY_BYTES: z.coerce
		.number()
		.int()
		.min(1)
		.max(2 * 1024 * 1024 * 1024)
		.default(DEFAULT_MAX_COMMITTED_INVENTORY_BYTES),
	MAX_ROOMS: z.coerce.number().int().min(1).max(100_000).default(DEFAULT_MAX_ROOMS),
	MAX_CONNECTIONS: z.coerce.number().int().min(1).max(100_000).default(DEFAULT_MAX_CONNECTIONS),
	TELEMETRY_INTERVAL_MS: z.coerce
		.number()
		.int()
		.refine((value) => value === DEFAULT_TELEMETRY_INTERVAL_MS, {
			message: `TELEMETRY_INTERVAL_MS must be ${DEFAULT_TELEMETRY_INTERVAL_MS}`
		})
		.default(DEFAULT_TELEMETRY_INTERVAL_MS),
	TRUSTED_PROXY_CIDRS: z
		.string()
		.default('')
		.transform((value, context) => {
			try {
				return parseTrustedProxyCidrs(value);
			} catch {
				context.addIssue({ code: 'custom', message: 'Invalid trusted proxy CIDR configuration' });
				return z.NEVER;
			}
		}),
	UPGRADE_ATTEMPTS_PER_ADDRESS_PER_MINUTE: z.coerce
		.number()
		.int()
		.min(1)
		.max(10_000)
		.default(DEFAULT_UPGRADE_ATTEMPTS_PER_ADDRESS_PER_MINUTE),
	MAX_CONNECTIONS_PER_ADDRESS: z.coerce
		.number()
		.int()
		.min(1)
		.max(1_000)
		.default(DEFAULT_MAX_CONNECTIONS_PER_ADDRESS),
	CLIENT_HELLO_TIMEOUT_MS: z.coerce
		.number()
		.int()
		.min(1_000)
		.max(60_000)
		.default(DEFAULT_CLIENT_HELLO_TIMEOUT_MS),
	MAX_TRACKED_ADDRESSES: z.coerce
		.number()
		.int()
		.min(1)
		.max(1_000_000)
		.default(DEFAULT_MAX_TRACKED_ADDRESSES),
	METRICS_ENABLED: z
		.enum(['true', 'false'])
		.default('false')
		.transform((value) => value === 'true'),
	METRICS_BEARER_TOKEN: z.string().max(1_024).default(''),
	SHUTDOWN_DRAIN_MS: z.coerce
		.number()
		.int()
		.min(1_000)
		.max(60_000)
		.default(DEFAULT_SHUTDOWN_DRAIN_MS)
});

export type ArenaConfig = Readonly<{
	host: string;
	port: number;
	irJwksUrl: URL;
	irIssuer: string;
	arenaAudience: string;
	reconnectGraceMs: number;
	roomCapacity: typeof FIXED_ROOM_CAPACITY;
	chatBacklog: number;
	inventoryUploadTimeoutMs: number;
	maxPendingInventoryBytes: number;
	maxCommittedInventoryBytes: number;
	maxRooms: number;
	maxConnections: number;
	telemetryIntervalMs: typeof DEFAULT_TELEMETRY_INTERVAL_MS;
	trustedProxyCidrs: readonly string[];
	upgradeAttemptsPerAddressPerMinute: number;
	maxConnectionsPerAddress: number;
	clientHelloTimeoutMs: number;
	maxTrackedAddresses: number;
	metricsEnabled: boolean;
	metricsBearerToken: string | null;
	shutdownDrainMs: number;
}>;

export function loadArenaConfig(
	environment: Record<string, string | undefined> = Bun.env
): ArenaConfig {
	const parsed = environmentSchema.parse(environment);
	if (
		parsed.METRICS_ENABLED &&
		(Buffer.byteLength(parsed.METRICS_BEARER_TOKEN, 'utf8') < 32 ||
			!/^[-A-Za-z0-9._~+/]+=*$/.test(parsed.METRICS_BEARER_TOKEN))
	) {
		throw new Error('METRICS_BEARER_TOKEN must be a valid bearer token of at least 32 bytes.');
	}
	return {
		host: parsed.HOST,
		port: parsed.PORT,
		irJwksUrl: parsed.IR_JWKS_URL,
		irIssuer: parsed.IR_ISSUER,
		arenaAudience: parsed.ARENA_AUDIENCE,
		reconnectGraceMs: parsed.RECONNECT_GRACE_MS,
		roomCapacity: parsed.ROOM_CAPACITY,
		chatBacklog: parsed.CHAT_BACKLOG,
		inventoryUploadTimeoutMs: parsed.INVENTORY_UPLOAD_TIMEOUT_MS,
		maxPendingInventoryBytes: parsed.MAX_PENDING_INVENTORY_BYTES,
		maxCommittedInventoryBytes: parsed.MAX_COMMITTED_INVENTORY_BYTES,
		maxRooms: parsed.MAX_ROOMS,
		maxConnections: parsed.MAX_CONNECTIONS,
		telemetryIntervalMs: parsed.TELEMETRY_INTERVAL_MS,
		trustedProxyCidrs: parsed.TRUSTED_PROXY_CIDRS,
		upgradeAttemptsPerAddressPerMinute: parsed.UPGRADE_ATTEMPTS_PER_ADDRESS_PER_MINUTE,
		maxConnectionsPerAddress: parsed.MAX_CONNECTIONS_PER_ADDRESS,
		clientHelloTimeoutMs: parsed.CLIENT_HELLO_TIMEOUT_MS,
		maxTrackedAddresses: parsed.MAX_TRACKED_ADDRESSES,
		metricsEnabled: parsed.METRICS_ENABLED,
		metricsBearerToken: parsed.METRICS_ENABLED ? parsed.METRICS_BEARER_TOKEN : null,
		shutdownDrainMs: parsed.SHUTDOWN_DRAIN_MS
	};
}
