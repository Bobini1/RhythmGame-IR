import type { ArenaIdentity } from '../auth/identity.ts';
import { TicketVerificationError, type TicketVerifier } from '../auth/ticket-verifier.ts';
import { planAvailabilityTransfer } from '../inventory/availability-transfer.ts';
import { InventoryUploadManager } from '../inventory/inventory-upload-manager.ts';
import {
	createCommandError,
	createFatalError,
	type CommandErrorCode,
	type FatalErrorCode
} from '../protocol/errors.ts';
import {
	PROTOCOL_MAJOR,
	PROTOCOL_MINOR,
	ROOMS_CAPABILITY,
	ROUNDS_CAPABILITY,
	type ClientMessage,
	type ServerMessage
} from '../protocol/messages.ts';
import type {
	AvailabilitySnapshot,
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
	newTransferId?: () => Uint8Array;
	inventoryUploadManager?: InventoryUploadManager;
	timing?: Partial<ArenaApplicationTiming>;
}>;

type ConnectionCommon = {
	readonly connectionId: string;
	stateVersion: number;
	directorySubscribed: boolean;
	nextHeartbeatAtMs: number | null;
	pendingHeartbeat: Readonly<{ nonce: string; deadlineMs: number }> | null;
	protocolMinor: 0 | 1;
	capabilities: readonly (typeof ROOMS_CAPABILITY | typeof ROUNDS_CAPABILITY)[];
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
	readonly #newTransferId: () => Uint8Array;
	readonly #timing: ArenaApplicationTiming;
	readonly #inventoryUploads: InventoryUploadManager;
	readonly #connections = new Map<string, Connection>();
	readonly #issuedConnectionIds = new Set<string>();
	readonly #identityMutationWindows = new Map<string, IdentityMutationWindow>();
	readonly #availabilityResyncWindows = new Map<string, number[]>();

	constructor(options: ArenaApplicationOptions) {
		this.#ticketVerifier = options.ticketVerifier;
		this.#roomDirectory = options.roomDirectory;
		this.#now = options.now;
		this.#newNonce = options.newNonce;
		this.#newTransferId =
			options.newTransferId ?? (() => crypto.getRandomValues(new Uint8Array(16)));
		this.#timing = { ...DEFAULT_TIMING, ...options.timing };
		this.#inventoryUploads = options.inventoryUploadManager ?? new InventoryUploadManager();
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
			protocolMinor: 0,
			capabilities: [],
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
			case 'inventory_upload_begin':
				return this.#beginInventoryUpload(postHelloConnection, message, nowMs);
			case 'inventory_upload_commit':
				return this.#commitInventoryUpload(postHelloConnection, message, nowMs);
			case 'inventory_upload_abort':
				return this.#abortInventoryUpload(postHelloConnection, message, nowMs);
			case 'availability_applied':
				return this.#ackAvailability(postHelloConnection, message, nowMs);
			case 'availability_resync':
				return this.#resyncAvailability(postHelloConnection, message, nowMs);
			case 'selection_set':
			case 'ready_set':
			case 'round_probe_result':
			case 'round_load_result':
				return this.#phase2Placeholder(postHelloConnection, message.requestId);
		}
	}

	async receiveBinary(
		connectionId: string,
		frame: Uint8Array,
		nowMs: number
	): Promise<readonly Delivery[]> {
		const connection = this.#connections.get(connectionId);
		if (connection === undefined) return [];
		if (connection.phase !== 'room_bound' || !hasRoundsCapability(connection)) {
			return this.#fatal(connection, 'unexpected_binary', 1003, nowMs);
		}
		const libraryGeneration = this.#inventoryUploads.activeLibraryGeneration(connectionId);
		const appended = this.#inventoryUploads.append(connectionId, frame, nowMs);
		if (appended.ok) return [];
		const restored =
			libraryGeneration !== undefined &&
			this.#inventoryUploads.activeLibraryGeneration(connectionId) === undefined
				? this.#roomDirectory.abortInventorySync(connection.binding, libraryGeneration, nowMs)
				: undefined;
		return [
			...(restored?.ok ? this.#mapTransition(restored.effects, restored.directoryChange) : []),
			...this.#fatal(
				connection,
				appended.code === 'unexpected_binary' ? 'unexpected_binary' : 'malformed_inventory',
				appended.code === 'unexpected_binary' ? 1003 : 1002,
				nowMs
			)
		];
	}

	disconnect(connectionId: string, nowMs: number): readonly Delivery[] {
		const connection = this.#connections.get(connectionId);
		if (connection === undefined) return [];
		const aborted = this.#abortPendingInventory(connection, nowMs);
		this.#connections.delete(connectionId);
		if (connection.phase !== 'room_bound') return aborted;
		const result = this.#roomDirectory.disconnect(connection.binding, nowMs);
		return [
			...aborted,
			...(result.ok ? this.#mapTransition(result.effects, result.directoryChange) : [])
		];
	}

	sweep(nowMs: number): readonly Delivery[] {
		this.#sweepIdentityMutationWindows(nowMs);
		const deliveries: Delivery[] = [];
		for (const expired of this.#inventoryUploads.sweep(nowMs)) {
			const connection = this.#connections.get(expired.connectionId);
			if (connection?.phase !== 'room_bound') continue;
			const aborted = this.#roomDirectory.abortInventorySync(
				connection.binding,
				expired.libraryGeneration,
				nowMs
			);
			if (aborted.ok) {
				deliveries.push(...this.#mapTransition(aborted.effects, aborted.directoryChange));
			}
		}
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
				deliveries.push(...this.#abortPendingInventory(connection, nowMs));
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
		const negotiation = negotiate(message.data.protocolMinor, message.data.capabilities);
		if (message.data.ticket === undefined) {
			const anonymous = this.#replaceConnection<AnonymousConnection>(
				connection,
				{ phase: 'anonymous', ...negotiation },
				nowMs
			);
			return [this.#send(anonymous.connectionId, serverHello(anonymous))];
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
					identity,
					...negotiation
				},
				nowMs
			);
			return [this.#send(authenticated.connectionId, serverHello(authenticated, identity))];
		}

		if (!negotiation.capabilities.includes(ROUNDS_CAPABILITY)) {
			const authenticated = this.#replaceConnection<AuthenticatedConnection>(
				connection,
				{ phase: 'authenticated', identity, ...negotiation },
				nowMs
			);
			return [this.#send(authenticated.connectionId, failedResumeHello(authenticated, identity))];
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
				{ phase: 'authenticated', identity, ...negotiation },
				nowMs
			);
			return [this.#send(authenticated.connectionId, failedResumeHello(authenticated, identity))];
		}

		const bound = this.#replaceConnection<RoomBoundConnection>(
			connection,
			{ phase: 'room_bound', identity, binding: resumed.value.binding, ...negotiation },
			nowMs
		);
		const deliveries: Delivery[] = [
			this.#send(bound.connectionId, resumedServerHello(bound, identity, resumed.value.snapshot))
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
		if (!hasRoundsCapability(connection)) {
			return [
				this.#send(
					connection.connectionId,
					createCommandError(message.requestId, 'rounds_capability_required')
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
		if (!hasRoundsCapability(connection)) {
			return [
				this.#send(
					connection.connectionId,
					createCommandError(message.requestId, 'rounds_capability_required')
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
		this.#inventoryUploads.abortConnection(connection.connectionId);
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

	#beginInventoryUpload(
		connection: PostHelloConnection,
		message: Extract<ClientMessage, { type: 'inventory_upload_begin' }>,
		nowMs: number
	): readonly Delivery[] {
		const preflight = this.#roundCommandPreflight(connection, message.requestId, message.data);
		if (preflight !== undefined) return preflight;
		if (connection.phase !== 'room_bound') throw new Error('Round preflight invariant failed.');
		const marked = this.#roomDirectory.markInventorySyncing(
			connection.binding,
			message.data.libraryGeneration,
			nowMs
		);
		if (!marked.ok) {
			return [
				this.#send(
					connection.connectionId,
					createCommandError(message.requestId, toCommandCode(marked.rejection.code))
				)
			];
		}
		const declaration = inventoryDeclarationFrom(message.data);
		const begun = this.#inventoryUploads.begin(
			connection.connectionId,
			connection.identity.userId,
			declaration,
			nowMs
		);
		if (!begun.ok) {
			this.#inventoryUploads.abortConnection(connection.connectionId);
			const restored = this.#roomDirectory.abortInventorySync(
				connection.binding,
				message.data.libraryGeneration,
				nowMs
			);
			return [
				...(restored.ok ? this.#mapTransition(restored.effects, restored.directoryChange) : []),
				this.#send(connection.connectionId, createCommandError(message.requestId, begun.code))
			];
		}
		return [
			...this.#mapTransition(marked.effects, marked.directoryChange),
			this.#send(connection.connectionId, {
				type: 'inventory_upload_ready',
				requestId: message.requestId,
				data: {
					...message.data,
					uploadId: begun.uploadId,
					deadlineMs: begun.deadlineMs
				}
			})
		];
	}

	#commitInventoryUpload(
		connection: PostHelloConnection,
		message: Extract<ClientMessage, { type: 'inventory_upload_commit' }>,
		nowMs: number
	): readonly Delivery[] {
		const preflight = this.#roundCommandPreflight(connection, message.requestId, message.data);
		if (preflight !== undefined) return preflight;
		if (connection.phase !== 'room_bound') throw new Error('Round preflight invariant failed.');
		const committed = this.#inventoryUploads.commit(
			connection.connectionId,
			message.data.uploadId,
			inventoryDeclarationFrom(message.data),
			nowMs
		);
		if (!committed.ok) {
			const restored =
				this.#inventoryUploads.activeLibraryGeneration(connection.connectionId) === undefined
					? this.#roomDirectory.abortInventorySync(
							connection.binding,
							message.data.libraryGeneration,
							nowMs
						)
					: undefined;
			return [
				...(restored?.ok ? this.#mapTransition(restored.effects, restored.directoryChange) : []),
				this.#send(connection.connectionId, createCommandError(message.requestId, committed.code))
			];
		}
		const replaced = this.#roomDirectory.replaceInventory(
			connection.binding,
			{ libraryGeneration: message.data.libraryGeneration },
			committed.inventory,
			nowMs
		);
		if (!replaced.ok) {
			this.#inventoryUploads.releaseCommitted(committed.inventory);
			return [
				this.#send(
					connection.connectionId,
					createCommandError(message.requestId, toCommandCode(replaced.rejection.code))
				)
			];
		}
		return [
			this.#send(connection.connectionId, {
				type: 'inventory_committed',
				requestId: message.requestId,
				data: {
					roomId: message.data.roomId,
					roomGeneration: message.data.roomGeneration,
					connectionGeneration: message.data.connectionGeneration,
					libraryGeneration: replaced.value.libraryGeneration,
					inventoryRevision: replaced.value.inventoryRevision,
					inventoryState: 'ready'
				}
			}),
			...this.#mapTransition(replaced.effects, replaced.directoryChange)
		];
	}

	#abortInventoryUpload(
		connection: PostHelloConnection,
		message: Extract<ClientMessage, { type: 'inventory_upload_abort' }>,
		nowMs: number
	): readonly Delivery[] {
		const preflight = this.#roundCommandPreflight(connection, message.requestId, message.data);
		if (preflight !== undefined) return preflight;
		if (connection.phase !== 'room_bound') throw new Error('Round preflight invariant failed.');
		if (!this.#inventoryUploads.abort(connection.connectionId, message.data.uploadId)) {
			return [
				this.#send(
					connection.connectionId,
					createCommandError(message.requestId, 'inventory_stale')
				)
			];
		}
		const aborted = this.#roomDirectory.abortInventorySync(
			connection.binding,
			message.data.libraryGeneration,
			nowMs
		);
		return aborted.ok
			? this.#mapTransition(aborted.effects, aborted.directoryChange)
			: [
					this.#send(
						connection.connectionId,
						createCommandError(message.requestId, toCommandCode(aborted.rejection.code))
					)
				];
	}

	#ackAvailability(
		connection: PostHelloConnection,
		message: Extract<ClientMessage, { type: 'availability_applied' }>,
		nowMs: number
	): readonly Delivery[] {
		const preflight = this.#roundCommandPreflight(connection, message.requestId, message.data);
		if (preflight !== undefined) return preflight;
		if (connection.phase !== 'room_bound') throw new Error('Round preflight invariant failed.');
		const acknowledged = this.#roomDirectory.ackAvailability(
			connection.binding,
			message.data.availabilityRevision,
			nowMs
		);
		return acknowledged.ok
			? this.#mapTransition(acknowledged.effects, acknowledged.directoryChange)
			: [
					this.#send(
						connection.connectionId,
						createCommandError(message.requestId, toCommandCode(acknowledged.rejection.code))
					)
				];
	}

	#resyncAvailability(
		connection: PostHelloConnection,
		message: Extract<ClientMessage, { type: 'availability_resync' }>,
		nowMs: number
	): readonly Delivery[] {
		const preflight = this.#roundCommandPreflight(connection, message.requestId, message.data);
		if (preflight !== undefined) return preflight;
		if (connection.phase !== 'room_bound') throw new Error('Round preflight invariant failed.');
		if (!this.#consumeAvailabilityResync(connection.identity.userId, nowMs)) {
			return [
				this.#send(connection.connectionId, createCommandError(message.requestId, 'rate_limited'))
			];
		}
		const snapshot = this.#roomDirectory.requestAvailabilityReset(connection.binding, nowMs);
		if (!snapshot.ok) {
			return [
				this.#send(
					connection.connectionId,
					createCommandError(message.requestId, toCommandCode(snapshot.rejection.code))
				)
			];
		}
		return this.#availabilityResetDeliveries(
			connection.connectionId,
			message.data.roomId,
			message.data.roomGeneration,
			snapshot.value
		);
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

	#roundCommandPreflight(
		connection: PostHelloConnection,
		requestId: string,
		data: Readonly<{
			roomId: string;
			roomGeneration: number;
			connectionGeneration: number;
		}>
	): readonly Delivery[] | undefined {
		if (!hasRoundsCapability(connection)) {
			return [
				this.#send(
					connection.connectionId,
					createCommandError(requestId, 'rounds_capability_required')
				)
			];
		}
		return this.#roomCommandPreflight(connection, requestId, data);
	}

	#availabilityResetDeliveries(
		connectionId: string,
		roomId: string,
		roomGeneration: number,
		snapshot: AvailabilitySnapshot
	): readonly Delivery[] {
		const plan = planAvailabilityTransfer({
			roomId,
			roomGeneration,
			transferId: this.#newTransferId(),
			targetRevision: snapshot.revision,
			basis: snapshot.basis,
			next: snapshot.inventory,
			forceReset: true
		});
		return [
			this.#send(connectionId, plan.begin),
			...plan.frames.map(
				(bytes): Delivery => ({
					kind: 'send_binary',
					connectionIds: [connectionId],
					bytes
				})
			),
			this.#send(connectionId, plan.commit)
		];
	}

	#consumeAvailabilityResync(userId: string, nowMs: number): boolean {
		const active = (this.#availabilityResyncWindows.get(userId) ?? []).filter(
			(timestamp) => timestamp > nowMs - IDENTITY_LIMIT_WINDOW_MS
		);
		if (active.length >= 12) return false;
		active.push(nowMs);
		this.#availabilityResyncWindows.set(userId, active);
		return true;
	}

	#phase2Placeholder(connection: PostHelloConnection, requestId: string): readonly Delivery[] {
		if (!hasRoundsCapability(connection)) {
			return [
				this.#send(
					connection.connectionId,
					createCommandError(requestId, 'rounds_capability_required')
				)
			];
		}
		if (connection.phase === 'anonymous') {
			return [this.#send(connection.connectionId, createCommandError(requestId, 'auth_required'))];
		}
		if (connection.phase === 'authenticated') {
			return [this.#send(connection.connectionId, createCommandError(requestId, 'not_in_room'))];
		}
		return [
			this.#send(connection.connectionId, createCommandError(requestId, 'launch_stage_stale'))
		];
	}

	#fatal(
		connection: Connection,
		code: FatalErrorCode,
		closeCode: number,
		nowMs: number
	): readonly Delivery[] {
		if (this.#connections.get(connection.connectionId) !== connection) return [];
		const aborted = this.#abortPendingInventory(connection, nowMs);
		this.#connections.delete(connection.connectionId);
		const transition =
			connection.phase === 'room_bound'
				? this.#roomDirectory.disconnect(connection.binding, nowMs)
				: undefined;
		return [
			this.#send(connection.connectionId, createFatalError(code)),
			...aborted,
			...(transition?.ok
				? this.#mapTransition(transition.effects, transition.directoryChange)
				: []),
			{ kind: 'close', connectionId: connection.connectionId, code: closeCode, reason: code }
		];
	}

	#abortPendingInventory(connection: Connection, nowMs: number): readonly Delivery[] {
		const libraryGeneration = this.#inventoryUploads.activeLibraryGeneration(
			connection.connectionId
		);
		this.#inventoryUploads.abortConnection(connection.connectionId);
		if (connection.phase !== 'room_bound' || libraryGeneration === undefined) return [];
		const aborted = this.#roomDirectory.abortInventorySync(
			connection.binding,
			libraryGeneration,
			nowMs
		);
		return aborted.ok ? this.#mapTransition(aborted.effects, aborted.directoryChange) : [];
	}

	#mapTransition(
		effects: readonly RoomEffect[],
		directoryChange?: DirectoryChange
	): readonly Delivery[] {
		for (const effect of effects) {
			if (effect.type !== 'member_left' || effect.invalidatedBinding === undefined) continue;
			const invalidated = effect.invalidatedBinding;
			this.#inventoryUploads.abortConnection(invalidated.connectionId);
			const target = this.#connections.get(invalidated.connectionId);
			if (target?.phase === 'room_bound' && sameBinding(target.binding, invalidated)) {
				this.#replaceConnection<AuthenticatedConnection>(target, {
					phase: 'authenticated',
					identity: target.identity
				});
			}
		}
		const deliveries = effects.flatMap((effect) => this.#mapEffect(effect));
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

	#mapEffect(effect: RoomEffect): readonly Delivery[] {
		const connectionIds = effect.targets.filter((id) => this.#connections.has(id));
		if (connectionIds.length === 0) return [];
		switch (effect.type) {
			case 'member_joined':
				return [
					this.#sendMany(connectionIds, {
						type: 'room_member_joined',
						data: {
							roomId: effect.roomId,
							roomGeneration: effect.roomGeneration,
							member: copyMember(effect.member)
						}
					})
				];
			case 'member_updated':
				return [
					this.#sendMany(connectionIds, {
						type: 'room_member_updated',
						data: {
							roomId: effect.roomId,
							roomGeneration: effect.roomGeneration,
							member: copyMember(effect.member)
						}
					})
				];
			case 'member_left':
				return [
					this.#sendMany(connectionIds, {
						type: 'room_member_left',
						data: {
							roomId: effect.roomId,
							roomGeneration: effect.roomGeneration,
							memberId: effect.memberId,
							reason: effect.reason
						}
					})
				];
			case 'owner_changed':
				return [
					this.#sendMany(connectionIds, {
						type: 'room_owner_changed',
						data: {
							roomId: effect.roomId,
							roomGeneration: effect.roomGeneration,
							ownerMemberId: effect.ownerMemberId
						}
					})
				];
			case 'chat_message':
				return [
					this.#sendMany(connectionIds, {
						type: 'chat_message',
						data: {
							roomId: effect.roomId,
							roomGeneration: effect.roomGeneration,
							message: { ...effect.message }
						}
					})
				];
			case 'availability_changed':
				return effect.recipients.flatMap((recipient) => {
					if (!this.#connections.has(recipient.connectionId)) return [];
					const plan = planAvailabilityTransfer({
						roomId: effect.roomId,
						roomGeneration: effect.roomGeneration,
						transferId: this.#newTransferId(),
						...(recipient.forceReset ? {} : { baseRevision: recipient.baseRevision }),
						targetRevision: effect.targetRevision,
						basis: effect.basis,
						...(effect.previous === undefined ? {} : { previous: effect.previous }),
						next: effect.current,
						forceReset: recipient.forceReset
					});
					return [
						this.#send(recipient.connectionId, plan.begin),
						...plan.frames.map(
							(bytes): Delivery => ({
								kind: 'send_binary',
								connectionIds: [recipient.connectionId],
								bytes
							})
						),
						this.#send(recipient.connectionId, plan.commit)
					];
				});
		}
		return assertNever(effect);
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
			protocolMinor: current.protocolMinor,
			capabilities: current.capabilities,
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
		for (const [userId, timestamps] of this.#availabilityResyncWindows) {
			const active = timestamps.filter((timestamp) => timestamp > nowMs - IDENTITY_LIMIT_WINDOW_MS);
			if (active.length === 0) this.#availabilityResyncWindows.delete(userId);
			else this.#availabilityResyncWindows.set(userId, active);
		}
	}

	#send(connectionId: string, message: ServerMessage): Delivery {
		return this.#sendMany([connectionId], message);
	}

	#sendMany(connectionIds: readonly string[], message: ServerMessage): Delivery {
		return { kind: 'send', connectionIds: [...connectionIds], message };
	}
}

function serverHello(connection: PostHelloConnection, identity?: ArenaIdentity): ServerMessage {
	return {
		type: 'server_hello',
		data: {
			protocolMajor: PROTOCOL_MAJOR,
			protocolMinor: connection.protocolMinor,
			capabilities: [...connection.capabilities],
			...(identity === undefined ? {} : { identity }),
			resume: { status: 'not_requested' }
		}
	};
}

function failedResumeHello(
	connection: PostHelloConnection,
	identity: ArenaIdentity
): ServerMessage {
	return {
		type: 'server_hello',
		data: {
			protocolMajor: PROTOCOL_MAJOR,
			protocolMinor: connection.protocolMinor,
			capabilities: [...connection.capabilities],
			identity,
			resume: {
				status: 'failed',
				code: 'room_resume_failed',
				displayMessageKey: 'arena.error.resumeFailed'
			}
		}
	};
}

function resumedServerHello(
	connection: PostHelloConnection,
	identity: ArenaIdentity,
	room: RoomSnapshot
): ServerMessage {
	return {
		type: 'server_hello',
		data: {
			protocolMajor: PROTOCOL_MAJOR,
			protocolMinor: connection.protocolMinor,
			capabilities: [...connection.capabilities],
			identity,
			resume: { status: 'succeeded', room: copyRoomSnapshot(room) }
		}
	};
}

function negotiate(
	clientMinor: 0 | 1,
	clientCapabilities: readonly string[]
): Readonly<{
	protocolMinor: 0 | 1;
	capabilities: readonly (typeof ROOMS_CAPABILITY | typeof ROUNDS_CAPABILITY)[];
}> {
	const protocolMinor = Math.min(clientMinor, PROTOCOL_MINOR) as 0 | 1;
	const capabilities: (typeof ROOMS_CAPABILITY | typeof ROUNDS_CAPABILITY)[] = [ROOMS_CAPABILITY];
	if (protocolMinor === PROTOCOL_MINOR && clientCapabilities.includes(ROUNDS_CAPABILITY)) {
		capabilities.push(ROUNDS_CAPABILITY);
	}
	return { protocolMinor, capabilities };
}

function hasRoundsCapability(connection: PostHelloConnection): boolean {
	return (
		connection.protocolMinor === PROTOCOL_MINOR &&
		connection.capabilities.includes(ROUNDS_CAPABILITY)
	);
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

function inventoryDeclarationFrom(
	data: Readonly<{
		libraryGeneration: number;
		hashCount: number;
		byteCount: number;
		chunkCount: number;
		vectorDigest: string;
	}>
) {
	return {
		libraryGeneration: data.libraryGeneration,
		hashCount: data.hashCount,
		byteCount: data.byteCount,
		chunkCount: data.chunkCount,
		vectorDigest: data.vectorDigest
	};
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

function assertNever(_value: never): never {
	throw new Error('Unsupported Arena room effect.');
}

function copyRoomSummary(summary: {
	roomId: string;
	name: string;
	phase: 'selecting' | 'loading' | 'playing';
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
