import { timingSafeEqual } from 'node:crypto';

import type { ArenaApplication } from '../application/arena-application.ts';
import type { Delivery } from '../application/delivery.ts';
import type { ArenaConfig } from '../config.ts';
import {
	createOperationalMetrics,
	type OperationalMetrics,
	type WebSocketCloseClass
} from '../observability/operational-metrics.ts';
import { decodeClientMessage, encodeServerMessage } from '../protocol/codec.ts';
import { createFatalError, ProtocolError } from '../protocol/errors.ts';
import {
	MAX_CLIENT_MESSAGE_BYTES,
	PROTOCOL_MAJOR,
	PROTOCOL_MINOR,
	type ServerMessage
} from '../protocol/messages.ts';
import { createClientAddressResolver, type ClientAddressResolver } from './client-address.ts';
import {
	createConnectionAdmission,
	type ConnectionAdmissionController
} from './connection-admission.ts';

const DEFAULT_MAINTENANCE_INTERVAL_MS = 1_000;
const MAX_QUEUED_FRAMES = 32;
export const BACKPRESSURE_LIMIT_BYTES = 5 * 1024 * 1024;
const DEFAULT_PEER_UPGRADE_POLICY = { maxAttempts: 6_000, windowMs: 60_000 } as const;

export type SocketData = {
	readonly connectionId: string;
	readonly admissionLeaseId: string;
	receiveTail: Promise<void>;
	queuedFrames: number;
	closing: boolean;
	ephemeralBlocked: boolean;
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
	clientAddressResolver?: ClientAddressResolver;
	connectionAdmission?: ConnectionAdmissionController;
	operationalMetrics?: OperationalMetrics;
}>;

export type ArenaServerHandle = Readonly<{
	server: Bun.Server<SocketData>;
	port: number;
	shutdown(options?: Readonly<{ drainMs?: number }>): Promise<void>;
}>;

type SocketAction =
	| Readonly<{ kind: 'send'; encoded: string; byteLength: number; ephemeral: boolean }>
	| Readonly<{ kind: 'send_binary'; bytes: Uint8Array }>
	| Readonly<{ kind: 'close'; code: number; reason: string }>;

export function classifySocketDelivery(
	ephemeral: boolean,
	ephemeralBlocked: boolean,
	bufferedAmount: number,
	byteLength: number
): 'send' | 'drop' | 'close' {
	if (ephemeral && ephemeralBlocked) return 'drop';
	if (bufferedAmount + byteLength <= BACKPRESSURE_LIMIT_BYTES) return 'send';
	return ephemeral ? 'drop' : 'close';
}

export function blocksEphemeralAfterSend(sendResult: number): boolean {
	return sendResult <= 0;
}

export function constantTimeBearerTokenMatches(
	authorization: string | null,
	expectedToken: string
): boolean {
	if (authorization === null || !authorization.startsWith('Bearer ')) return false;
	const actual = Buffer.from(authorization.slice('Bearer '.length), 'utf8');
	const expected = Buffer.from(expectedToken, 'utf8');
	return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

export function startArenaServer(options: StartArenaServerOptions): ArenaServerHandle {
	const now = options.now ?? Date.now;
	const newConnectionId = options.newConnectionId ?? (() => crypto.randomUUID());
	const logger = options.logger ?? (() => undefined);
	const metrics = options.operationalMetrics ?? createOperationalMetrics();
	const safeLog: ArenaLogger = (level, event, fields) => {
		try {
			logger(level, event, fields);
		} catch {
			// Logging must never reject a socket receive tail.
		}
	};
	const peerUpgradePolicy = options.peerUpgradePolicy ?? DEFAULT_PEER_UPGRADE_POLICY;
	if (
		!Number.isSafeInteger(peerUpgradePolicy.maxAttempts) ||
		peerUpgradePolicy.maxAttempts < 1 ||
		!Number.isSafeInteger(peerUpgradePolicy.windowMs) ||
		peerUpgradePolicy.windowMs < 1_000
	) {
		throw new Error('Invalid Arena peer-upgrade policy.');
	}
	const clientAddressResolver =
		options.clientAddressResolver ?? createClientAddressResolver(options.config.trustedProxyCidrs);
	const connectionAdmission =
		options.connectionAdmission ??
		createConnectionAdmission({
			maxAttemptsPerMinute:
				options.peerUpgradePolicy?.maxAttempts ?? options.config.upgradeAttemptsPerAddressPerMinute,
			maxConnectionsPerAddress: options.config.maxConnectionsPerAddress,
			helloTimeoutMs: options.config.clientHelloTimeoutMs,
			maxTrackedAddresses: options.config.maxTrackedAddresses,
			maxConnections: options.config.maxConnections,
			...(options.peerUpgradePolicy === undefined
				? {}
				: { windowMs: options.peerUpgradePolicy.windowMs })
		});
	const sockets = new Map<string, Bun.ServerWebSocket<SocketData>>();
	const leaseSockets = new Map<string, Bun.ServerWebSocket<SocketData>>();
	let shuttingDown = false;
	let shutdownPromise: Promise<void> | undefined;
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	let scheduledDeadlineMs: number | undefined;
	let rescheduleDeadline = (): void => undefined;

	const releaseSocketLease = (socket: Bun.ServerWebSocket<SocketData>): void => {
		connectionAdmission.release(socket.data.admissionLeaseId);
		if (leaseSockets.get(socket.data.admissionLeaseId) === socket) {
			leaseSockets.delete(socket.data.admissionLeaseId);
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
			if (delivery.kind === 'send' || delivery.kind === 'send_ephemeral') {
				if (delivery.message.type === 'server_hello') {
					for (const connectionId of delivery.connectionIds) {
						const socket = sockets.get(connectionId);
						if (socket !== undefined) {
							connectionAdmission.markHello(socket.data.admissionLeaseId);
						}
					}
				}
				const encoded = encodeServerMessage(delivery.message);
				const byteLength = Buffer.byteLength(encoded, 'utf8');
				for (const connectionId of delivery.connectionIds) {
					const socket = sockets.get(connectionId);
					if (socket !== undefined) {
						append(socket, {
							kind: 'send',
							encoded,
							byteLength,
							ephemeral: delivery.kind === 'send_ephemeral'
						});
					}
				}
				continue;
			}
			if (delivery.kind === 'send_binary') {
				for (const connectionId of delivery.connectionIds) {
					const socket = sockets.get(connectionId);
					if (socket !== undefined) append(socket, { kind: 'send_binary', bytes: delivery.bytes });
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
			let reliableOverflow = false;
			socket.cork(() => {
				for (const action of socketActions) {
					if (action.kind === 'close') {
						socket.data.closing = true;
						closeAction = action;
						break;
					}
					if (socket.data.closing) continue;
					const byteLength = action.kind === 'send' ? action.byteLength : action.bytes.byteLength;
					const bufferedAmount = socket.getBufferedAmount();
					const disposition = classifySocketDelivery(
						action.kind === 'send' && action.ephemeral,
						socket.data.ephemeralBlocked,
						bufferedAmount,
						byteLength
					);
					if (disposition === 'drop') {
						metrics.standingsDropped();
						continue;
					}
					if (disposition === 'close') {
						reliableOverflow = true;
						break;
					}
					const result =
						action.kind === 'send' ? socket.send(action.encoded) : socket.send(action.bytes, true);
					if (blocksEphemeralAfterSend(result)) socket.data.ephemeralBlocked = true;
					if (action.kind === 'send' && action.ephemeral && result <= 0) {
						metrics.standingsDropped();
						continue;
					}
					if (result === 0) {
						if (action.kind === 'send' && action.ephemeral) {
							continue;
						}
						reliableOverflow = true;
						break;
					}
				}
			});
			if (reliableOverflow) {
				queueMicrotask(() => disconnectAndClose(socket, 1013, 'try_again_later'));
			} else if (closeAction !== undefined) {
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
		releaseSocketLease(socket);
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
		rescheduleDeadline();
	};

	const handleInternalFailure = (socket: Bun.ServerWebSocket<SocketData>): void => {
		safeLog('error', 'websocket_receive_failed');
		try {
			disconnectAndClose(socket, 1011, 'internal_error');
		} catch {
			socket.data.closing = true;
			releaseSocketLease(socket);
			safeLog('error', 'websocket_internal_cleanup_failed');
		}
	};

	const server = Bun.serve<SocketData>({
		hostname: options.config.host,
		port: options.portOverride ?? options.config.port,
		fetch(request, bunServer) {
			const url = new URL(request.url);
			if (url.pathname === '/metrics') {
				if (!options.config.metricsEnabled) return new Response(null, { status: 404 });
				if (request.method !== 'GET' || url.search.length > 0) {
					return new Response(null, { status: 404 });
				}
				const expectedToken = options.config.metricsBearerToken;
				if (
					expectedToken === null ||
					!constantTimeBearerTokenMatches(request.headers.get('authorization'), expectedToken)
				) {
					return new Response(null, {
						status: 401,
						headers: { 'Cache-Control': 'no-store', 'WWW-Authenticate': 'Bearer' }
					});
				}
				try {
					return new Response(metrics.renderPrometheus(), {
						status: 200,
						headers: {
							'Cache-Control': 'no-store',
							'Content-Type': 'text/plain; version=0.0.4; charset=utf-8'
						}
					});
				} catch {
					safeLog('error', 'metrics_render_failed');
					return new Response(null, { status: 500, headers: { 'Cache-Control': 'no-store' } });
				}
			}
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
			const address = clientAddressResolver.resolve({
				directPeer: bunServer.requestIP(request)?.address ?? '',
				forwardedFor: request.headers.get('x-forwarded-for')
			});
			const admission = connectionAdmission.attemptUpgrade(address, now());
			if (!admission.accepted) {
				return new Response(null, {
					status: admission.status,
					...(admission.status === 429
						? { headers: { 'Retry-After': String(Math.ceil(peerUpgradePolicy.windowMs / 1_000)) } }
						: {})
				});
			}
			const connectionId = newConnectionId();
			if (sockets.has(connectionId)) {
				connectionAdmission.release(admission.leaseId);
				return new Response(null, { status: 503 });
			}
			let upgraded: boolean;
			try {
				upgraded = bunServer.upgrade(request, {
					data: {
						connectionId,
						admissionLeaseId: admission.leaseId,
						receiveTail: Promise.resolve(),
						queuedFrames: 0,
						closing: false,
						ephemeralBlocked: false
					}
				});
			} catch (error) {
				connectionAdmission.release(admission.leaseId);
				throw error;
			}
			if (upgraded) return undefined;
			connectionAdmission.release(admission.leaseId);
			return new Response(null, { status: 426, headers: { Upgrade: 'websocket' } });
		},
		websocket: {
			open(socket) {
				metrics.connectionOpened();
				sockets.set(socket.data.connectionId, socket);
				leaseSockets.set(socket.data.admissionLeaseId, socket);
				try {
					applyDeliveries(options.application.connect(socket.data.connectionId));
					rescheduleDeadline();
				} catch {
					handleInternalFailure(socket);
				}
			},
			message(socket, frame) {
				if (
					shuttingDown ||
					socket.data.closing ||
					sockets.get(socket.data.connectionId) !== socket
				) {
					return;
				}
				if (socket.data.queuedFrames >= MAX_QUEUED_FRAMES) {
					disconnectAndClose(socket, 1008, 'rate_limited');
					return;
				}

				socket.data.queuedFrames += 1;
				const ownedFrame = typeof frame === 'string' ? frame : Uint8Array.from(frame);
				const work = socket.data.receiveTail.then(async () => {
					if (
						shuttingDown ||
						socket.data.closing ||
						sockets.get(socket.data.connectionId) !== socket
					) {
						return;
					}
					try {
						const deliveries =
							typeof ownedFrame === 'string'
								? await options.application.receive(
										socket.data.connectionId,
										decodeClientMessage(ownedFrame),
										now()
									)
								: await options.application.receiveBinary(
										socket.data.connectionId,
										ownedFrame,
										now()
									);
						if (
							shuttingDown ||
							socket.data.closing ||
							sockets.get(socket.data.connectionId) !== socket
						) {
							return;
						}
						applyDeliveries(deliveries);
						rescheduleDeadline();
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
				socket.data.ephemeralBlocked = false;
			},
			close(socket, code) {
				metrics.connectionClosed(classifyClose(code));
				releaseSocketLease(socket);
				if (sockets.get(socket.data.connectionId) !== socket) return;
				sockets.delete(socket.data.connectionId);
				socket.data.closing = true;
				try {
					applyDeliveries(options.application.disconnect(socket.data.connectionId, now()));
					rescheduleDeadline();
				} catch {
					safeLog('error', 'websocket_close_cleanup_failed');
				}
			},
			maxPayloadLength: MAX_CLIENT_MESSAGE_BYTES,
			backpressureLimit: BACKPRESSURE_LIMIT_BYTES,
			closeOnBackpressureLimit: false,
			idleTimeout: 120,
			sendPings: true
		}
	});

	rescheduleDeadline = (): void => {
		if (shuttingDown) return;
		const applicationDeadlineMs = options.application.nextDeadlineMs();
		const admissionDeadlineMs = connectionAdmission.nextHelloDeadlineMs();
		const nextDeadlineMs =
			applicationDeadlineMs === undefined
				? admissionDeadlineMs
				: admissionDeadlineMs === undefined
					? applicationDeadlineMs
					: Math.min(applicationDeadlineMs, admissionDeadlineMs);
		if (nextDeadlineMs === scheduledDeadlineMs && deadlineTimer !== undefined) return;
		if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
		deadlineTimer = undefined;
		scheduledDeadlineMs = nextDeadlineMs;
		if (nextDeadlineMs === undefined) return;
		deadlineTimer = setTimeout(
			() => {
				deadlineTimer = undefined;
				scheduledDeadlineMs = undefined;
				if (shuttingDown) return;
				try {
					for (const expired of connectionAdmission.sweep(now())) {
						const socket = leaseSockets.get(expired.leaseId);
						if (socket !== undefined) disconnectAndClose(socket, 1008, expired.reason);
					}
					applyDeliveries(options.application.sweep(now()));
				} catch {
					safeLog('error', 'deadline_sweep_failed');
				}
				rescheduleDeadline();
			},
			Math.max(0, nextDeadlineMs - now())
		);
		deadlineTimer.unref?.();
	};
	rescheduleDeadline();

	const maintenanceIntervalMs = options.maintenanceIntervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS;
	const maintenanceTimer = setInterval(() => {
		if (shuttingDown) return;
		try {
			const nowMs = now();
			for (const expired of connectionAdmission.sweep(nowMs)) {
				const socket = leaseSockets.get(expired.leaseId);
				if (socket !== undefined) disconnectAndClose(socket, 1008, expired.reason);
			}
			applyDeliveries(options.application.sweep(nowMs));
			rescheduleDeadline();
		} catch {
			safeLog('error', 'maintenance_failed');
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
		connectionAdmission.beginShutdown();
		clearInterval(maintenanceTimer);
		if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
		deadlineTimer = undefined;
		scheduledDeadlineMs = undefined;
		shutdownPromise = (async () => {
			const connectionIds = [...sockets.keys()];
			let cancellationDeliveries: readonly Delivery[] = [];
			try {
				cancellationDeliveries = options.application.shutdown(now());
			} catch {
				safeLog('error', 'application_shutdown_failed');
			}
			if (connectionIds.length > 0) {
				applyDeliveries([
					{
						kind: 'send',
						connectionIds,
						message: {
							type: 'server_going_away',
							data: { displayMessageKey: 'arena.serverGoingAway' }
						}
					},
					...cancellationDeliveries
				]);
			} else applyDeliveries(cancellationDeliveries);
			const drainMs = shutdownOptions.drainMs ?? options.config.shutdownDrainMs;
			if (drainMs > 0) await Bun.sleep(drainMs);

			for (const [connectionId, socket] of [...sockets]) {
				if (sockets.get(connectionId) !== socket) continue;
				try {
					options.application.disconnect(connectionId, now());
				} catch {
					safeLog('error', 'shutdown_disconnect_failed');
				}
				releaseSocketLease(socket);
				socket.data.closing = true;
				try {
					socket.close(1012, 'server_restart');
				} catch {
					safeLog('error', 'shutdown_socket_close_failed');
				}
			}
			sockets.clear();
			leaseSockets.clear();
			connectionAdmission.releaseAll();
			try {
				options.application.finalizeShutdown?.();
			} catch {
				safeLog('error', 'application_finalize_shutdown_failed');
			}
			await server.stop(true);
			safeLog('info', 'server_stopped', { activeConnections: connectionIds.length });
		})();
		return shutdownPromise;
	};

	return { server, port, shutdown };
}

function classifyClose(code: number): WebSocketCloseClass {
	if (code === 1012) return 'restart';
	if (code === 1013) return 'overload';
	if ([1002, 1003, 1007, 1008, 1009, 4001].includes(code)) return 'policy';
	if (code === 1000 || code === 1001) return 'normal';
	return 'error';
}
