import type { ArenaApplication } from '../application/arena-application.ts';
import type { Delivery } from '../application/delivery.ts';
import type { ArenaConfig } from '../config.ts';
import { decodeClientMessage, encodeServerMessage } from '../protocol/codec.ts';
import { createFatalError, ProtocolError } from '../protocol/errors.ts';
import {
	MAX_CLIENT_MESSAGE_BYTES,
	PROTOCOL_MAJOR,
	PROTOCOL_MINOR,
	type ServerMessage
} from '../protocol/messages.ts';

const DEFAULT_MAINTENANCE_INTERVAL_MS = 1_000;
const DEFAULT_SHUTDOWN_DRAIN_MS = 250;
const MAX_QUEUED_FRAMES = 32;
const BACKPRESSURE_LIMIT_BYTES = 256 * 1024;
const DEFAULT_PEER_UPGRADE_POLICY = { maxAttempts: 6_000, windowMs: 60_000 } as const;

export type SocketData = {
	readonly connectionId: string;
	readonly peerKey: string;
	receiveTail: Promise<void>;
	queuedFrames: number;
	closing: boolean;
	backpressured: boolean;
};

export type ArenaLogFields = Readonly<Record<string, string | number | boolean | undefined>>;
export type ArenaLogger = (
	level: 'info' | 'warn' | 'error',
	event: string,
	fields?: ArenaLogFields
) => void;

export type StartArenaServerOptions = Readonly<{
	application: ArenaApplication;
	config: ArenaConfig;
	portOverride?: number;
	maintenanceIntervalMs?: number;
	now?: () => number;
	newConnectionId?: () => string;
	logger?: ArenaLogger;
	peerUpgradePolicy?: Readonly<{ maxAttempts: number; windowMs: number }>;
}>;

export type ArenaServerHandle = Readonly<{
	server: Bun.Server<SocketData>;
	port: number;
	shutdown(options?: Readonly<{ drainMs?: number }>): Promise<void>;
}>;

type SocketAction =
	| Readonly<{ kind: 'send'; encoded: string }>
	| Readonly<{ kind: 'close'; code: number; reason: string }>;

export function startArenaServer(options: StartArenaServerOptions): ArenaServerHandle {
	const now = options.now ?? Date.now;
	const newConnectionId = options.newConnectionId ?? (() => crypto.randomUUID());
	const logger = options.logger ?? (() => undefined);
	const peerUpgradePolicy = options.peerUpgradePolicy ?? DEFAULT_PEER_UPGRADE_POLICY;
	if (
		!Number.isSafeInteger(peerUpgradePolicy.maxAttempts) ||
		peerUpgradePolicy.maxAttempts < 1 ||
		!Number.isSafeInteger(peerUpgradePolicy.windowMs) ||
		peerUpgradePolicy.windowMs < 1_000
	) {
		throw new Error('Invalid Arena peer-upgrade policy.');
	}
	const sockets = new Map<string, Bun.ServerWebSocket<SocketData>>();
	const peerUpgradeAttempts = new Map<string, number[]>();
	let shuttingDown = false;
	let shutdownPromise: Promise<void> | undefined;

	const consumePeerUpgradeAttempt = (peerKey: string, nowMs: number): boolean => {
		const active = (peerUpgradeAttempts.get(peerKey) ?? []).filter(
			(timestamp) => timestamp > nowMs - peerUpgradePolicy.windowMs
		);
		peerUpgradeAttempts.set(peerKey, active);
		if (active.length >= peerUpgradePolicy.maxAttempts) return false;
		active.push(nowMs);
		return true;
	};

	const sweepPeerUpgradeAttempts = (nowMs: number): void => {
		for (const [peerKey, attempts] of peerUpgradeAttempts) {
			const active = attempts.filter((timestamp) => timestamp > nowMs - peerUpgradePolicy.windowMs);
			if (active.length === 0) peerUpgradeAttempts.delete(peerKey);
			else peerUpgradeAttempts.set(peerKey, active);
		}
	};

	const applyDeliveries = (deliveries: readonly Delivery[]): void => {
		const actions = new Map<Bun.ServerWebSocket<SocketData>, SocketAction[]>();
		const append = (socket: Bun.ServerWebSocket<SocketData>, action: SocketAction): void => {
			const socketActions = actions.get(socket);
			if (socketActions === undefined) actions.set(socket, [action]);
			else socketActions.push(action);
		};

		for (const delivery of deliveries) {
			if (delivery.kind === 'send') {
				const encoded = encodeServerMessage(delivery.message);
				for (const connectionId of delivery.connectionIds) {
					const socket = sockets.get(connectionId);
					if (socket !== undefined) append(socket, { kind: 'send', encoded });
				}
				continue;
			}
			const socket = sockets.get(delivery.connectionId);
			if (socket !== undefined) {
				append(socket, { kind: 'close', code: delivery.code, reason: delivery.reason });
			}
		}

		for (const [socket, socketActions] of actions) {
			let closeAction: Extract<SocketAction, { kind: 'close' }> | undefined;
			socket.cork(() => {
				for (const action of socketActions) {
					if (action.kind === 'close') {
						socket.data.closing = true;
						closeAction = action;
						break;
					}
					if (socket.data.closing) continue;
					const result = socket.send(action.encoded);
					if (result === -1) socket.data.backpressured = true;
					else if (result === 0) {
						logger('warn', 'websocket_send_dropped', {
							connectionId: socket.data.connectionId
						});
					}
				}
			});
			if (closeAction !== undefined) {
				const { code, reason } = closeAction;
				queueMicrotask(() => socket.close(code, reason));
			}
		}
	};

	const disconnectAndClose = (
		socket: Bun.ServerWebSocket<SocketData>,
		code: number,
		reason: string,
		message?: ServerMessage
	): void => {
		if (socket.data.closing) return;
		const disconnectDeliveries = options.application.disconnect(socket.data.connectionId, now());
		applyDeliveries([
			...(message === undefined
				? []
				: [
						{
							kind: 'send' as const,
							connectionIds: [socket.data.connectionId],
							message
						}
					]),
			...disconnectDeliveries,
			{ kind: 'close', connectionId: socket.data.connectionId, code, reason }
		]);
	};

	const handleInternalFailure = (socket: Bun.ServerWebSocket<SocketData>): void => {
		logger('error', 'websocket_receive_failed', { connectionId: socket.data.connectionId });
		disconnectAndClose(socket, 1011, 'internal_error');
	};

	const server = Bun.serve<SocketData>({
		hostname: options.config.host,
		port: options.portOverride ?? options.config.port,
		fetch(request, bunServer) {
			const url = new URL(request.url);
			if (request.method === 'GET' && url.pathname === '/healthz') {
				return Response.json(
					{
						status: 'ok',
						protocolMajor: PROTOCOL_MAJOR,
						protocolMinor: PROTOCOL_MINOR
					},
					{ headers: { 'Cache-Control': 'no-store' } }
				);
			}
			if (url.pathname !== '/ws') return new Response(null, { status: 404 });
			if (request.method !== 'GET') {
				return new Response(null, { status: 405, headers: { Allow: 'GET' } });
			}
			if (shuttingDown) return new Response(null, { status: 503 });
			if (url.search.length > 0) return new Response(null, { status: 400 });

			const peerKey = bunServer.requestIP(request)?.address ?? 'unknown-peer';
			if (!consumePeerUpgradeAttempt(peerKey, now())) {
				return new Response(null, {
					status: 429,
					headers: {
						'Retry-After': String(Math.ceil(peerUpgradePolicy.windowMs / 1_000))
					}
				});
			}
			const connectionId = newConnectionId();
			const upgraded = bunServer.upgrade(request, {
				data: {
					connectionId,
					peerKey,
					receiveTail: Promise.resolve(),
					queuedFrames: 0,
					closing: false,
					backpressured: false
				}
			});
			if (upgraded) return undefined;
			return new Response(null, { status: 426, headers: { Upgrade: 'websocket' } });
		},
		websocket: {
			open(socket) {
				sockets.set(socket.data.connectionId, socket);
				try {
					applyDeliveries(options.application.connect(socket.data.connectionId));
				} catch {
					handleInternalFailure(socket);
				}
			},
			message(socket, frame) {
				if (socket.data.closing || sockets.get(socket.data.connectionId) !== socket) {
					return;
				}
				if (typeof frame !== 'string') {
					disconnectAndClose(
						socket,
						1003,
						'unexpected_binary',
						createFatalError('unexpected_binary')
					);
					return;
				}
				if (socket.data.queuedFrames >= MAX_QUEUED_FRAMES) {
					disconnectAndClose(socket, 1008, 'rate_limited');
					return;
				}

				socket.data.queuedFrames += 1;
				const work = socket.data.receiveTail.then(async () => {
					if (socket.data.closing || sockets.get(socket.data.connectionId) !== socket) {
						return;
					}
					try {
						const message = decodeClientMessage(frame);
						const deliveries = await options.application.receive(
							socket.data.connectionId,
							message,
							now()
						);
						if (socket.data.closing || sockets.get(socket.data.connectionId) !== socket) {
							return;
						}
						applyDeliveries(deliveries);
					} catch (error) {
						if (error instanceof ProtocolError) {
							const closeCode = error.code === 'frame_too_large' ? 1009 : 1002;
							disconnectAndClose(socket, closeCode, error.code, createFatalError(error.code));
							return;
						}
						handleInternalFailure(socket);
					}
				});
				socket.data.receiveTail = work
					.catch(() => handleInternalFailure(socket))
					.finally(() => {
						socket.data.queuedFrames -= 1;
					});
			},
			drain(socket) {
				socket.data.backpressured = false;
			},
			close(socket) {
				if (sockets.get(socket.data.connectionId) !== socket) return;
				sockets.delete(socket.data.connectionId);
				socket.data.closing = true;
				try {
					applyDeliveries(options.application.disconnect(socket.data.connectionId, now()));
				} catch {
					logger('error', 'websocket_close_cleanup_failed', {
						connectionId: socket.data.connectionId
					});
				}
			},
			maxPayloadLength: MAX_CLIENT_MESSAGE_BYTES,
			backpressureLimit: BACKPRESSURE_LIMIT_BYTES,
			closeOnBackpressureLimit: true,
			idleTimeout: 120,
			sendPings: true
		}
	});

	const maintenanceIntervalMs = options.maintenanceIntervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS;
	const maintenanceTimer = setInterval(() => {
		if (shuttingDown) return;
		try {
			const nowMs = now();
			sweepPeerUpgradeAttempts(nowMs);
			applyDeliveries(options.application.sweep(nowMs));
		} catch {
			logger('error', 'maintenance_failed');
		}
	}, maintenanceIntervalMs);
	maintenanceTimer.unref?.();

	const port = server.port;
	if (port === undefined) {
		clearInterval(maintenanceTimer);
		void server.stop(true);
		throw new Error('Arena server did not expose a listening port.');
	}

	const shutdown = (shutdownOptions: Readonly<{ drainMs?: number }> = {}): Promise<void> => {
		if (shutdownPromise !== undefined) return shutdownPromise;
		shuttingDown = true;
		clearInterval(maintenanceTimer);
		shutdownPromise = (async () => {
			const connectionIds = [...sockets.keys()];
			if (connectionIds.length > 0) {
				applyDeliveries([
					{
						kind: 'send',
						connectionIds,
						message: {
							type: 'server_going_away',
							data: { displayMessageKey: 'arena.serverGoingAway' }
						}
					}
				]);
			}
			const drainMs = shutdownOptions.drainMs ?? DEFAULT_SHUTDOWN_DRAIN_MS;
			if (drainMs > 0) await Bun.sleep(drainMs);

			for (const [connectionId, socket] of [...sockets]) {
				if (sockets.get(connectionId) !== socket) continue;
				options.application.disconnect(connectionId, now());
				socket.data.closing = true;
				socket.close(1012, 'server_restart');
			}
			sockets.clear();
			await server.stop(true);
			logger('info', 'server_stopped', { activeConnections: connectionIds.length });
		})();
		return shutdownPromise;
	};

	return { server, port, shutdown };
}
