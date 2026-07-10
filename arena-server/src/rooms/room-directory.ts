import type { PasswordHasher } from './password-hasher.ts';
import { PackedInventory } from '../inventory/packed-inventory.ts';
import type {
	AvailabilityChangedEffect,
	AvailabilitySnapshot,
	ChatMessage,
	CreateRoomInput,
	DirectoryChange,
	DirectorySnapshot,
	DomainResult,
	InventoryCommit,
	JoinRoomInput,
	ResumeSeatInput,
	RoomDirectoryConfig,
	RoomEffect,
	RoomTransition,
	SeatAdmission,
	SeatConnectionRef,
	UploadAdmission
} from './models.ts';
import {
	addConnectedSeat,
	admissionFor,
	allocateMessageId,
	allocateSeatId,
	connectedTargets,
	createInitialRoom,
	exactConnectedSeat,
	issueResumeToken,
	matchesResumeToken,
	memberFor,
	oldestConnectedSeat,
	summaryFor,
	type RandomBytes,
	type RoomState,
	type SeatState
} from './room.ts';

export interface RoomDirectory {
	list(): DirectorySnapshot;
	create(input: CreateRoomInput): Promise<DomainResult<SeatAdmission>>;
	join(input: JoinRoomInput): Promise<DomainResult<SeatAdmission>>;
	resume(input: ResumeSeatInput): DomainResult<SeatAdmission>;
	leave(actor: SeatConnectionRef, nowMs: number): DomainResult<void>;
	kick(actor: SeatConnectionRef, targetSeatId: string, nowMs: number): DomainResult<void>;
	disconnect(actor: SeatConnectionRef, nowMs: number): DomainResult<void>;
	sendChat(actor: SeatConnectionRef, text: string, nowMs: number): DomainResult<ChatMessage>;
	markInventorySyncing(
		actor: SeatConnectionRef,
		libraryGeneration: number,
		nowMs: number
	): DomainResult<UploadAdmission>;
	abortInventorySync(
		actor: SeatConnectionRef,
		libraryGeneration: number,
		nowMs: number
	): DomainResult<void>;
	replaceInventory(
		actor: SeatConnectionRef,
		input: Readonly<{ libraryGeneration: number }>,
		inventory: PackedInventory,
		nowMs: number
	): DomainResult<InventoryCommit>;
	ackAvailability(actor: SeatConnectionRef, revision: number, nowMs: number): DomainResult<void>;
	requestAvailabilityReset(
		actor: SeatConnectionRef,
		nowMs: number
	): DomainResult<AvailabilitySnapshot>;
	sweep(nowMs: number): readonly RoomTransition[];
}

class InMemoryRoomDirectory implements RoomDirectory {
	readonly #config: RoomDirectoryConfig;
	readonly #passwordHasher: PasswordHasher;
	readonly #randomBytes: RandomBytes;
	readonly #releaseInventory: (inventory: PackedInventory) => void;
	readonly #rooms = new Map<string, RoomState>();
	readonly #issuedRoomIds = new Set<string>();
	readonly #connections = new Map<string, SeatConnectionRef>();
	#revision = 0;
	#nextRoomGeneration = 1;

	constructor(
		config: RoomDirectoryConfig,
		passwordHasher: PasswordHasher,
		randomBytes: RandomBytes,
		releaseInventory: (inventory: PackedInventory) => void
	) {
		this.#config = config;
		this.#passwordHasher = passwordHasher;
		this.#randomBytes = randomBytes;
		this.#releaseInventory = releaseInventory;
	}

	list(): DirectorySnapshot {
		return {
			revision: this.#revision,
			rooms: [...this.#rooms.values()]
				.map(summaryFor)
				.sort((left, right) => left.roomId.localeCompare(right.roomId))
		};
	}

	async create(input: CreateRoomInput): Promise<DomainResult<SeatAdmission>> {
		if (this.#connections.has(input.connectionId)) {
			return { ok: false, rejection: { code: 'already_in_room' } };
		}
		if (input.password !== undefined && input.password.length === 0) {
			return { ok: false, rejection: { code: 'room_password_invalid' } };
		}
		const passwordDigest =
			input.password === undefined ? undefined : await this.#passwordHasher.hash(input.password);
		if (this.#connections.has(input.connectionId)) {
			return { ok: false, rejection: { code: 'already_in_room' } };
		}

		const roomId = this.#allocateRoomId();
		const seatId = this.#opaqueId(16);
		const resumeToken = issueResumeToken(this.#randomBytes);
		const { room, admission } = createInitialRoom({
			roomId,
			roomGeneration: this.#nextRoomGeneration++,
			seatId,
			connectionId: input.connectionId,
			identity: input.identity,
			name: input.name,
			passwordDigest,
			resumeToken
		});
		this.#rooms.set(roomId, room);
		this.#connections.set(input.connectionId, admission.binding);
		return {
			ok: true,
			value: admission,
			effects: [],
			directoryChange: this.#upsert(room)
		};
	}

	async join(input: JoinRoomInput): Promise<DomainResult<SeatAdmission>> {
		if (this.#connections.has(input.connectionId)) {
			return { ok: false, rejection: { code: 'already_in_room' } };
		}
		const room = this.#rooms.get(input.roomId);
		if (room === undefined) {
			return { ok: false, rejection: { code: 'room_not_found' } };
		}
		if (room.passwordDigest !== undefined) {
			if (input.password === undefined || input.password.length === 0) {
				return { ok: false, rejection: { code: 'room_password_invalid' } };
			}
			if (!(await this.#passwordHasher.verify(input.password, room.passwordDigest))) {
				return { ok: false, rejection: { code: 'room_password_invalid' } };
			}
			if (this.#rooms.get(input.roomId) !== room) {
				return { ok: false, rejection: { code: 'room_not_found' } };
			}
			if (this.#connections.has(input.connectionId)) {
				return { ok: false, rejection: { code: 'already_in_room' } };
			}
		}
		if (room.bannedUserIds.has(input.identity.userId)) {
			return { ok: false, rejection: { code: 'room_banned' } };
		}
		if ([...room.seats.values()].some((seat) => seat.identity.userId === input.identity.userId)) {
			return { ok: false, rejection: { code: 'room_duplicate_identity' } };
		}
		if (room.seats.size >= this.#config.roomCapacity) {
			return { ok: false, rejection: { code: 'room_full' } };
		}

		const incumbentTargets = connectedTargets(room);
		const resumeToken = issueResumeToken(this.#randomBytes);
		const seat = addConnectedSeat(room, {
			seatId: allocateSeatId(room, this.#randomBytes),
			connectionId: input.connectionId,
			identity: input.identity,
			resumeTokenDigest: resumeToken.digest
		});
		delete room.commonInventory;
		room.availabilityBasis = [];
		for (const existingSeat of room.seats.values()) existingSeat.ready = false;
		if (room.ownerSeatId === null) {
			room.ownerSeatId = seat.seatId;
		}
		const admission = admissionFor(room, seat, resumeToken.plaintext);
		this.#connections.set(input.connectionId, admission.binding);
		const effects: RoomEffect[] =
			incumbentTargets.length === 0
				? []
				: [
						{
							type: 'member_joined',
							targets: incumbentTargets,
							roomId: room.roomId,
							roomGeneration: room.generation,
							member: memberFor(seat)
						}
					];
		return {
			ok: true,
			value: admission,
			effects,
			directoryChange: this.#upsert(room)
		};
	}

	resume(input: ResumeSeatInput): DomainResult<SeatAdmission> {
		if (this.#connections.has(input.connectionId)) {
			return { ok: false, rejection: { code: 'room_resume_failed' } };
		}
		const room = this.#rooms.get(input.roomId);
		if (room === undefined || room.bannedUserIds.has(input.identity.userId)) {
			return { ok: false, rejection: { code: 'room_resume_failed' } };
		}
		const seat = [...room.seats.values()].find(
			(candidate) => candidate.identity.userId === input.identity.userId
		);
		if (
			seat === undefined ||
			seat.status !== 'reserved' ||
			seat.reservedUntilMs === undefined ||
			input.nowMs >= seat.reservedUntilMs ||
			!matchesResumeToken(input.resumeToken, seat.resumeTokenDigest)
		) {
			return { ok: false, rejection: { code: 'room_resume_failed' } };
		}

		const incumbentTargets = connectedTargets(room);
		const staleConnectionId = seat.connectionId;
		let rotatedToken = issueResumeToken(this.#randomBytes);
		while (matchesResumeToken(rotatedToken.plaintext, seat.resumeTokenDigest)) {
			rotatedToken = issueResumeToken(this.#randomBytes);
		}
		seat.identity = input.identity;
		seat.connectionId = input.connectionId;
		seat.connectionGeneration += 1;
		seat.resumeTokenDigest = rotatedToken.digest;
		seat.status = 'connected';
		delete seat.reservedUntilMs;
		const ownerChanged = room.ownerSeatId === null;
		if (ownerChanged) room.ownerSeatId = seat.seatId;

		const baseAdmission = admissionFor(room, seat, rotatedToken.plaintext);
		const admission: SeatAdmission = {
			...baseAdmission,
			...(staleConnectionId === input.connectionId ? {} : { staleConnectionId })
		};
		this.#connections.set(input.connectionId, admission.binding);
		const effects: RoomEffect[] = [];
		if (incumbentTargets.length > 0) {
			effects.push({
				type: 'member_updated',
				targets: incumbentTargets,
				roomId: room.roomId,
				roomGeneration: room.generation,
				member: memberFor(seat)
			});
			if (ownerChanged) {
				effects.push({
					type: 'owner_changed',
					targets: incumbentTargets,
					roomId: room.roomId,
					roomGeneration: room.generation,
					ownerMemberId: room.ownerSeatId
				});
			}
		}
		const availabilityReset = this.#availabilityResetEffect(room, seat);
		if (availabilityReset !== undefined) effects.push(availabilityReset);

		return {
			ok: true,
			value: admission,
			effects,
			directoryChange: this.#upsert(room)
		};
	}

	markInventorySyncing(
		actor: SeatConnectionRef,
		libraryGeneration: number,
		_nowMs: number
	): DomainResult<UploadAdmission> {
		const bound = this.#boundSeat(actor);
		if (!bound.ok) return bound;
		const { room, seat } = bound;
		if (
			!Number.isSafeInteger(libraryGeneration) ||
			libraryGeneration <= seat.libraryGeneration ||
			(seat.pendingLibraryGeneration !== undefined &&
				libraryGeneration <= seat.pendingLibraryGeneration)
		) {
			return { ok: false, rejection: { code: 'inventory_stale' } };
		}
		seat.pendingLibraryGeneration = libraryGeneration;
		seat.inventoryState = 'syncing';
		seat.ready = false;
		return {
			ok: true,
			value: { libraryGeneration, inventoryState: 'syncing' },
			effects: this.#memberUpdatedEffects(room, seat)
		};
	}

	abortInventorySync(
		actor: SeatConnectionRef,
		libraryGeneration: number,
		_nowMs: number
	): DomainResult<void> {
		const bound = this.#boundSeat(actor);
		if (!bound.ok) return bound;
		const { room, seat } = bound;
		if (seat.pendingLibraryGeneration !== libraryGeneration) {
			return { ok: false, rejection: { code: 'inventory_stale' } };
		}
		delete seat.pendingLibraryGeneration;
		seat.inventoryState = seat.inventory === undefined ? 'missing' : 'ready';
		seat.ready = false;
		return {
			ok: true,
			value: undefined,
			effects: this.#memberUpdatedEffects(room, seat)
		};
	}

	replaceInventory(
		actor: SeatConnectionRef,
		input: Readonly<{ libraryGeneration: number }>,
		inventory: PackedInventory,
		_nowMs: number
	): DomainResult<InventoryCommit> {
		const bound = this.#boundSeat(actor);
		if (!bound.ok) return bound;
		const { room, seat } = bound;
		if (
			seat.pendingLibraryGeneration !== input.libraryGeneration ||
			input.libraryGeneration <= seat.libraryGeneration
		) {
			return { ok: false, rejection: { code: 'inventory_stale' } };
		}

		const previousInventory = seat.inventory;
		seat.inventory = inventory;
		seat.libraryGeneration = input.libraryGeneration;
		seat.inventoryRevision = room.nextInventoryRevision++;
		seat.inventoryState = 'ready';
		seat.ready = false;
		delete seat.pendingLibraryGeneration;
		const availabilityEffect = this.#recomputeAvailability(room);
		if (previousInventory !== undefined) this.#releaseInventory(previousInventory);

		return {
			ok: true,
			value: {
				libraryGeneration: seat.libraryGeneration,
				inventoryRevision: seat.inventoryRevision,
				availabilityRevision: room.commonInventory === undefined ? 0 : room.availabilityRevision
			},
			effects: [
				...this.#memberUpdatedEffects(room, seat),
				...(availabilityEffect === undefined ? [] : [availabilityEffect])
			]
		};
	}

	ackAvailability(actor: SeatConnectionRef, revision: number, _nowMs: number): DomainResult<void> {
		const bound = this.#boundSeat(actor);
		if (!bound.ok) return bound;
		const { room, seat } = bound;
		if (room.commonInventory === undefined || revision !== room.availabilityRevision) {
			return { ok: false, rejection: { code: 'availability_stale' } };
		}
		seat.availabilityAppliedRevision = revision;
		return {
			ok: true,
			value: undefined,
			effects: this.#memberUpdatedEffects(room, seat)
		};
	}

	requestAvailabilityReset(
		actor: SeatConnectionRef,
		_nowMs: number
	): DomainResult<AvailabilitySnapshot> {
		const bound = this.#boundSeat(actor);
		if (!bound.ok) return bound;
		const { room } = bound;
		if (room.commonInventory === undefined || room.availabilityRevision === 0) {
			return { ok: false, rejection: { code: 'availability_stale' } };
		}
		return {
			ok: true,
			value: {
				revision: room.availabilityRevision,
				basis: room.availabilityBasis.map((entry) => ({ ...entry })),
				inventory: room.commonInventory
			},
			effects: []
		};
	}

	leave(actor: SeatConnectionRef, _nowMs: number): DomainResult<void> {
		const room = this.#rooms.get(actor.roomId);
		if (room === undefined) {
			return { ok: false, rejection: { code: 'room_not_found' } };
		}
		if (actor.roomGeneration !== room.generation) {
			return { ok: false, rejection: { code: 'room_generation_stale' } };
		}
		const seat = exactConnectedSeat(room, actor);
		if (seat === undefined)
			return { ok: false, rejection: { code: 'connection_generation_stale' } };

		const targets = connectedTargets(room);
		const wasOwner = room.ownerSeatId === seat.seatId;
		room.seats.delete(seat.seatId);
		if (seat.inventory !== undefined) this.#releaseInventory(seat.inventory);
		this.#connections.delete(seat.connectionId);
		const effects: RoomEffect[] = [
			{
				type: 'member_left' as const,
				targets,
				roomId: room.roomId,
				roomGeneration: room.generation,
				memberId: seat.seatId,
				reason: 'left' as const
			}
		];

		let directoryChange: DirectoryChange;
		if (room.seats.size === 0) {
			this.#rooms.delete(room.roomId);
			directoryChange = this.#remove(room.roomId);
		} else {
			if (wasOwner) {
				room.ownerSeatId = oldestConnectedSeat(room)?.seatId ?? null;
				const ownerTargets = connectedTargets(room);
				if (ownerTargets.length > 0) {
					effects.push({
						type: 'owner_changed',
						targets: ownerTargets,
						roomId: room.roomId,
						roomGeneration: room.generation,
						ownerMemberId: room.ownerSeatId
					});
				}
			}
			const availabilityEffect = this.#recomputeAvailability(room);
			if (availabilityEffect !== undefined) effects.push(availabilityEffect);
			directoryChange = this.#upsert(room);
		}

		return {
			ok: true,
			value: undefined,
			effects,
			directoryChange
		};
	}

	kick(actor: SeatConnectionRef, targetSeatId: string, _nowMs: number): DomainResult<void> {
		const room = this.#rooms.get(actor.roomId);
		if (room === undefined) {
			return { ok: false, rejection: { code: 'room_not_found' } };
		}
		if (actor.roomGeneration !== room.generation) {
			return { ok: false, rejection: { code: 'room_generation_stale' } };
		}
		const actorSeat = exactConnectedSeat(room, actor);
		if (actorSeat === undefined) {
			return { ok: false, rejection: { code: 'connection_generation_stale' } };
		}
		if (room.ownerSeatId !== actorSeat.seatId) {
			return { ok: false, rejection: { code: 'permission_denied' } };
		}
		if (targetSeatId === actorSeat.seatId) {
			return { ok: false, rejection: { code: 'cannot_kick_self' } };
		}
		const target = room.seats.get(targetSeatId);
		if (target === undefined) {
			return { ok: false, rejection: { code: 'target_not_found' } };
		}

		const targets = connectedTargets(room);
		const invalidatedBinding: SeatConnectionRef | undefined =
			target.status === 'connected'
				? {
						roomId: room.roomId,
						roomGeneration: room.generation,
						seatId: target.seatId,
						connectionId: target.connectionId,
						connectionGeneration: target.connectionGeneration,
						userId: target.identity.userId
					}
				: undefined;
		room.seats.delete(target.seatId);
		if (target.inventory !== undefined) this.#releaseInventory(target.inventory);
		room.bannedUserIds.add(target.identity.userId);
		if (target.status === 'connected') this.#connections.delete(target.connectionId);

		const effects: RoomEffect[] = [
			{
				type: 'member_left',
				targets,
				roomId: room.roomId,
				roomGeneration: room.generation,
				memberId: target.seatId,
				reason: 'kicked',
				...(invalidatedBinding === undefined ? {} : { invalidatedBinding })
			}
		];
		const availabilityEffect = this.#recomputeAvailability(room);
		if (availabilityEffect !== undefined) effects.push(availabilityEffect);

		return {
			ok: true,
			value: undefined,
			effects,
			directoryChange: this.#upsert(room)
		};
	}

	disconnect(actor: SeatConnectionRef, nowMs: number): DomainResult<void> {
		const noOp = { ok: true as const, value: undefined, effects: [] as const };
		const room = this.#rooms.get(actor.roomId);
		if (room === undefined || actor.roomGeneration !== room.generation) return noOp;
		const seat = exactConnectedSeat(room, actor);
		if (seat === undefined) return noOp;

		const wasOwner = room.ownerSeatId === seat.seatId;
		seat.status = 'reserved';
		seat.reservedUntilMs = nowMs + this.#config.reconnectGraceMs;
		this.#connections.delete(seat.connectionId);
		if (wasOwner) room.ownerSeatId = oldestConnectedSeat(room)?.seatId ?? null;
		const targets = connectedTargets(room);
		const effects = [] as Array<
			| {
					type: 'member_updated';
					targets: readonly string[];
					roomId: string;
					roomGeneration: number;
					member: ReturnType<typeof memberFor>;
			  }
			| {
					type: 'owner_changed';
					targets: readonly string[];
					roomId: string;
					roomGeneration: number;
					ownerMemberId: string | null;
			  }
		>;
		if (targets.length > 0) {
			effects.push({
				type: 'member_updated',
				targets,
				roomId: room.roomId,
				roomGeneration: room.generation,
				member: memberFor(seat)
			});
			if (wasOwner) {
				effects.push({
					type: 'owner_changed',
					targets,
					roomId: room.roomId,
					roomGeneration: room.generation,
					ownerMemberId: room.ownerSeatId
				});
			}
		}

		return {
			ok: true,
			value: undefined,
			effects,
			directoryChange: this.#upsert(room)
		};
	}

	sendChat(actor: SeatConnectionRef, text: string, nowMs: number): DomainResult<ChatMessage> {
		const room = this.#rooms.get(actor.roomId);
		if (room === undefined) {
			return { ok: false, rejection: { code: 'room_not_found' } };
		}
		if (actor.roomGeneration !== room.generation) {
			return { ok: false, rejection: { code: 'room_generation_stale' } };
		}
		const seat = exactConnectedSeat(room, actor);
		if (seat === undefined) {
			return { ok: false, rejection: { code: 'connection_generation_stale' } };
		}

		const trimmed = text.trim();
		if (trimmed.length === 0) {
			return { ok: false, rejection: { code: 'chat_empty' } };
		}
		if (Array.from(trimmed).length > 500) {
			return { ok: false, rejection: { code: 'chat_too_long' } };
		}
		const activeTimestamps = seat.acceptedChatTimes.filter(
			(timestamp) => timestamp > nowMs - 10_000
		);
		if (activeTimestamps.length >= 5) {
			return { ok: false, rejection: { code: 'rate_limited' } };
		}

		const message: ChatMessage = {
			messageId: allocateMessageId(room, this.#randomBytes),
			authorMemberId: seat.seatId,
			authorDisplayName: seat.identity.displayName,
			sentAtMs: nowMs,
			text: trimmed
		};
		seat.acceptedChatTimes = [...activeTimestamps, nowMs];
		room.chat.push(message);
		if (room.chat.length > this.#config.chatBacklog) {
			room.chat.splice(0, room.chat.length - this.#config.chatBacklog);
		}

		return {
			ok: true,
			value: message,
			effects: [
				{
					type: 'chat_message',
					targets: connectedTargets(room),
					roomId: room.roomId,
					roomGeneration: room.generation,
					message
				}
			]
		};
	}

	sweep(nowMs: number): readonly RoomTransition[] {
		const transitions: RoomTransition[] = [];
		for (const room of [...this.#rooms.values()]) {
			const expiredSeats = [...room.seats.values()]
				.filter(
					(seat) =>
						seat.status === 'reserved' &&
						seat.reservedUntilMs !== undefined &&
						nowMs >= seat.reservedUntilMs
				)
				.sort((left, right) => left.joinOrder - right.joinOrder);
			for (const seat of expiredSeats) {
				if (!room.seats.delete(seat.seatId)) continue;
				if (seat.inventory !== undefined) this.#releaseInventory(seat.inventory);
				const targets = connectedTargets(room);
				const effects: RoomEffect[] =
					targets.length === 0
						? []
						: [
								{
									type: 'member_left' as const,
									targets,
									roomId: room.roomId,
									roomGeneration: room.generation,
									memberId: seat.seatId,
									reason: 'grace_expired' as const
								}
							];
				let directoryChange: DirectoryChange;
				if (room.seats.size === 0) {
					this.#rooms.delete(room.roomId);
					directoryChange = this.#remove(room.roomId);
				} else {
					const availabilityEffect = this.#recomputeAvailability(room);
					if (availabilityEffect !== undefined) effects.push(availabilityEffect);
					directoryChange = this.#upsert(room);
				}
				transitions.push({ effects, directoryChange });
			}
		}
		return transitions;
	}

	#boundSeat(actor: SeatConnectionRef):
		| Readonly<{ ok: true; room: RoomState; seat: SeatState }>
		| Readonly<{
				ok: false;
				rejection: {
					code: 'room_not_found' | 'room_generation_stale' | 'connection_generation_stale';
				};
		  }> {
		const room = this.#rooms.get(actor.roomId);
		if (room === undefined) return { ok: false, rejection: { code: 'room_not_found' } };
		if (room.generation !== actor.roomGeneration) {
			return { ok: false, rejection: { code: 'room_generation_stale' } };
		}
		const seat = exactConnectedSeat(room, actor);
		if (seat === undefined) {
			return { ok: false, rejection: { code: 'connection_generation_stale' } };
		}
		return { ok: true, room, seat };
	}

	#memberUpdatedEffects(room: RoomState, seat: SeatState): RoomEffect[] {
		const targets = connectedTargets(room);
		return targets.length === 0
			? []
			: [
					{
						type: 'member_updated',
						targets,
						roomId: room.roomId,
						roomGeneration: room.generation,
						member: memberFor(seat)
					}
				];
	}

	#recomputeAvailability(room: RoomState): AvailabilityChangedEffect | undefined {
		const seats = [...room.seats.values()];
		if (seats.length === 0 || seats.some((seat) => seat.inventory === undefined)) {
			delete room.commonInventory;
			room.availabilityBasis = [];
			return undefined;
		}
		const previous = room.commonInventory;
		const previousRevision = room.availabilityRevision;
		const current = PackedInventory.intersectAll(
			seats
				.map((seat) => seat.inventory)
				.filter((value): value is PackedInventory => value !== undefined)
		);
		const basis = seats
			.map((seat) => ({ memberId: seat.seatId, inventoryRevision: seat.inventoryRevision }))
			.sort((left, right) => left.memberId.localeCompare(right.memberId));
		room.commonInventory = current;
		room.availabilityBasis = basis;
		room.availabilityRevision += 1;
		for (const seat of seats) seat.ready = false;
		const recipients = seats
			.filter((seat) => seat.status === 'connected')
			.map((seat) => ({
				connectionId: seat.connectionId,
				baseRevision: seat.availabilityAppliedRevision,
				forceReset: previous === undefined || seat.availabilityAppliedRevision !== previousRevision
			}));
		return {
			type: 'availability_changed',
			targets: recipients.map((recipient) => recipient.connectionId),
			roomId: room.roomId,
			roomGeneration: room.generation,
			previousRevision,
			targetRevision: room.availabilityRevision,
			basis: basis.map((entry) => ({ ...entry })),
			...(previous === undefined ? {} : { previous }),
			current,
			recipients
		};
	}

	#availabilityResetEffect(
		room: RoomState,
		seat: SeatState
	): AvailabilityChangedEffect | undefined {
		if (room.commonInventory === undefined || room.availabilityRevision === 0) return undefined;
		return {
			type: 'availability_changed',
			targets: [seat.connectionId],
			roomId: room.roomId,
			roomGeneration: room.generation,
			previousRevision: room.availabilityRevision,
			targetRevision: room.availabilityRevision,
			basis: room.availabilityBasis.map((entry) => ({ ...entry })),
			previous: room.commonInventory,
			current: room.commonInventory,
			recipients: [
				{
					connectionId: seat.connectionId,
					baseRevision: seat.availabilityAppliedRevision,
					forceReset: true
				}
			]
		};
	}

	#opaqueId(length: number): string {
		return Buffer.from(this.#randomBytes(length)).toString('base64url');
	}

	#allocateRoomId(): string {
		for (;;) {
			const roomId = this.#opaqueId(16);
			if (!this.#issuedRoomIds.has(roomId)) {
				this.#issuedRoomIds.add(roomId);
				return roomId;
			}
		}
	}

	#upsert(room: RoomState): DirectoryChange {
		return {
			revision: ++this.#revision,
			upserts: [summaryFor(room)],
			removedRoomIds: []
		};
	}

	#remove(roomId: string): DirectoryChange {
		return {
			revision: ++this.#revision,
			upserts: [],
			removedRoomIds: [roomId]
		};
	}
}

function secureRandomBytes(length: number): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(length));
}

export function createRoomDirectory(
	config: RoomDirectoryConfig,
	passwordHasher: PasswordHasher,
	releaseInventory: (inventory: PackedInventory) => void = () => undefined
): RoomDirectory {
	return new InMemoryRoomDirectory(config, passwordHasher, secureRandomBytes, releaseInventory);
}

// Package-internal construction seam. Tests import this path directly; application code uses the
// production factory above, so deterministic entropy never widens the RoomDirectory interface.
export function createRoomDirectoryWithEntropy(
	config: RoomDirectoryConfig,
	passwordHasher: PasswordHasher,
	randomBytes: RandomBytes,
	releaseInventory: (inventory: PackedInventory) => void = () => undefined
): RoomDirectory {
	return new InMemoryRoomDirectory(config, passwordHasher, randomBytes, releaseInventory);
}
