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
	FrozenReplyBasis,
	InventoryCommit,
	JoinRoomInput,
	LoadReport,
	ProbeReport,
	ReclaimSeatInput,
	ReadyCommit,
	ResumeSeatInput,
	RoundAbandonInput,
	RoomDirectoryConfig,
	RoomEffect,
	RoundResultInput,
	RoomTransition,
	SeatAdmission,
	SeatConnectionRef,
	SelectionCommit,
	TelemetryInput,
	TelemetryMutation,
	TerminalMutation,
	UploadAdmission
} from './models.ts';
import {
	addConnectedSeat,
	admissionFor,
	allocateMessageId,
	allocateSeatId,
	connectedTargets,
	copyRoundResult,
	createInitialRoom,
	exactConnectedSeat,
	issueResumeToken,
	liveStandingsFor,
	matchesResumeToken,
	memberFor,
	membersForRoom,
	oldestConnectedSeat,
	summaryFor,
	type RandomBytes,
	type RoomState,
	type SeatState
} from './room.ts';
import {
	beginRoundLoading,
	clearSelection,
	connectionStartAfterMs,
	copyFrozenRound,
	copyFinalResult,
	copySelectionSnapshot,
	copyTelemetry,
	currentRttMs,
	freezeRound,
	recordLoadReply,
	recordProbeReply,
	replaceSelection,
	scheduleRound,
	saturatingIncrementUint32,
	sha256Bytes,
	startLeadMs,
	startRound,
	STANDINGS_INTERVAL_MS,
	terminalEquals
} from './round-state.ts';
import type { RoundLoadingState } from './round-state.ts';
import type {
	ArenaDnfReason,
	ArenaFinalResult,
	LaunchCancellationReason,
	RoundResultSnapshot,
	SelectionSnapshot
} from '../protocol/messages.ts';
import { arenaFinalResultSchema } from '../protocol/messages.ts';
import { buildFinalStandings, validateTelemetryProgression } from './standings.ts';

export interface RoomDirectory {
	list(): DirectorySnapshot;
	create(input: CreateRoomInput): Promise<DomainResult<SeatAdmission>>;
	join(input: JoinRoomInput): Promise<DomainResult<SeatAdmission>>;
	reclaim(input: ReclaimSeatInput): DomainResult<SeatAdmission> | undefined;
	resume(input: ResumeSeatInput): DomainResult<SeatAdmission>;
	leave(actor: SeatConnectionRef, nowMs: number): DomainResult<void>;
	kick(actor: SeatConnectionRef, targetSeatId: string, nowMs: number): DomainResult<void>;
	disconnect(actor: SeatConnectionRef, nowMs: number): DomainResult<void>;
	sendChat(actor: SeatConnectionRef, text: string, nowMs: number): DomainResult<ChatMessage>;
	markInventorySyncing(
		actor: SeatConnectionRef,
		libraryGeneration: number,
		_nowMs: number
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
	select(
		actor: SeatConnectionRef,
		selection: SelectionSnapshot,
		revisions: Readonly<{ availabilityRevision: number; inventoryRevision: number }>,
		nowMs: number
	): DomainResult<SelectionCommit>;
	setReady(
		actor: SeatConnectionRef,
		ready: boolean,
		revisions: Readonly<{
			selectionRevision: number;
			availabilityRevision: number;
			inventoryRevision: number;
		}>,
		nowMs: number
	): DomainResult<ReadyCommit>;
	reportProbe(actor: SeatConnectionRef, report: ProbeReport, nowMs: number): DomainResult<void>;
	reportLoaded(actor: SeatConnectionRef, report: LoadReport, nowMs: number): DomainResult<void>;
	reportTelemetry(
		actor: SeatConnectionRef,
		input: TelemetryInput,
		nowMs: number
	): DomainResult<TelemetryMutation>;
	submitRoundResult(
		actor: SeatConnectionRef,
		input: RoundResultInput,
		nowMs: number
	): DomainResult<TerminalMutation>;
	abandonRound(
		actor: SeatConnectionRef,
		input: RoundAbandonInput,
		nowMs: number
	): DomainResult<TerminalMutation>;
	recordRtt(actor: SeatConnectionRef, rttMs: number, nowMs: number): DomainResult<void>;
	sweep(nowMs: number): readonly RoomTransition[];
	flushDueStandings(nowMs: number): readonly RoomTransition[];
	cancelLaunches(reason: 'server_shutdown'): readonly RoomTransition[];
	clear(): void;
	nextDeadlineMs(): number | undefined;
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

	clear(): void {
		for (const room of this.#rooms.values()) {
			for (const seat of room.seats.values()) {
				if (seat.inventory !== undefined) this.#releaseInventory(seat.inventory);
			}
		}
		this.#rooms.clear();
		this.#connections.clear();
		this.#revision += 1;
	}

	async create(input: CreateRoomInput): Promise<DomainResult<SeatAdmission>> {
		if (this.#connections.has(input.connectionId)) {
			return { ok: false, rejection: { code: 'already_in_room' } };
		}
		if (this.#rooms.size >= (this.#config.maxRooms ?? 1_000)) {
			return { ok: false, rejection: { code: 'server_capacity' } };
		}
		if (input.password !== undefined && input.password.length === 0) {
			return { ok: false, rejection: { code: 'room_password_invalid' } };
		}
		const passwordDigest =
			input.password === undefined ? undefined : await this.#passwordHasher.hash(input.password);
		if (this.#connections.has(input.connectionId)) {
			return { ok: false, rejection: { code: 'already_in_room' } };
		}
		if (this.#rooms.size >= (this.#config.maxRooms ?? 1_000)) {
			return { ok: false, rejection: { code: 'server_capacity' } };
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
		const readyEffects = this.#clearReadyEffects(room);
		const resumeToken = issueResumeToken(this.#randomBytes);
		const seat = addConnectedSeat(room, {
			seatId: allocateSeatId(room, this.#randomBytes),
			connectionId: input.connectionId,
			identity: input.identity,
			resumeTokenDigest: resumeToken.digest
		});
		delete room.commonInventory;
		room.availabilityBasis = [];
		if (room.ownerSeatId === null) {
			room.ownerSeatId = seat.seatId;
		}
		const admission = admissionFor(room, seat, resumeToken.plaintext);
		this.#connections.set(input.connectionId, admission.binding);
		const effects: RoomEffect[] = [
			...readyEffects,
			...(incumbentTargets.length === 0
				? []
				: [
						{
							type: 'member_joined' as const,
							targets: incumbentTargets,
							roomId: room.roomId,
							roomGeneration: room.generation,
							member: memberFor(seat)
						}
					])
		];
		return {
			ok: true,
			value: admission,
			effects,
			directoryChange: this.#upsert(room)
		};
	}

	reclaim(input: ReclaimSeatInput): DomainResult<SeatAdmission> | undefined {
		if (this.#connections.has(input.connectionId)) {
			return { ok: false, rejection: { code: 'already_in_room' } };
		}
		const room = this.#rooms.get(input.roomId);
		if (room === undefined || room.bannedUserIds.has(input.identity.userId)) return undefined;
		const seat = [...room.seats.values()].find(
			(candidate) => candidate.identity.userId === input.identity.userId
		);
		if (seat === undefined) return undefined;
		return this.#rebindSeat(room, seat, input.connectionId, input.identity, input.nowMs, {
			preserveInventory: false
		});
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
		return this.#rebindSeat(room, seat, input.connectionId, input.identity, input.nowMs, {
			preserveInventory: true
		});
	}

	markInventorySyncing(
		actor: SeatConnectionRef,
		libraryGeneration: number,
		nowMs: number
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
		const readyEffects = this.#clearReadyEffects(room);
		seat.pendingLibraryGeneration = libraryGeneration;
		seat.inventoryState = 'syncing';
		seat.ready = false;
		return {
			ok: true,
			value: { libraryGeneration, inventoryState: 'syncing' },
			effects: [...readyEffects, ...this.#memberUpdatedEffects(room, seat)]
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
		const readyEffects = this.#clearReadyEffects(room);
		delete seat.pendingLibraryGeneration;
		seat.inventoryState = seat.inventory === undefined ? 'missing' : 'ready';
		seat.ready = false;
		return {
			ok: true,
			value: undefined,
			effects: [...readyEffects, ...this.#memberUpdatedEffects(room, seat)]
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
		const availabilityEffects = this.#recomputeAvailability(room);
		if (previousInventory !== undefined) this.#releaseInventory(previousInventory);

		return {
			ok: true,
			value: {
				libraryGeneration: seat.libraryGeneration,
				inventoryRevision: seat.inventoryRevision,
				availabilityRevision: room.commonInventory === undefined ? 0 : room.availabilityRevision
			},
			effects: [...this.#memberUpdatedEffects(room, seat), ...availabilityEffects]
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

	select(
		actor: SeatConnectionRef,
		selection: SelectionSnapshot,
		revisions: Readonly<{ availabilityRevision: number; inventoryRevision: number }>,
		_nowMs: number
	): DomainResult<SelectionCommit> {
		const bound = this.#boundSeat(actor);
		if (!bound.ok) return bound;
		const { room, seat } = bound;
		if (room.phase !== 'selecting' || seat.roundState !== 'eligible') {
			return { ok: false, rejection: { code: 'launch_stage_stale' } };
		}
		if (
			room.commonInventory === undefined ||
			revisions.availabilityRevision !== room.availabilityRevision ||
			revisions.inventoryRevision !== seat.inventoryRevision ||
			seat.inventoryState !== 'ready' ||
			seat.inventory === undefined ||
			seat.availabilityAppliedRevision !== room.availabilityRevision
		) {
			return { ok: false, rejection: { code: 'selection_stale' } };
		}

		const hash = sha256Bytes(selection.sha256);
		if (!room.commonInventory.contains(hash)) {
			const missingMemberIds = [...room.seats.values()]
				.filter(
					(candidate) => candidate.inventory === undefined || !candidate.inventory.contains(hash)
				)
				.sort((left, right) => left.joinOrder - right.joinOrder)
				.map((candidate) => candidate.seatId);
			return {
				ok: false,
				rejection: { code: 'selection_not_common', missingMemberIds }
			};
		}

		const next = replaceSelection(room, selection, seat.seatId);
		room.selection = next.selection;
		room.selectionRevision = next.selectionRevision;
		room.selectedByMemberId = next.selectedByMemberId;
		const effects = this.#clearReadyEffects(room);
		effects.push({
			type: 'selection_changed',
			targets: connectedTargets(room),
			roomId: room.roomId,
			roomGeneration: room.generation,
			selectionRevision: room.selectionRevision,
			availabilityRevision: room.availabilityRevision,
			selection: copySelectionSnapshot(room.selection),
			selectedByMemberId: room.selectedByMemberId
		});
		return {
			ok: true,
			value: {
				selection: copySelectionSnapshot(room.selection),
				selectionRevision: room.selectionRevision,
				availabilityRevision: room.availabilityRevision,
				selectedByMemberId: seat.seatId
			},
			effects
		};
	}

	setReady(
		actor: SeatConnectionRef,
		ready: boolean,
		revisions: Readonly<{
			selectionRevision: number;
			availabilityRevision: number;
			inventoryRevision: number;
		}>,
		nowMs: number
	): DomainResult<ReadyCommit> {
		const bound = this.#boundSeat(actor);
		if (!bound.ok) return bound;
		const { room, seat } = bound;
		if (room.phase !== 'selecting' || seat.roundState !== 'eligible') {
			return { ok: false, rejection: { code: 'ready_not_allowed' } };
		}
		if (!ready) {
			seat.ready = false;
			return {
				ok: true,
				value: { ready: false },
				effects: this.#memberUpdatedEffects(room, seat)
			};
		}
		if (
			room.selection === null ||
			room.commonInventory === undefined ||
			revisions.selectionRevision !== room.selectionRevision ||
			revisions.availabilityRevision !== room.availabilityRevision ||
			revisions.inventoryRevision !== seat.inventoryRevision ||
			seat.inventoryState !== 'ready' ||
			seat.inventory === undefined ||
			seat.availabilityAppliedRevision !== room.availabilityRevision
		) {
			return { ok: false, rejection: { code: 'ready_not_allowed' } };
		}

		seat.ready = true;
		const effects = this.#memberUpdatedEffects(room, seat);
		const eligible = [...room.seats.values()].sort(
			(left, right) => left.joinOrder - right.joinOrder
		);
		if (eligible.some((candidate) => candidate.status !== 'connected' || !candidate.ready)) {
			return { ok: true, value: { ready: true }, effects };
		}

		const round = freezeRound({
			roundId: this.#opaqueId(16),
			launchAttemptId: this.#opaqueId(16),
			selection: room.selection,
			selectionRevision: room.selectionRevision,
			availabilityRevision: room.availabilityRevision,
			participants: eligible.map((candidate) => ({
				memberId: candidate.seatId,
				inventoryRevision: candidate.inventoryRevision,
				identity: { ...candidate.identity }
			}))
		});
		const probeNonces = new Set<string>();
		const runtime = beginRoundLoading(
			round,
			eligible.map((candidate) => {
				let probeNonce: string;
				do probeNonce = this.#opaqueId(16);
				while (probeNonces.has(probeNonce));
				probeNonces.add(probeNonce);
				return {
					memberId: candidate.seatId,
					inventoryRevision: candidate.inventoryRevision,
					probeNonce,
					connectionStatus: candidate.status
				};
			}),
			nowMs
		);
		room.roundRuntime = runtime;
		room.round = runtime.round;
		room.phase = 'loading';
		for (const candidate of eligible) {
			candidate.ready = false;
			candidate.roundState = 'probing';
			effects.push(...this.#memberUpdatedEffects(room, candidate));
		}
		effects.push({
			type: 'round_loading_started',
			targets: connectedTargets(room),
			roomId: room.roomId,
			roomGeneration: room.generation,
			round: copyFrozenRound(runtime.round)
		});
		for (const participant of runtime.participants) {
			const candidate = room.seats.get(participant.memberId);
			if (candidate === undefined || candidate.status !== 'connected') {
				throw new Error('Frozen participant disappeared during ready transition.');
			}
			effects.push(this.#probeEffect(room, candidate, runtime));
		}
		return {
			ok: true,
			value: { ready: true, round: copyFrozenRound(runtime.round) },
			effects,
			directoryChange: this.#upsert(room)
		};
	}

	reportProbe(actor: SeatConnectionRef, report: ProbeReport, nowMs: number): DomainResult<void> {
		const bound = this.#boundSeat(actor);
		if (!bound.ok) return bound;
		const { room, seat } = bound;
		const runtime = room.roundRuntime;
		if (runtime === undefined || seat.roundState === 'waiting') {
			return { ok: false, rejection: { code: 'round_stale' } };
		}
		if (!this.#matchesRoundReply(runtime, seat.seatId, report)) {
			return { ok: false, rejection: { code: 'round_stale' } };
		}
		const transition = recordProbeReply(runtime, seat.seatId, report, nowMs);
		if (transition.kind === 'rejected') {
			return { ok: false, rejection: { code: 'launch_stage_stale' } };
		}
		if (transition.kind === 'duplicate') {
			return { ok: true, value: undefined, effects: [] };
		}
		if (transition.kind === 'expired' || transition.kind === 'cancelled') {
			const effects = this.#cancelRound(
				room,
				transition.kind === 'expired' ? 'probe_timeout' : transition.reason
			);
			return {
				ok: true,
				value: undefined,
				effects,
				directoryChange: this.#upsert(room)
			};
		}

		room.roundRuntime = transition.state;
		room.round = transition.state.round;
		if (!transition.barrierComplete) return { ok: true, value: undefined, effects: [] };
		const effects: RoomEffect[] = [];
		for (const participant of transition.state.participants) {
			const candidate = room.seats.get(participant.memberId);
			if (candidate === undefined) continue;
			candidate.roundState = 'loading';
			effects.push(...this.#memberUpdatedEffects(room, candidate));
			if (candidate.status === 'connected') {
				effects.push(this.#loadEffect(room, candidate, transition.state.round));
			}
		}
		return { ok: true, value: undefined, effects };
	}

	reportLoaded(actor: SeatConnectionRef, report: LoadReport, nowMs: number): DomainResult<void> {
		const bound = this.#boundSeat(actor);
		if (!bound.ok) return bound;
		const { room, seat } = bound;
		const runtime = room.roundRuntime;
		if (runtime === undefined || seat.roundState === 'waiting') {
			return { ok: false, rejection: { code: 'round_stale' } };
		}
		if (!this.#matchesRoundReply(runtime, seat.seatId, report)) {
			return { ok: false, rejection: { code: 'round_stale' } };
		}
		const transition = recordLoadReply(runtime, seat.seatId, report, nowMs);
		if (transition.kind === 'rejected') {
			return { ok: false, rejection: { code: 'launch_stage_stale' } };
		}
		if (transition.kind === 'duplicate') {
			return { ok: true, value: undefined, effects: [] };
		}
		if (transition.kind === 'expired' || transition.kind === 'cancelled') {
			const effects = this.#cancelRound(
				room,
				transition.kind === 'expired' ? 'load_timeout' : transition.reason
			);
			return {
				ok: true,
				value: undefined,
				effects,
				directoryChange: this.#upsert(room)
			};
		}

		room.roundRuntime = transition.state;
		room.round = transition.state.round;
		seat.roundState = 'loaded';
		const effects = this.#memberUpdatedEffects(room, seat);
		if (!transition.barrierComplete) return { ok: true, value: undefined, effects };
		effects.push(...this.#scheduleRound(room, nowMs));
		return { ok: true, value: undefined, effects };
	}

	reportTelemetry(
		actor: SeatConnectionRef,
		input: TelemetryInput,
		nowMs: number
	): DomainResult<TelemetryMutation> {
		const bound = this.#boundSeat(actor);
		if (!bound.ok) return bound;
		const { room, seat } = bound;
		const deadline = this.#expirePlayDeadline(room, nowMs);
		if (deadline !== undefined) {
			return {
				ok: false,
				rejection: { code: 'round_stale' },
				effects: deadline.effects,
				directoryChange: this.#upsert(room)
			};
		}
		const runtime = room.roundRuntime;
		const participantIndex = runtime?.participants.findIndex(
			(candidate) => candidate.memberId === seat.seatId
		);
		if (runtime === undefined || participantIndex === undefined || participantIndex < 0) {
			return { ok: false, rejection: { code: 'round_stale' } };
		}
		if (
			input.roundId !== runtime.round.roundId ||
			input.launchAttemptId !== runtime.round.launchAttemptId
		) {
			return { ok: true, value: { status: 'ignored' }, effects: [] };
		}
		const participant = runtime.participants[participantIndex]!;
		if (
			participant.terminal !== undefined ||
			(participant.telemetry !== undefined &&
				input.telemetry.sequence <= participant.telemetry.sequence)
		) {
			return { ok: true, value: { status: 'ignored' }, effects: [] };
		}

		const limit = participant.limiter.attempt(nowMs);
		if (limit !== 'allow') {
			return {
				ok: true,
				value:
					limit === 'close'
						? { status: 'close', closeCode: 1008, reason: 'rate_limited' }
						: { status: 'dropped' },
				effects: []
			};
		}
		if (
			runtime.round.stage !== 'playing' ||
			!validateTelemetryProgression(participant.telemetry, input.telemetry)
		) {
			const violation = participant.limiter.violation(nowMs);
			return {
				ok: true,
				value:
					violation === 'close'
						? { status: 'close', closeCode: 1008, reason: 'rate_limited' }
						: { status: 'dropped' },
				effects: []
			};
		}

		const participants = runtime.participants.map((candidate, index) =>
			index === participantIndex
				? { ...candidate, telemetry: copyTelemetry(input.telemetry) }
				: candidate
		);
		const updated = this.#dirtyStandings({ ...runtime, participants }, nowMs, 'immediate');
		room.roundRuntime = updated;
		return {
			ok: true,
			value: {
				status: 'accepted',
				standingsRevision: updated.standingsRevision
			},
			effects: []
		};
	}

	submitRoundResult(
		actor: SeatConnectionRef,
		input: RoundResultInput,
		nowMs: number
	): DomainResult<TerminalMutation> {
		return this.#acceptTerminal(actor, input, { kind: 'finished', result: input.result }, nowMs);
	}

	abandonRound(
		actor: SeatConnectionRef,
		input: RoundAbandonInput,
		nowMs: number
	): DomainResult<TerminalMutation> {
		return this.#acceptTerminal(actor, input, { kind: 'dnf', reason: input.reason }, nowMs);
	}

	recordRtt(actor: SeatConnectionRef, rttMs: number, nowMs: number): DomainResult<void> {
		const bound = this.#boundSeat(actor);
		if (!bound.ok) return bound;
		if (!Number.isSafeInteger(rttMs) || rttMs < 0) {
			return { ok: false, rejection: { code: 'launch_stage_stale' } };
		}
		bound.seat.rttSamples = [...bound.seat.rttSamples, { sampledAtMs: nowMs, rttMs }].slice(-8);
		return { ok: true, value: undefined, effects: [] };
	}

	leave(actor: SeatConnectionRef, nowMs: number): DomainResult<void> {
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

		const playingParticipant = this.#isPlayingParticipant(room, seat.seatId);
		if (playingParticipant) {
			this.#setParticipantConnectionStatus(room, seat.seatId, 'reserved', nowMs);
			this.#setLifecycleTerminal(room, seat.seatId, 'left', nowMs);
		}
		const cancellationEffects =
			!playingParticipant && this.#isFrozenParticipant(room, seat.seatId)
				? this.#cancelRound(room, 'participant_left')
				: [];
		const targets = connectedTargets(room);
		const wasOwner = room.ownerSeatId === seat.seatId;
		room.seats.delete(seat.seatId);
		if (seat.inventory !== undefined) this.#releaseInventory(seat.inventory);
		this.#connections.delete(seat.connectionId);
		const effects: RoomEffect[] = [
			...cancellationEffects,
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
		let finalized:
			| Readonly<{ effects: readonly RoomEffect[]; result: RoundResultSnapshot }>
			| undefined;
		if (room.seats.size === 0) {
			finalized = playingParticipant ? this.#finalizeRound(room, nowMs) : undefined;
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
			effects.push(...this.#recomputeAvailability(room));
			finalized = playingParticipant ? this.#finalizeRound(room, nowMs) : undefined;
			directoryChange = this.#upsert(room);
		}
		if (finalized !== undefined) effects.unshift(...finalized.effects);

		return {
			ok: true,
			value: undefined,
			effects,
			directoryChange
		};
	}

	kick(actor: SeatConnectionRef, targetSeatId: string, nowMs: number): DomainResult<void> {
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

		const playingParticipant = this.#isPlayingParticipant(room, target.seatId);
		if (playingParticipant) {
			this.#setParticipantConnectionStatus(room, target.seatId, 'reserved', nowMs);
			this.#setLifecycleTerminal(room, target.seatId, 'kicked', nowMs);
		}
		const cancellationEffects =
			!playingParticipant && this.#isFrozenParticipant(room, target.seatId)
				? this.#cancelRound(room, 'participant_kicked')
				: [];
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
			...cancellationEffects,
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
		effects.push(...this.#recomputeAvailability(room));
		const finalized = playingParticipant ? this.#finalizeRound(room, nowMs) : undefined;
		if (finalized !== undefined) effects.unshift(...finalized.effects);

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
		seat.ready = false;
		seat.status = 'reserved';
		seat.reservedUntilMs = nowMs + this.#config.reconnectGraceMs;
		this.#setParticipantConnectionStatus(room, seat.seatId, 'reserved', nowMs);
		this.#connections.delete(seat.connectionId);
		if (wasOwner) room.ownerSeatId = oldestConnectedSeat(room)?.seatId ?? null;
		const targets = connectedTargets(room);
		const effects: RoomEffect[] = [];
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
			const runtime = room.roundRuntime;
			if (runtime?.round.stage === 'playing' && nowMs >= runtime.round.playDeadlineAtServerMs) {
				const finalized = this.#expirePlayDeadline(room, nowMs);
				if (finalized !== undefined) {
					transitions.push({
						effects: finalized.effects,
						directoryChange: this.#upsert(room)
					});
				}
			} else if (runtime?.round.stage === 'probing' && nowMs >= runtime.probeDeadlineMs) {
				transitions.push({
					effects: this.#cancelRound(room, 'probe_timeout'),
					directoryChange: this.#upsert(room)
				});
			} else if (
				runtime?.round.stage === 'loading' &&
				runtime.loadDeadlineMs !== undefined &&
				nowMs >= runtime.loadDeadlineMs
			) {
				transitions.push({
					effects: this.#cancelRound(room, 'load_timeout'),
					directoryChange: this.#upsert(room)
				});
			} else if (
				runtime?.round.stage === 'scheduled' &&
				runtime.startAtServerMs !== undefined &&
				nowMs >= runtime.startAtServerMs
			) {
				const playing = startRound(runtime);
				if (playing.round.stage !== 'playing') {
					throw new Error('Arena start transition did not enter Playing.');
				}
				room.roundRuntime = playing;
				room.round = playing.round;
				room.phase = 'playing';
				const effects: RoomEffect[] = [];
				for (const participant of playing.participants) {
					const seat = room.seats.get(participant.memberId);
					if (seat === undefined) continue;
					seat.roundState = 'playing';
					effects.push(...this.#memberUpdatedEffects(room, seat));
				}
				effects.push({
					type: 'round_started',
					targets: connectedTargets(room),
					roomId: room.roomId,
					roomGeneration: room.generation,
					roundId: playing.round.roundId,
					launchAttemptId: playing.round.launchAttemptId,
					playDeadlineAtServerMs: playing.round.playDeadlineAtServerMs
				});
				transitions.push({ effects, directoryChange: this.#upsert(room) });
			}
			const expiredSeats = [...room.seats.values()]
				.filter(
					(seat) =>
						seat.status === 'reserved' &&
						seat.reservedUntilMs !== undefined &&
						nowMs >= seat.reservedUntilMs
				)
				.sort((left, right) => left.joinOrder - right.joinOrder);
			for (const seat of expiredSeats) {
				const wasPlayingParticipant =
					room.roundRuntime?.round.stage === 'playing' &&
					room.roundRuntime.participants.some(
						(participant) => participant.memberId === seat.seatId
					);
				if (wasPlayingParticipant) {
					this.#setParticipantConnectionStatus(room, seat.seatId, 'reserved', nowMs);
					this.#setLifecycleTerminal(room, seat.seatId, 'grace_expired', nowMs);
				}
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
				const finalized = wasPlayingParticipant ? this.#finalizeRound(room, nowMs) : undefined;
				if (finalized !== undefined) effects.unshift(...finalized.effects);
				if (room.seats.size === 0) {
					this.#rooms.delete(room.roomId);
					directoryChange = this.#remove(room.roomId);
				} else {
					effects.push(...this.#recomputeAvailability(room));
					directoryChange = this.#upsert(room);
				}
				transitions.push({ effects, directoryChange });
			}
		}
		return transitions;
	}

	flushDueStandings(nowMs: number): readonly RoomTransition[] {
		const transitions: RoomTransition[] = [];
		for (const room of this.#rooms.values()) {
			const runtime = room.roundRuntime;
			if (
				runtime?.round.stage !== 'playing' ||
				runtime.nextStandingsFlushMs === undefined ||
				nowMs < runtime.nextStandingsFlushMs
			) {
				continue;
			}
			const snapshot = liveStandingsFor(room);
			if (snapshot === null) continue;
			room.roundRuntime = {
				...runtime,
				lastStandingsFlushMs: nowMs,
				nextStandingsFlushMs: undefined
			};
			transitions.push({
				effects: [
					{
						type: 'round_standings',
						targets: connectedTargets(room),
						snapshot
					}
				]
			});
		}
		return transitions;
	}

	nextDeadlineMs(): number | undefined {
		let earliest: number | undefined;
		for (const room of this.#rooms.values()) {
			const runtime = room.roundRuntime;
			if (runtime !== undefined) {
				const deadline =
					runtime.round.stage === 'probing'
						? runtime.probeDeadlineMs
						: runtime.round.stage === 'loading'
							? runtime.loadDeadlineMs
							: runtime.round.stage === 'scheduled'
								? runtime.startAtServerMs
								: 'playDeadlineAtServerMs' in runtime.round
									? runtime.round.playDeadlineAtServerMs
									: undefined;
				for (const candidate of [deadline, runtime.nextStandingsFlushMs]) {
					if (candidate !== undefined && (earliest === undefined || candidate < earliest)) {
						earliest = candidate;
					}
				}
			}
			for (const seat of room.seats.values()) {
				if (
					seat.status === 'reserved' &&
					seat.reservedUntilMs !== undefined &&
					(earliest === undefined || seat.reservedUntilMs < earliest)
				) {
					earliest = seat.reservedUntilMs;
				}
			}
		}
		return earliest;
	}

	cancelLaunches(reason: 'server_shutdown'): readonly RoomTransition[] {
		const transitions: RoomTransition[] = [];
		for (const room of this.#rooms.values()) {
			if (room.roundRuntime === undefined || room.roundRuntime.round.stage === 'playing') continue;
			transitions.push({
				effects: this.#cancelRound(room, reason),
				directoryChange: this.#upsert(room)
			});
		}
		return transitions;
	}

	#acceptTerminal(
		actor: SeatConnectionRef,
		input: Readonly<{ roundId: string; launchAttemptId: string }>,
		terminal:
			| Readonly<{ kind: 'finished'; result: ArenaFinalResult }>
			| Readonly<{ kind: 'dnf'; reason: ArenaDnfReason }>,
		nowMs: number
	): DomainResult<TerminalMutation> {
		const bound = this.#boundSeat(actor);
		if (!bound.ok) return bound;
		const { room, seat } = bound;
		const deadline = this.#expirePlayDeadline(room, nowMs);
		if (deadline !== undefined) {
			return {
				ok: false,
				rejection: { code: 'round_already_terminal' },
				effects: deadline.effects,
				directoryChange: this.#upsert(room)
			};
		}
		const runtime = room.roundRuntime;
		const participantIndex = runtime?.participants.findIndex(
			(candidate) => candidate.memberId === seat.seatId
		);
		if (
			runtime?.round.stage !== 'playing' ||
			participantIndex === undefined ||
			participantIndex < 0 ||
			input.roundId !== runtime.round.roundId ||
			input.launchAttemptId !== runtime.round.launchAttemptId
		) {
			return { ok: false, rejection: { code: 'round_stale' } };
		}
		const participant = runtime.participants[participantIndex]!;
		if (participant.terminal !== undefined) {
			if (!terminalEquals(participant.terminal, terminal)) {
				return { ok: false, rejection: { code: 'round_already_terminal' } };
			}
			return {
				ok: true,
				value: {
					status: 'identical_retry',
					terminal: terminal.kind,
					standingsRevision: runtime.standingsRevision
				},
				effects: []
			};
		}

		const attempts = participant.terminalAttemptTimes.filter(
			(timestamp) => timestamp > nowMs - 60_000
		);
		if (attempts.length >= 8) {
			return { ok: false, rejection: { code: 'rate_limited' } };
		}
		const attemptedParticipant = {
			...participant,
			terminalAttemptTimes: [...attempts, nowMs].slice(-8)
		};
		let attemptedRuntime: RoundLoadingState = {
			...runtime,
			participants: runtime.participants.map((candidate, index) =>
				index === participantIndex ? attemptedParticipant : candidate
			)
		};
		room.roundRuntime = attemptedRuntime;

		if (
			terminal.kind === 'finished' &&
			(!arenaFinalResultSchema.safeParse(terminal.result).success ||
				!this.#finalDoesNotRegress(participant, terminal.result))
		) {
			return { ok: false, rejection: { code: 'result_invalid' } };
		}

		const acceptedTerminal =
			terminal.kind === 'finished'
				? { kind: 'finished' as const, result: copyFinalResult(terminal.result) }
				: { kind: 'dnf' as const, reason: terminal.reason };
		attemptedRuntime = this.#dirtyStandings(
			{
				...attemptedRuntime,
				participants: attemptedRuntime.participants.map((candidate, index) =>
					index === participantIndex ? { ...candidate, terminal: acceptedTerminal } : candidate
				)
			},
			nowMs
		);
		room.roundRuntime = attemptedRuntime;
		const standingsRevision = attemptedRuntime.standingsRevision;
		const finalized = this.#finalizeRound(room, nowMs);
		return {
			ok: true,
			value: {
				status: 'accepted',
				terminal: terminal.kind,
				standingsRevision,
				...(finalized === undefined ? {} : { finalized: finalized.result })
			},
			effects: finalized?.effects ?? [],
			...(finalized === undefined ? {} : { directoryChange: this.#upsert(room) })
		};
	}

	#finalDoesNotRegress(
		participant: RoundLoadingState['participants'][number],
		result: ArenaFinalResult
	): boolean {
		const telemetry = participant.telemetry;
		if (telemetry === undefined) return true;
		return (
			result.exScore >= telemetry.exScore &&
			result.maxCombo >= telemetry.maxCombo &&
			result.badPoorCount >= telemetry.badPoorCount &&
			result.judgements.perfect >= telemetry.judgements.perfect &&
			result.judgements.great >= telemetry.judgements.great &&
			result.judgements.good >= telemetry.judgements.good &&
			result.judgements.bad >= telemetry.judgements.bad &&
			result.judgements.poor >= telemetry.judgements.poor &&
			result.judgements.emptyPoor >= telemetry.judgements.emptyPoor
		);
	}

	#dirtyStandings(
		runtime: RoundLoadingState,
		nowMs: number,
		delivery: 'coalesced' | 'immediate' = 'coalesced'
	): RoundLoadingState {
		const nextStandingsFlushMs =
			delivery === 'immediate'
				? nowMs
				: (runtime.nextStandingsFlushMs ??
					(runtime.lastStandingsFlushMs === undefined
						? nowMs
						: Math.max(nowMs, runtime.lastStandingsFlushMs + STANDINGS_INTERVAL_MS)));
		return {
			...runtime,
			standingsRevision: runtime.standingsRevision + 1,
			nextStandingsFlushMs
		};
	}

	#setParticipantConnectionStatus(
		room: RoomState,
		memberId: string,
		status: 'connected' | 'reserved',
		nowMs: number
	): void {
		const runtime = room.roundRuntime;
		const index = runtime?.participants.findIndex((candidate) => candidate.memberId === memberId);
		if (runtime === undefined || index === undefined || index < 0) return;
		const participant = runtime.participants[index]!;
		if (participant.connectionStatus === status) return;
		let updated: RoundLoadingState = {
			...runtime,
			participants: runtime.participants.map((candidate, candidateIndex) =>
				candidateIndex === index ? { ...candidate, connectionStatus: status } : candidate
			)
		};
		if (runtime.round.stage === 'playing') updated = this.#dirtyStandings(updated, nowMs);
		room.roundRuntime = updated;
	}

	#setLifecycleTerminal(
		room: RoomState,
		memberId: string,
		reason: Extract<ArenaDnfReason, 'left' | 'kicked' | 'grace_expired' | 'play_deadline'>,
		nowMs: number
	): boolean {
		const runtime = room.roundRuntime;
		if (runtime?.round.stage !== 'playing') return false;
		const index = runtime.participants.findIndex((candidate) => candidate.memberId === memberId);
		const participant = runtime.participants[index];
		if (participant === undefined || participant.terminal !== undefined) return false;
		room.roundRuntime = this.#dirtyStandings(
			{
				...runtime,
				participants: runtime.participants.map((candidate, candidateIndex) =>
					candidateIndex === index
						? { ...candidate, terminal: { kind: 'dnf' as const, reason } }
						: candidate
				)
			},
			nowMs
		);
		return true;
	}

	#expirePlayDeadline(
		room: RoomState,
		nowMs: number
	): Readonly<{ effects: readonly RoomEffect[]; result: RoundResultSnapshot }> | undefined {
		const runtime = room.roundRuntime;
		if (runtime?.round.stage !== 'playing' || nowMs < runtime.round.playDeadlineAtServerMs) {
			return undefined;
		}
		for (const participant of runtime.participants) {
			this.#setLifecycleTerminal(room, participant.memberId, 'play_deadline', nowMs);
		}
		return this.#finalizeRound(room, nowMs);
	}

	#finalizeRound(
		room: RoomState,
		nowMs: number
	): Readonly<{ effects: readonly RoomEffect[]; result: RoundResultSnapshot }> | undefined {
		const runtime = room.roundRuntime;
		if (
			runtime?.round.stage !== 'playing' ||
			runtime.participants.some((participant) => participant.terminal === undefined)
		) {
			return undefined;
		}
		const ranked = buildFinalStandings(runtime.participants);
		if (runtime.participants.length >= 2) {
			for (const memberId of ranked.winnerMemberIds) {
				const winner = room.seats.get(memberId);
				if (winner !== undefined) winner.lobbyWins = saturatingIncrementUint32(winner.lobbyWins);
			}
		}
		const result: RoundResultSnapshot = {
			resultRevision: ++room.resultRevision,
			roundId: runtime.round.roundId,
			selectionRevision: runtime.round.selectionRevision,
			finalizedAtServerMs: nowMs,
			participantCount: runtime.participants.length,
			selection: copySelectionSnapshot(runtime.round.selection),
			winnerMemberIds: [...ranked.winnerMemberIds],
			entries: ranked.entries.map((entry) => ({
				...entry,
				identity: { ...entry.identity },
				lobbyWinsAfter: room.seats.get(entry.memberId)?.lobbyWins ?? null
			}))
		};
		room.lastRoundResult = copyRoundResult(result);
		const roundId = runtime.round.roundId;
		const launchAttemptId = runtime.round.launchAttemptId;
		room.phase = 'selecting';
		delete room.round;
		delete room.roundRuntime;
		for (const seat of room.seats.values()) {
			seat.ready = false;
			seat.roundState = 'eligible';
		}
		const cleared = clearSelection(room);
		room.selection = cleared.selection;
		room.selectionRevision = cleared.selectionRevision;
		room.selectedByMemberId = cleared.selectedByMemberId;
		const targets = connectedTargets(room);
		const members = membersForRoom(room);
		const effects: RoomEffect[] = [
			{
				type: 'round_finalized',
				targets,
				roomId: room.roomId,
				roomGeneration: room.generation,
				roundId,
				launchAttemptId,
				result: copyRoundResult(result),
				members
			}
		];
		for (const seat of room.seats.values()) effects.push(...this.#memberUpdatedEffects(room, seat));
		effects.push({
			type: 'selection_changed',
			targets,
			roomId: room.roomId,
			roomGeneration: room.generation,
			selectionRevision: room.selectionRevision,
			availabilityRevision: room.availabilityRevision,
			selection: null,
			selectedByMemberId: null
		});
		return { effects, result: copyRoundResult(result) };
	}

	#rebindSeat(
		room: RoomState,
		seat: SeatState,
		connectionId: string,
		identity: ReclaimSeatInput['identity'],
		nowMs: number,
		options: Readonly<{ preserveInventory: boolean }>
	): DomainResult<SeatAdmission> {
		const staleConnectionId = seat.connectionId;
		const incumbentTargets = connectedTargets(room).filter(
			(target) => target !== staleConnectionId
		);
		let rotatedToken = issueResumeToken(this.#randomBytes);
		while (matchesResumeToken(rotatedToken.plaintext, seat.resumeTokenDigest)) {
			rotatedToken = issueResumeToken(this.#randomBytes);
		}

		this.#connections.delete(staleConnectionId);
		seat.identity = identity;
		seat.connectionId = connectionId;
		seat.connectionGeneration += 1;
		seat.resumeTokenDigest = rotatedToken.digest;
		seat.status = 'connected';
		seat.ready = false;
		seat.rttSamples = [];
		if (!options.preserveInventory) {
			const previousInventory = seat.inventory;
			delete seat.inventory;
			delete seat.pendingLibraryGeneration;
			seat.inventoryState = 'missing';
			seat.inventoryRevision = 0;
			seat.libraryGeneration = 0;
			seat.availabilityAppliedRevision = 0;
			delete room.commonInventory;
			room.availabilityBasis = [];
			if (previousInventory !== undefined) this.#releaseInventory(previousInventory);
		} else if (seat.pendingLibraryGeneration !== undefined) {
			delete seat.pendingLibraryGeneration;
			seat.inventoryState = seat.inventory === undefined ? 'missing' : 'ready';
		}
		delete seat.reservedUntilMs;
		this.#setParticipantConnectionStatus(room, seat.seatId, 'connected', nowMs);
		const ownerChanged = room.ownerSeatId === null;
		if (ownerChanged) room.ownerSeatId = seat.seatId;
		const readyEffects = options.preserveInventory ? [] : this.#clearReadyEffects(room);

		const admission: SeatAdmission = {
			...admissionFor(room, seat, rotatedToken.plaintext),
			staleConnectionId
		};
		this.#connections.set(connectionId, admission.binding);
		const effects: RoomEffect[] = [...readyEffects];
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
		const runtime = room.roundRuntime;
		const participant = runtime?.participants.find(
			(candidate) => candidate.memberId === seat.seatId
		);
		if (runtime !== undefined && participant !== undefined) {
			if (runtime.round.stage === 'probing' && participant.probeAnswer === undefined) {
				effects.push(this.#probeEffect(room, seat, runtime));
			} else if (runtime.round.stage === 'loading' && participant.loadAnswer === undefined) {
				effects.push(this.#loadEffect(room, seat, runtime.round));
			} else if (runtime.round.stage === 'loading') {
				effects.push(...this.#scheduleRound(room, nowMs));
			} else if (runtime.round.stage === 'scheduled' && runtime.startAtServerMs !== undefined) {
				effects.push({
					type: 'round_start_scheduled',
					targets: [seat.connectionId],
					roomId: room.roomId,
					roomGeneration: room.generation,
					connectionGeneration: seat.connectionGeneration,
					roundId: runtime.round.roundId,
					launchAttemptId: runtime.round.launchAttemptId,
					startAtServerMs: runtime.startAtServerMs,
					startAfterMs: connectionStartAfterMs(runtime.startAtServerMs, nowMs, undefined),
					playDeadlineAtServerMs: runtime.round.playDeadlineAtServerMs
				});
			}
		}

		return {
			ok: true,
			value: admission,
			effects,
			directoryChange: this.#upsert(room)
		};
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

	#probeEffect(
		room: RoomState,
		seat: SeatState,
		runtime: RoundLoadingState
	): Extract<RoomEffect, { type: 'round_probe_requested' }> {
		const participant = runtime.participants.find(
			(candidate) => candidate.memberId === seat.seatId
		);
		if (participant === undefined) throw new Error('Probe effect requires a frozen participant.');
		return {
			type: 'round_probe_requested',
			targets: [seat.connectionId],
			roomId: room.roomId,
			roomGeneration: room.generation,
			connectionGeneration: seat.connectionGeneration,
			roundId: runtime.round.roundId,
			launchAttemptId: runtime.round.launchAttemptId,
			selectionRevision: runtime.round.selectionRevision,
			availabilityRevision: runtime.round.availabilityRevision,
			inventoryRevision: participant.inventoryRevision,
			nonce: participant.probeNonce,
			sha256: runtime.round.selection.sha256,
			deadlineMs: runtime.probeDeadlineMs
		};
	}

	#matchesRoundReply(
		runtime: RoundLoadingState,
		memberId: string,
		report: FrozenReplyBasis
	): boolean {
		const participant = runtime.participants.find((candidate) => candidate.memberId === memberId);
		return (
			participant !== undefined &&
			report.roundId === runtime.round.roundId &&
			report.launchAttemptId === runtime.round.launchAttemptId &&
			report.selectionRevision === runtime.round.selectionRevision &&
			report.availabilityRevision === runtime.round.availabilityRevision &&
			report.inventoryRevision === participant.inventoryRevision
		);
	}

	#loadEffect(
		room: RoomState,
		seat: SeatState,
		round: NonNullable<RoomState['round']>
	): Extract<RoomEffect, { type: 'round_load_requested' }> {
		return {
			type: 'round_load_requested',
			targets: [seat.connectionId],
			roomId: room.roomId,
			roomGeneration: room.generation,
			connectionGeneration: seat.connectionGeneration,
			round: copyFrozenRound(round)
		};
	}

	#scheduleRound(room: RoomState, nowMs: number): RoomEffect[] {
		const runtime = room.roundRuntime;
		if (
			runtime === undefined ||
			runtime.round.stage !== 'loading' ||
			!runtime.participants.every((participant) => participant.loadAnswer?.ok === true)
		) {
			return [];
		}
		const seats = runtime.participants.map((participant) => room.seats.get(participant.memberId));
		if (seats.some((seat) => seat === undefined || seat.status !== 'connected')) return [];
		const connected = seats.filter((seat): seat is SeatState => seat !== undefined);
		const rtts = connected.map((seat) => currentRttMs(seat.rttSamples, nowMs));
		const startAtServerMs = nowMs + startLeadMs(rtts);
		const scheduled = scheduleRound(runtime, startAtServerMs);
		if (scheduled.round.stage !== 'scheduled') {
			throw new Error('Arena schedule transition did not enter Scheduled.');
		}
		const playDeadlineAtServerMs = scheduled.round.playDeadlineAtServerMs;
		room.roundRuntime = scheduled;
		room.round = scheduled.round;
		return connected.map((seat, index) => ({
			type: 'round_start_scheduled' as const,
			targets: [seat.connectionId] as const,
			roomId: room.roomId,
			roomGeneration: room.generation,
			connectionGeneration: seat.connectionGeneration,
			roundId: scheduled.round.roundId,
			launchAttemptId: scheduled.round.launchAttemptId,
			startAtServerMs,
			startAfterMs: connectionStartAfterMs(startAtServerMs, nowMs, rtts[index]),
			playDeadlineAtServerMs
		}));
	}

	#cancelRound(room: RoomState, reason: LaunchCancellationReason): RoomEffect[] {
		const runtime = room.roundRuntime;
		if (runtime === undefined) return [];
		const roundId = runtime.round.roundId;
		const launchAttemptId = runtime.round.launchAttemptId;
		const alwaysClear = new Set<LaunchCancellationReason>([
			'missing_file',
			'hash_mismatch',
			'read_failed',
			'parse_failed',
			'unsupported_config',
			'resource_failed',
			'chart_length_mismatch'
		]);
		const remainsCommon =
			room.selection !== null &&
			room.commonInventory !== undefined &&
			room.commonInventory.contains(sha256Bytes(room.selection.sha256));
		const clear = room.selection !== null && (alwaysClear.has(reason) || !remainsCommon);
		if (clear) {
			const next = clearSelection(room);
			room.selection = next.selection;
			room.selectionRevision = next.selectionRevision;
			room.selectedByMemberId = next.selectedByMemberId;
		}
		room.phase = 'selecting';
		delete room.round;
		delete room.roundRuntime;
		for (const seat of room.seats.values()) {
			seat.ready = false;
			seat.roundState = 'eligible';
		}
		const targets = connectedTargets(room);
		const effects: RoomEffect[] = [...room.seats.values()].flatMap((seat) =>
			this.#memberUpdatedEffects(room, seat)
		);
		if (clear) {
			effects.push({
				type: 'selection_changed',
				targets,
				roomId: room.roomId,
				roomGeneration: room.generation,
				selectionRevision: room.selectionRevision,
				availabilityRevision: room.availabilityRevision,
				selection: null,
				selectedByMemberId: null
			});
		}
		effects.push({
			type: 'round_launch_cancelled',
			targets,
			roomId: room.roomId,
			roomGeneration: room.generation,
			roundId,
			launchAttemptId,
			reason,
			selection: room.selection === null ? null : copySelectionSnapshot(room.selection),
			selectionRevision: room.selectionRevision,
			availabilityRevision: room.availabilityRevision
		});
		return effects;
	}

	#isFrozenParticipant(room: RoomState, seatId: string): boolean {
		return (
			room.roundRuntime !== undefined &&
			room.roundRuntime.round.stage !== 'playing' &&
			room.roundRuntime.participants.some((participant) => participant.memberId === seatId)
		);
	}

	#isPlayingParticipant(room: RoomState, seatId: string): boolean {
		return (
			room.roundRuntime?.round.stage === 'playing' &&
			room.roundRuntime.participants.some((participant) => participant.memberId === seatId)
		);
	}

	#clearReadyEffects(room: RoomState): RoomEffect[] {
		const changed = [...room.seats.values()].filter((seat) => seat.ready);
		for (const seat of changed) seat.ready = false;
		const targets = connectedTargets(room);
		if (targets.length === 0) return [];
		return changed.map((seat) => ({
			type: 'member_updated' as const,
			targets,
			roomId: room.roomId,
			roomGeneration: room.generation,
			member: memberFor(seat)
		}));
	}

	#recomputeAvailability(room: RoomState): RoomEffect[] {
		const seats = [...room.seats.values()];
		const readyEffects = this.#clearReadyEffects(room);
		if (seats.length === 0 || seats.some((seat) => seat.inventory === undefined)) {
			delete room.commonInventory;
			room.availabilityBasis = [];
			return readyEffects;
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
		const recipients = seats
			.filter((seat) => seat.status === 'connected')
			.map((seat) => ({
				connectionId: seat.connectionId,
				baseRevision: seat.availabilityAppliedRevision,
				forceReset: previous === undefined || seat.availabilityAppliedRevision !== previousRevision
			}));
		const effects: RoomEffect[] = [
			{
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
			}
		];
		effects.push(...readyEffects);
		if (room.selection !== null && !current.contains(sha256Bytes(room.selection.sha256))) {
			const next = clearSelection(room);
			room.selection = next.selection;
			room.selectionRevision = next.selectionRevision;
			room.selectedByMemberId = next.selectedByMemberId;
			effects.push({
				type: 'selection_changed',
				targets: connectedTargets(room),
				roomId: room.roomId,
				roomGeneration: room.generation,
				selectionRevision: room.selectionRevision,
				availabilityRevision: room.availabilityRevision,
				selection: null,
				selectedByMemberId: null
			});
		}
		return effects;
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
