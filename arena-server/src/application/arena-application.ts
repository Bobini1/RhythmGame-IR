import type { ArenaIdentity } from '../auth/identity.ts';
import { TicketVerificationError, type TicketVerifier } from '../auth/ticket-verifier.ts';
import {
	createCommandError,
	createFatalError,
	type CommandErrorCode,
	type FatalErrorCode
} from '../protocol/errors.ts';
import {
	PROTOCOL_MAJOR,
	PROTOCOL_MINOR,
	REQUIRED_CAPABILITY,
	type ClientMessage,
	type ServerMessage
} from '../protocol/messages.ts';
import type {
	DirectoryChange,
	RoomEffect,
	RoomRejectionCode,
	RoomSnapshot,
	SeatConnectionRef
} from '../rooms/models.ts';
import type { RoomDirectory } from '../rooms/room-directory.ts';
import type { Delivery } from './delivery.ts';

export type ArenaApplicationTiming = Readonly<{
	helloTimeoutMs: number;
	heartbeatIntervalMs: number;
	heartbeatReplyTimeoutMs: number;
}>;

export type ArenaApplicationOptions = Readonly<{
	ticketVerifier: TicketVerifier;
	roomDirectory: RoomDirectory;
	now: () => number;
	newNonce: () => string;
	timing?: Partial<ArenaApplicationTiming>;
}>;

type ConnectionCommon = {
	readonly connectionId: string;
	stateVersion: number;
	directorySubscribed: boolean;
	nextHeartbeatAtMs: number | null;
	pendingHeartbeat: Readonly<{ nonce: string; deadlineMs: number }> | null;
};

type AwaitingHelloConnection = ConnectionCommon & {
	phase: 'awaiting_hello';
	helloDeadlineMs: number;
};

type AnonymousConnection = ConnectionCommon & { phase: 'anonymous' };

type AuthenticatedConnection = ConnectionCommon & {
	phase: 'authenticated';
	identity: ArenaIdentity;
};

type RoomBoundConnection = ConnectionCommon & {
	phase: 'room_bound';
	identity: ArenaIdentity;
	binding: SeatConnectionRef;
};

type Connection =
	| AwaitingHelloConnection
	| AnonymousConnection
	| AuthenticatedConnection
	| RoomBoundConnection;
type PostHelloConnection = AnonymousConnection | AuthenticatedConnection | RoomBoundConnection;
type IdentityMutationWindow = {
	roomCreates: number[];
	passwordAttempts: number[];
};

const DEFAULT_TIMING: ArenaApplicationTiming = {
	helloTimeoutMs: 10_000,
	heartbeatIntervalMs: 20_000,
	heartbeatReplyTimeoutMs: 40_000
};
const ROOM_CREATE_LIMIT = 5;
const PASSWORD_ATTEMPT_LIMIT = 10;
const IDENTITY_LIMIT_WINDOW_MS = 60_000;

export class ArenaApplication {
	readonly #ticketVerifier: TicketVerifier;
	readonly #roomDirectory: RoomDirectory;
	readonly #now: () => number;
	readonly #newNonce: () => string;
	readonly #timing: ArenaApplicationTiming;
	readonly #connections = new Map<string, Connection>();
	readonly #issuedConnectionIds = new Set<string>();
	readonly #identityMutationWindows = new Map<string, IdentityMutationWindow>();

	constructor(options: ArenaApplicationOptions) {
		this.#ticketVerifier = options.ticketVerifier;
		this.#roomDirectory = options.roomDirectory;
		this.#now = options.now;
		this.#newNonce = options.newNonce;
		this.#timing = { ...DEFAULT_TIMING, ...options.timing };
	}

	connect(connectionId: string): readonly Delivery[] {
		if (this.#issuedConnectionIds.has(connectionId)) {
			throw new Error('Arena connection IDs must be unique for the process lifetime.');
		}
		this.#issuedConnectionIds.add(connectionId);
		const nowMs = this.#now();
		this.#connections.set(connectionId, {
			connectionId,
			phase: 'awaiting_hello',
			stateVersion: 0,
			directorySubscribed: false,
			nextHeartbeatAtMs: null,
			pendingHeartbeat: null,
			helloDeadlineMs: nowMs + this.#timing.helloTimeoutMs
		});
		return [];
	}

	async receive(
		connectionId: string,
		message: ClientMessage,
		nowMs: number
	): Promise<readonly Delivery[]> {
		const connection = this.#connections.get(connectionId);
		if (connection === undefined) return [];

		if (connection.phase === 'awaiting_hello') {
			if (message.type !== 'client_hello') {
				return this.#fatal(connection, 'hello_required', 1002, nowMs);
			}
			return this.#receiveHello(connection, message, nowMs);
		}
		if (message.type === 'client_hello') {
			return this.#fatal(connection, 'hello_repeated', 1002, nowMs);
		}
		const postHelloConnection = connection as PostHelloConnection;

		switch (message.type) {
			case 'directory_subscribe': {
				postHelloConnection.directorySubscribed = true;
				const snapshot = this.#roomDirectory.list();
				return [
					this.#send(connectionId, {
						type: 'directory_snapshot',
						data: { revision: snapshot.revision, rooms: snapshot.rooms.map(copyRoomSummary) }
					})
				];
			}
			case 'room_create':
				return this.#createRoom(postHelloConnection, message, nowMs);
			case 'room_join':
				return this.#joinRoom(postHelloConnection, message, nowMs);
			case 'room_leave':
				return this.#leaveRoom(postHelloConnection, message, nowMs);
			case 'room_kick':
				return this.#kickMember(postHelloConnection, message, nowMs);
			case 'chat_send':
				return this.#sendChat(postHelloConnection, message, nowMs);
			case 'heartbeat_reply': {
				const pending = postHelloConnection.pendingHeartbeat;
				if (
					pending === null ||
					pending.nonce !== message.data.nonce ||
					nowMs >= pending.deadlineMs
				) {
					return [];
				}
				postHelloConnection.pendingHeartbeat = null;
				postHelloConnection.nextHeartbeatAtMs = nowMs + this.#timing.heartbeatIntervalMs;
				return [];
			}
		}
	}

	disconnect(connectionId: string, nowMs: number): readonly Delivery[] {
		const connection = this.#connections.get(connectionId);
		if (connection === undefined) return [];
		this.#connections.delete(connectionId);
		if (connection.phase !== 'room_bound') return [];
		const result = this.#roomDirectory.disconnect(connection.binding, nowMs);
		return result.ok ? this.#mapTransition(result.effects, result.directoryChange) : [];
	}

	sweep(nowMs: number): readonly Delivery[] {
		this.#sweepIdentityMutationWindows(nowMs);
		const deliveries: Delivery[] = [];
		for (const transition of this.#roomDirectory.sweep(nowMs)) {
			deliveries.push(...this.#mapTransition(transition.effects, transition.directoryChange));
		}
		for (const connection of [...this.#connections.values()]) {
			if (connection.phase === 'awaiting_hello' && nowMs >= connection.helloDeadlineMs) {
				deliveries.push(...this.#fatal(connection, 'hello_required', 1002, nowMs));
				continue;
			}
			if (connection.phase === 'awaiting_hello') continue;
			if (connection.pendingHeartbeat !== null && nowMs >= connection.pendingHeartbeat.deadlineMs) {
				this.#connections.delete(connection.connectionId);
				if (connection.phase === 'room_bound') {
					const transition = this.#roomDirectory.disconnect(connection.binding, nowMs);
					if (transition.ok) {
						deliveries.push(...this.#mapTransition(transition.effects, transition.directoryChange));
					}
				}
				deliveries.push({
					kind: 'close',
					connectionId: connection.connectionId,
					code: 1001,
					reason: 'heartbeat_timeout'
				});
				continue;
			}
			if (
				connection.pendingHeartbeat === null &&
				connection.nextHeartbeatAtMs !== null &&
				nowMs >= connection.nextHeartbeatAtMs
			) {
				const nonce = this.#newNonce();
				connection.pendingHeartbeat = {
					nonce,
					deadlineMs: nowMs + this.#timing.heartbeatReplyTimeoutMs
				};
				connection.nextHeartbeatAtMs = null;
				deliveries.push(
					this.#send(connection.connectionId, {
						type: 'server_heartbeat',
						data: { nonce, sentAtMs: nowMs }
					})
				);
			}
		}
		return deliveries;
	}

	async #receiveHello(
		connection: AwaitingHelloConnection,
		message: Extract<ClientMessage, { type: 'client_hello' }>,
		nowMs: number
	): Promise<readonly Delivery[]> {
		if (message.data.ticket === undefined) {
			const anonymous = this.#replaceConnection<AnonymousConnection>(
				connection,
				{ phase: 'anonymous' },
				nowMs
			);
			return [this.#send(anonymous.connectionId, serverHello())];
		}

		const capturedVersion = connection.stateVersion;
		let identity: ArenaIdentity;
		try {
			identity = (await this.#ticketVerifier.verify(message.data.ticket, new Date(nowMs))).identity;
		} catch (error) {
			if (!this.#isCurrent(connection, 'awaiting_hello', capturedVersion)) return [];
			const code = error instanceof TicketVerificationError ? error.code : 'invalid_ticket';
			return this.#fatal(connection, code, 1008, nowMs);
		}
		if (!this.#isCurrent(connection, 'awaiting_hello', capturedVersion)) return [];

		if (message.data.resume === undefined) {
			const authenticated = this.#replaceConnection<AuthenticatedConnection>(
				connection,
				{
					phase: 'authenticated',
					identity
				},
				nowMs
			);
			return [this.#send(authenticated.connectionId, serverHello(identity))];
		}

		const resumed = this.#roomDirectory.resume({
			roomId: message.data.resume.roomId,
			connectionId: connection.connectionId,
			identity,
			resumeToken: message.data.resume.seatToken,
			nowMs
		});
		if (!resumed.ok) {
			const authenticated = this.#replaceConnection<AuthenticatedConnection>(
				connection,
				{ phase: 'authenticated', identity },
				nowMs
			);
			return [this.#send(authenticated.connectionId, failedResumeHello(identity))];
		}

		const bound = this.#replaceConnection<RoomBoundConnection>(
			connection,
			{ phase: 'room_bound', identity, binding: resumed.value.binding },
			nowMs
		);
		const deliveries: Delivery[] = [
			this.#send(bound.connectionId, resumedServerHello(identity, resumed.value.snapshot))
		];
		const staleConnectionId = resumed.value.staleConnectionId;
		if (staleConnectionId !== undefined) {
			const stale = this.#connections.get(staleConnectionId);
			if (
				stale?.phase === 'room_bound' &&
				stale.binding.roomId === resumed.value.binding.roomId &&
				stale.binding.seatId === resumed.value.binding.seatId &&
				stale.binding.connectionGeneration < resumed.value.binding.connectionGeneration
			) {
				this.#connections.delete(staleConnectionId);
				deliveries.push({
					kind: 'close',
					connectionId: staleConnectionId,
					code: 4001,
					reason: 'seat_replaced'
				});
			}
		}
		deliveries.push(...this.#mapTransition(resumed.effects, resumed.directoryChange));
		return deliveries;
	}

	async #createRoom(
		connection: PostHelloConnection,
		message: Extract<ClientMessage, { type: 'room_create' }>,
		nowMs: number
	): Promise<readonly Delivery[]> {
		if (connection.phase === 'anonymous') {
			return [
				this.#send(connection.connectionId, createCommandError(message.requestId, 'auth_required'))
			];
		}
		if (connection.phase === 'room_bound') {
			return [
				this.#send(
					connection.connectionId,
					createCommandError(message.requestId, 'already_in_room')
				)
			];
		}
		if (
			!this.#consumeIdentityMutation(
				connection.identity.userId,
				'roomCreates',
				nowMs,
				ROOM_CREATE_LIMIT
			)
		) {
			return [
				this.#send(connection.connectionId, createCommandError(message.requestId, 'rate_limited'))
			];
		}
		const capturedVersion = connection.stateVersion;
		const result = await this.#roomDirectory.create({
			connectionId: connection.connectionId,
			identity: connection.identity,
			name: message.data.name,
			...(message.data.password === undefined ? {} : { password: message.data.password })
		});
		if (!this.#isCurrent(connection, 'authenticated', capturedVersion)) {
			if (!result.ok) return [];
			const compensated = this.#roomDirectory.leave(result.value.binding, this.#now());
			return compensated.ok ? this.#mapTransition([], compensated.directoryChange) : [];
		}
		if (!result.ok) {
			return [
				this.#send(
					connection.connectionId,
					createCommandError(message.requestId, toCommandCode(result.rejection.code))
				)
			];
		}
		this.#replaceConnection<RoomBoundConnection>(connection, {
			phase: 'room_bound',
			identity: connection.identity,
			binding: result.value.binding
		});
		return [
			this.#send(connection.connectionId, {
				type: 'room_snapshot',
				requestId: message.requestId,
				data: copyRoomSnapshot(result.value.snapshot)
			}),
			...this.#mapTransition(result.effects, result.directoryChange)
		];
	}

	async #joinRoom(
		connection: PostHelloConnection,
		message: Extract<ClientMessage, { type: 'room_join' }>,
		nowMs: number
	): Promise<readonly Delivery[]> {
		if (connection.phase === 'anonymous') {
			return [
				this.#send(connection.connectionId, createCommandError(message.requestId, 'auth_required'))
			];
		}
		if (connection.phase === 'room_bound') {
			return [
				this.#send(
					connection.connectionId,
					createCommandError(message.requestId, 'already_in_room')
				)
			];
		}
		if (
			message.data.password !== undefined &&
			!this.#consumeIdentityMutation(
				connection.identity.userId,
				'passwordAttempts',
				nowMs,
				PASSWORD_ATTEMPT_LIMIT
			)
		) {
			return [
				this.#send(connection.connectionId, createCommandError(message.requestId, 'rate_limited'))
			];
		}
		const capturedVersion = connection.stateVersion;
		const result = await this.#roomDirectory.join({
			roomId: message.data.roomId,
			connectionId: connection.connectionId,
			identity: connection.identity,
			...(message.data.password === undefined ? {} : { password: message.data.password })
		});
		if (!this.#isCurrent(connection, 'authenticated', capturedVersion)) {
			if (!result.ok) return [];
			const compensated = this.#roomDirectory.leave(result.value.binding, this.#now());
			return compensated.ok ? this.#mapTransition([], compensated.directoryChange) : [];
		}
		if (!result.ok) {
			return [
				this.#send(
					connection.connectionId,
					createCommandError(message.requestId, toCommandCode(result.rejection.code))
				)
			];
		}
		this.#replaceConnection<RoomBoundConnection>(connection, {
			phase: 'room_bound',
			identity: connection.identity,
			binding: result.value.binding
		});
		return [
			this.#send(connection.connectionId, {
				type: 'room_snapshot',
				requestId: message.requestId,
				data: copyRoomSnapshot(result.value.snapshot)
			}),
			...this.#mapTransition(result.effects, result.directoryChange)
		];
	}

	#leaveRoom(
		connection: PostHelloConnection,
		message: Extract<ClientMessage, { type: 'room_leave' }>,
		nowMs: number
	): readonly Delivery[] {
		if (connection.phase === 'anonymous') {
			return [
				this.#send(connection.connectionId, createCommandError(message.requestId, 'auth_required'))
			];
		}
		if (connection.phase === 'authenticated') {
			return [
				this.#send(connection.connectionId, createCommandError(message.requestId, 'not_in_room'))
			];
		}
		const mismatch = bindingMismatch(connection.binding, message.data);
		if (mismatch !== undefined) {
			return [this.#send(connection.connectionId, createCommandError(message.requestId, mismatch))];
		}
		const result = this.#roomDirectory.leave(connection.binding, nowMs);
		if (!result.ok) {
			return [
				this.#send(
					connection.connectionId,
					createCommandError(message.requestId, toCommandCode(result.rejection.code))
				)
			];
		}
		this.#replaceConnection<AuthenticatedConnection>(connection, {
			phase: 'authenticated',
			identity: connection.identity
		});
		return this.#mapTransition(result.effects, result.directoryChange);
	}

	#kickMember(
		connection: PostHelloConnection,
		message: Extract<ClientMessage, { type: 'room_kick' }>,
		nowMs: number
	): readonly Delivery[] {
		const preflight = this.#roomCommandPreflight(connection, message.requestId, message.data);
		if (preflight !== undefined) return preflight;
		if (connection.phase !== 'room_bound')
			throw new Error('Room command preflight invariant failed.');
		const result = this.#roomDirectory.kick(connection.binding, message.data.targetMemberId, nowMs);
		if (!result.ok) {
			return [
				this.#send(
					connection.connectionId,
					createCommandError(message.requestId, toCommandCode(result.rejection.code))
				)
			];
		}
		return this.#mapTransition(result.effects, result.directoryChange);
	}

	#sendChat(
		connection: PostHelloConnection,
		message: Extract<ClientMessage, { type: 'chat_send' }>,
		nowMs: number
	): readonly Delivery[] {
		const preflight = this.#roomCommandPreflight(connection, message.requestId, message.data);
		if (preflight !== undefined) return preflight;
		if (connection.phase !== 'room_bound')
			throw new Error('Room command preflight invariant failed.');
		const result = this.#roomDirectory.sendChat(connection.binding, message.data.text, nowMs);
		if (!result.ok) {
			return [
				this.#send(
					connection.connectionId,
					createCommandError(message.requestId, toCommandCode(result.rejection.code))
				)
			];
		}
		return this.#mapTransition(result.effects, result.directoryChange);
	}

	#roomCommandPreflight(
		connection: PostHelloConnection,
		requestId: string,
		data: Readonly<{
			roomId: string;
			roomGeneration: number;
			connectionGeneration: number;
		}>
	): readonly Delivery[] | undefined {
		if (connection.phase === 'anonymous') {
			return [this.#send(connection.connectionId, createCommandError(requestId, 'auth_required'))];
		}
		if (connection.phase === 'authenticated') {
			return [this.#send(connection.connectionId, createCommandError(requestId, 'not_in_room'))];
		}
		const mismatch = bindingMismatch(connection.binding, data);
		return mismatch === undefined
			? undefined
			: [this.#send(connection.connectionId, createCommandError(requestId, mismatch))];
	}

	#fatal(
		connection: Connection,
		code: FatalErrorCode,
		closeCode: number,
		nowMs: number
	): readonly Delivery[] {
		if (this.#connections.get(connection.connectionId) !== connection) return [];
		this.#connections.delete(connection.connectionId);
		const transition =
			connection.phase === 'room_bound'
				? this.#roomDirectory.disconnect(connection.binding, nowMs)
				: undefined;
		return [
			this.#send(connection.connectionId, createFatalError(code)),
			...(transition?.ok
				? this.#mapTransition(transition.effects, transition.directoryChange)
				: []),
			{ kind: 'close', connectionId: connection.connectionId, code: closeCode, reason: code }
		];
	}

	#mapTransition(
		effects: readonly RoomEffect[],
		directoryChange?: DirectoryChange
	): readonly Delivery[] {
		for (const effect of effects) {
			if (effect.type !== 'member_left' || effect.invalidatedBinding === undefined) continue;
			const invalidated = effect.invalidatedBinding;
			const target = this.#connections.get(invalidated.connectionId);
			if (target?.phase === 'room_bound' && sameBinding(target.binding, invalidated)) {
				this.#replaceConnection<AuthenticatedConnection>(target, {
					phase: 'authenticated',
					identity: target.identity
				});
			}
		}
		const deliveries = effects
			.map((effect) => this.#mapEffect(effect))
			.filter((delivery): delivery is Delivery => delivery !== undefined);
		if (directoryChange !== undefined) {
			const subscribers = [...this.#connections.values()]
				.filter(
					(connection) => connection.phase !== 'awaiting_hello' && connection.directorySubscribed
				)
				.map((connection) => connection.connectionId);
			if (subscribers.length > 0) {
				deliveries.push(
					this.#sendMany(subscribers, {
						type: 'room_directory_updated',
						data: {
							revision: directoryChange.revision,
							upserts: directoryChange.upserts.map(copyRoomSummary),
							removedRoomIds: [...directoryChange.removedRoomIds]
						}
					})
				);
			}
		}
		return deliveries;
	}

	#mapEffect(effect: RoomEffect): Delivery | undefined {
		const connectionIds = effect.targets.filter((id) => this.#connections.has(id));
		if (connectionIds.length === 0) return undefined;
		switch (effect.type) {
			case 'member_joined':
				return this.#sendMany(connectionIds, {
					type: 'room_member_joined',
					data: {
						roomId: effect.roomId,
						roomGeneration: effect.roomGeneration,
						member: copyMember(effect.member)
					}
				});
			case 'member_updated':
				return this.#sendMany(connectionIds, {
					type: 'room_member_updated',
					data: {
						roomId: effect.roomId,
						roomGeneration: effect.roomGeneration,
						member: copyMember(effect.member)
					}
				});
			case 'member_left':
				return this.#sendMany(connectionIds, {
					type: 'room_member_left',
					data: {
						roomId: effect.roomId,
						roomGeneration: effect.roomGeneration,
						memberId: effect.memberId,
						reason: effect.reason
					}
				});
			case 'owner_changed':
				return this.#sendMany(connectionIds, {
					type: 'room_owner_changed',
					data: {
						roomId: effect.roomId,
						roomGeneration: effect.roomGeneration,
						ownerMemberId: effect.ownerMemberId
					}
				});
			case 'chat_message':
				return this.#sendMany(connectionIds, {
					type: 'chat_message',
					data: {
						roomId: effect.roomId,
						roomGeneration: effect.roomGeneration,
						message: { ...effect.message }
					}
				});
		}
	}

	#replaceConnection<T extends Connection>(
		current: Connection,
		extra: Omit<T, keyof ConnectionCommon>,
		heartbeatStartMs?: number
	): T {
		const startsHeartbeat = current.phase === 'awaiting_hello';
		const next = {
			connectionId: current.connectionId,
			stateVersion: current.stateVersion + 1,
			directorySubscribed: current.directorySubscribed,
			nextHeartbeatAtMs: startsHeartbeat
				? (heartbeatStartMs ?? this.#now()) + this.#timing.heartbeatIntervalMs
				: current.nextHeartbeatAtMs,
			pendingHeartbeat: startsHeartbeat ? null : current.pendingHeartbeat,
			...extra
		} as T;
		this.#connections.set(current.connectionId, next);
		return next;
	}

	#isCurrent<T extends Connection['phase']>(
		connection: Connection,
		phase: T,
		stateVersion: number
	): connection is Extract<Connection, { phase: T }> {
		return (
			this.#connections.get(connection.connectionId) === connection &&
			connection.phase === phase &&
			connection.stateVersion === stateVersion
		);
	}

	#consumeIdentityMutation(
		userId: string,
		kind: keyof IdentityMutationWindow,
		nowMs: number,
		limit: number
	): boolean {
		const window = this.#identityMutationWindows.get(userId) ?? {
			roomCreates: [],
			passwordAttempts: []
		};
		const active = window[kind].filter((timestamp) => timestamp > nowMs - IDENTITY_LIMIT_WINDOW_MS);
		window[kind] = active;
		this.#identityMutationWindows.set(userId, window);
		if (active.length >= limit) return false;
		active.push(nowMs);
		return true;
	}

	#sweepIdentityMutationWindows(nowMs: number): void {
		for (const [userId, window] of this.#identityMutationWindows) {
			window.roomCreates = window.roomCreates.filter(
				(timestamp) => timestamp > nowMs - IDENTITY_LIMIT_WINDOW_MS
			);
			window.passwordAttempts = window.passwordAttempts.filter(
				(timestamp) => timestamp > nowMs - IDENTITY_LIMIT_WINDOW_MS
			);
			if (window.roomCreates.length === 0 && window.passwordAttempts.length === 0) {
				this.#identityMutationWindows.delete(userId);
			}
		}
	}

	#send(connectionId: string, message: ServerMessage): Delivery {
		return this.#sendMany([connectionId], message);
	}

	#sendMany(connectionIds: readonly string[], message: ServerMessage): Delivery {
		return { kind: 'send', connectionIds: [...connectionIds], message };
	}
}

function serverHello(identity?: ArenaIdentity): ServerMessage {
	return {
		type: 'server_hello',
		data: {
			protocolMajor: PROTOCOL_MAJOR,
			protocolMinor: PROTOCOL_MINOR,
			capabilities: [REQUIRED_CAPABILITY],
			...(identity === undefined ? {} : { identity }),
			resume: { status: 'not_requested' }
		}
	};
}

function failedResumeHello(identity: ArenaIdentity): ServerMessage {
	return {
		type: 'server_hello',
		data: {
			protocolMajor: PROTOCOL_MAJOR,
			protocolMinor: PROTOCOL_MINOR,
			capabilities: [REQUIRED_CAPABILITY],
			identity,
			resume: {
				status: 'failed',
				code: 'room_resume_failed',
				displayMessageKey: 'arena.error.resumeFailed'
			}
		}
	};
}

function resumedServerHello(identity: ArenaIdentity, room: RoomSnapshot): ServerMessage {
	return {
		type: 'server_hello',
		data: {
			protocolMajor: PROTOCOL_MAJOR,
			protocolMinor: PROTOCOL_MINOR,
			capabilities: [REQUIRED_CAPABILITY],
			identity,
			resume: { status: 'succeeded', room: copyRoomSnapshot(room) }
		}
	};
}

function bindingMismatch(
	binding: SeatConnectionRef,
	input: Readonly<{
		roomId: string;
		roomGeneration: number;
		connectionGeneration: number;
	}>
): CommandErrorCode | undefined {
	if (input.roomId !== binding.roomId) return 'not_in_room';
	if (input.roomGeneration !== binding.roomGeneration) return 'room_generation_stale';
	if (input.connectionGeneration !== binding.connectionGeneration)
		return 'connection_generation_stale';
	return undefined;
}

function sameBinding(left: SeatConnectionRef, right: SeatConnectionRef): boolean {
	return (
		left.roomId === right.roomId &&
		left.roomGeneration === right.roomGeneration &&
		left.seatId === right.seatId &&
		left.connectionId === right.connectionId &&
		left.connectionGeneration === right.connectionGeneration &&
		left.userId === right.userId
	);
}

function toCommandCode(code: RoomRejectionCode): CommandErrorCode {
	if (code === 'room_resume_failed') throw new Error('Resume failure is not a command error.');
	return code;
}

function copyRoomSummary(summary: {
	roomId: string;
	name: string;
	phase: 'selecting';
	hasPassword: boolean;
	connectedCount: number;
	reservedCount: number;
	maxCount: 16;
}) {
	return { ...summary };
}

function copyMember(member: RoomSnapshot['members'][number]) {
	return { ...member, identity: { ...member.identity } };
}

function copyRoomSnapshot(snapshot: RoomSnapshot) {
	return {
		...snapshot,
		self: { ...snapshot.self },
		members: snapshot.members.map(copyMember),
		chat: snapshot.chat.map((message) => ({ ...message }))
	};
}
