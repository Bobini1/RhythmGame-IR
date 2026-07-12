import { createHash, timingSafeEqual } from 'node:crypto';

import type { ArenaIdentity } from '../auth/identity.ts';
import type { PackedInventory } from '../inventory/packed-inventory.ts';
import type {
	CompetitionFrozenRound,
	LiveStandingsSnapshot,
	RoundResultSnapshot,
	SelectionSnapshot
} from '../protocol/messages.ts';
import { copyFrozenRound, copySelectionSnapshot, type RoundLoadingState } from './round-state.ts';
import { buildLiveStandings } from './standings.ts';
import type {
	ChatMessage,
	RoomMember,
	RoomSnapshot,
	RoomSummary,
	SeatAdmission,
	SeatConnectionRef
} from './models.ts';

export type RandomBytes = (length: number) => Uint8Array;

export type SeatState = {
	seatId: string;
	identity: ArenaIdentity;
	joinOrder: number;
	connectionGeneration: number;
	connectionId: string;
	resumeTokenDigest: Uint8Array;
	lobbyWins: number;
	status: 'connected' | 'reserved';
	ready: boolean;
	inventoryState: 'missing' | 'syncing' | 'ready';
	inventoryRevision: number;
	libraryGeneration: number;
	pendingLibraryGeneration?: number;
	inventory?: PackedInventory;
	availabilityAppliedRevision: number;
	roundState: 'eligible' | 'waiting' | 'probing' | 'loading' | 'loaded' | 'playing';
	rttSamples: Array<Readonly<{ sampledAtMs: number; rttMs: number }>>;
	reservedUntilMs?: number;
	acceptedChatTimes: number[];
};

export type RoomState = {
	readonly roomId: string;
	readonly generation: number;
	readonly name: string;
	readonly maxCount: 32;
	readonly passwordDigest: string | undefined;
	ownerSeatId: string | null;
	readonly seats: Map<string, SeatState>;
	readonly issuedSeatIds: Set<string>;
	readonly bannedUserIds: Set<string>;
	readonly issuedMessageIds: Set<string>;
	nextJoinOrder: number;
	readonly chat: ChatMessage[];
	phase: 'selecting' | 'loading' | 'playing';
	selection: SelectionSnapshot | null;
	selectionRevision: number;
	selectedByMemberId: string | null;
	availabilityRevision: number;
	availabilityBasis: Array<Readonly<{ memberId: string; inventoryRevision: number }>>;
	commonInventory?: PackedInventory;
	nextInventoryRevision: number;
	round?: CompetitionFrozenRound;
	roundRuntime?: RoundLoadingState;
	resultRevision: number;
	lastRoundResult?: RoundResultSnapshot;
};

function encodeOpaque(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64url');
}

function digestResumeToken(token: string): Uint8Array {
	return createHash('sha256').update(token, 'utf8').digest();
}

export function issueResumeToken(randomBytes: RandomBytes): Readonly<{
	plaintext: string;
	digest: Uint8Array;
}> {
	const plaintext = encodeOpaque(randomBytes(32));
	return { plaintext, digest: digestResumeToken(plaintext) };
}

export function matchesResumeToken(token: string, expectedDigest: Uint8Array): boolean {
	const actualDigest = digestResumeToken(token);
	return (
		actualDigest.byteLength === expectedDigest.byteLength &&
		timingSafeEqual(actualDigest, expectedDigest)
	);
}

export function createInitialRoom(
	input: Readonly<{
		roomId: string;
		roomGeneration: number;
		seatId: string;
		connectionId: string;
		identity: ArenaIdentity;
		name: string;
		passwordDigest?: string;
		resumeToken: Readonly<{ plaintext: string; digest: Uint8Array }>;
	}>
): Readonly<{ room: RoomState; admission: SeatAdmission }> {
	const seat: SeatState = {
		seatId: input.seatId,
		identity: input.identity,
		joinOrder: 1,
		connectionGeneration: 1,
		connectionId: input.connectionId,
		resumeTokenDigest: input.resumeToken.digest,
		lobbyWins: 0,
		status: 'connected',
		ready: false,
		inventoryState: 'missing',
		inventoryRevision: 0,
		libraryGeneration: 0,
		availabilityAppliedRevision: 0,
		roundState: 'eligible',
		rttSamples: [],
		acceptedChatTimes: []
	};
	const room: RoomState = {
		roomId: input.roomId,
		generation: input.roomGeneration,
		name: input.name,
		maxCount: 32,
		passwordDigest: input.passwordDigest,
		ownerSeatId: input.seatId,
		seats: new Map([[input.seatId, seat]]),
		issuedSeatIds: new Set([input.seatId]),
		bannedUserIds: new Set(),
		issuedMessageIds: new Set(),
		nextJoinOrder: 2,
		chat: [],
		phase: 'selecting',
		selection: null,
		selectionRevision: 0,
		selectedByMemberId: null,
		availabilityRevision: 0,
		availabilityBasis: [],
		nextInventoryRevision: 1,
		resultRevision: 0
	};
	return {
		room,
		admission: admissionFor(room, seat, input.resumeToken.plaintext)
	};
}

function memberView(seat: SeatState): RoomMember {
	return {
		memberId: seat.seatId,
		identity: { ...seat.identity },
		status: seat.status,
		lobbyWins: seat.lobbyWins,
		ready: seat.ready,
		inventoryState: seat.inventoryState,
		inventoryRevision: seat.inventoryRevision,
		availabilityAppliedRevision: seat.availabilityAppliedRevision,
		roundState: seat.roundState
	};
}

export function memberFor(seat: SeatState): RoomMember {
	return memberView(seat);
}

export function membersForRoom(room: RoomState): readonly RoomMember[] {
	return [...room.seats.values()].sort((a, b) => a.joinOrder - b.joinOrder).map(memberView);
}

export function liveStandingsFor(room: RoomState): LiveStandingsSnapshot | null {
	const runtime = room.roundRuntime;
	if (room.phase !== 'playing' || runtime?.round.stage !== 'playing') return null;
	return {
		roomId: room.roomId,
		roomGeneration: room.generation,
		roundId: runtime.round.roundId,
		launchAttemptId: runtime.round.launchAttemptId,
		standingsRevision: runtime.standingsRevision,
		entries: [...buildLiveStandings(runtime.participants)]
	};
}

export function copyRoundResult(result: RoundResultSnapshot): RoundResultSnapshot {
	return {
		resultRevision: result.resultRevision,
		roundId: result.roundId,
		selectionRevision: result.selectionRevision,
		finalizedAtServerMs: result.finalizedAtServerMs,
		participantCount: result.participantCount,
		selection: copySelectionSnapshot(result.selection),
		winnerMemberIds: [...result.winnerMemberIds],
		entries: result.entries.map((entry) =>
			entry.competitionState === 'finished'
				? {
						...entry,
						identity: { ...entry.identity },
						result: {
							...entry.result,
							judgements: { ...entry.result.judgements },
							finalGauge: { ...entry.result.finalGauge }
						}
					}
				: { ...entry, identity: { ...entry.identity } }
		)
	};
}

export function summaryFor(room: RoomState): RoomSummary {
	return {
		roomId: room.roomId,
		name: room.name,
		phase: room.phase,
		hasPassword: room.passwordDigest !== undefined,
		connectedCount: [...room.seats.values()].filter((seat) => seat.status === 'connected').length,
		reservedCount: [...room.seats.values()].filter((seat) => seat.status === 'reserved').length,
		maxCount: room.maxCount,
		members: [...room.seats.values()]
			.sort((left, right) => left.joinOrder - right.joinOrder)
			.map((seat) => ({
				displayName: seat.identity.displayName,
				avatarUrl: seat.identity.avatarUrl,
				connected: seat.status === 'connected'
			}))
	};
}

export function connectedSeats(room: RoomState): SeatState[] {
	return [...room.seats.values()]
		.filter((seat) => seat.status === 'connected')
		.sort((a, b) => a.joinOrder - b.joinOrder);
}

export function connectedTargets(room: RoomState): string[] {
	return connectedSeats(room).map((seat) => seat.connectionId);
}

export function allocateSeatId(room: RoomState, randomBytes: RandomBytes): string {
	for (;;) {
		const seatId = encodeOpaque(randomBytes(16));
		if (!room.issuedSeatIds.has(seatId)) {
			room.issuedSeatIds.add(seatId);
			return seatId;
		}
	}
}

export function addConnectedSeat(
	room: RoomState,
	input: Readonly<{
		seatId: string;
		connectionId: string;
		identity: ArenaIdentity;
		resumeTokenDigest: Uint8Array;
	}>
): SeatState {
	const seat: SeatState = {
		seatId: input.seatId,
		identity: input.identity,
		joinOrder: room.nextJoinOrder++,
		connectionGeneration: 1,
		connectionId: input.connectionId,
		resumeTokenDigest: input.resumeTokenDigest,
		lobbyWins: 0,
		status: 'connected',
		ready: false,
		inventoryState: 'missing',
		inventoryRevision: 0,
		libraryGeneration: 0,
		availabilityAppliedRevision: 0,
		roundState: room.phase === 'selecting' ? 'eligible' : 'waiting',
		rttSamples: [],
		acceptedChatTimes: []
	};
	room.seats.set(seat.seatId, seat);
	return seat;
}

export function oldestConnectedSeat(room: RoomState): SeatState | undefined {
	return connectedSeats(room)[0];
}

export function allocateMessageId(room: RoomState, randomBytes: RandomBytes): string {
	for (;;) {
		const messageId = encodeOpaque(randomBytes(16));
		if (!room.issuedMessageIds.has(messageId)) {
			room.issuedMessageIds.add(messageId);
			return messageId;
		}
	}
}

export function admissionFor(room: RoomState, seat: SeatState, resumeToken: string): SeatAdmission {
	const binding: SeatConnectionRef = {
		roomId: room.roomId,
		roomGeneration: room.generation,
		seatId: seat.seatId,
		connectionId: seat.connectionId,
		connectionGeneration: seat.connectionGeneration,
		userId: seat.identity.userId
	};
	const snapshot: RoomSnapshot = {
		roomId: room.roomId,
		roomGeneration: room.generation,
		name: room.name,
		phase: room.phase,
		hasPassword: room.passwordDigest !== undefined,
		maxCount: room.maxCount,
		ownerMemberId: room.ownerSeatId,
		self: {
			memberId: seat.seatId,
			connectionGeneration: seat.connectionGeneration,
			resumeToken
		},
		members: membersForRoom(room),
		chat: [...room.chat],
		selection: room.selection === null ? null : copySelectionSnapshot(room.selection),
		selectionRevision: room.selectionRevision,
		availabilityRevision: room.availabilityRevision,
		...(room.round === undefined ? {} : { round: copyFrozenRound(room.round) }),
		liveStandings: liveStandingsFor(room),
		lastRoundResult:
			room.lastRoundResult === undefined ? null : copyRoundResult(room.lastRoundResult)
	};
	return { snapshot, resumeToken, binding };
}

export function exactConnectedSeat(
	room: RoomState,
	actor: SeatConnectionRef
): SeatState | undefined {
	const seat = room.seats.get(actor.seatId);
	if (
		seat === undefined ||
		seat.status !== 'connected' ||
		actor.roomGeneration !== room.generation ||
		seat.identity.userId !== actor.userId ||
		seat.connectionId !== actor.connectionId ||
		seat.connectionGeneration !== actor.connectionGeneration
	) {
		return undefined;
	}
	return seat;
}
