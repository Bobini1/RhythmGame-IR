import { z } from 'zod';

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
		.default(DEFAULT_TELEMETRY_INTERVAL_MS)
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
}>;

export function loadArenaConfig(
	environment: Record<string, string | undefined> = Bun.env
): ArenaConfig {
	const parsed = environmentSchema.parse(environment);

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
		telemetryIntervalMs: parsed.TELEMETRY_INTERVAL_MS
	};
}
