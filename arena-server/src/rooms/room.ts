import { createHash, timingSafeEqual } from 'node:crypto';

import type { ArenaIdentity } from '../auth/identity.ts';
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
	reservedUntilMs?: number;
	acceptedChatTimes: number[];
};

export type RoomState = {
	readonly roomId: string;
	readonly generation: number;
	readonly name: string;
	readonly maxCount: 16;
	readonly passwordDigest: string | undefined;
	ownerSeatId: string | null;
	readonly seats: Map<string, SeatState>;
	readonly issuedSeatIds: Set<string>;
	readonly bannedUserIds: Set<string>;
	readonly issuedMessageIds: Set<string>;
	nextJoinOrder: number;
	readonly chat: ChatMessage[];
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
		acceptedChatTimes: []
	};
	const room: RoomState = {
		roomId: input.roomId,
		generation: input.roomGeneration,
		name: input.name,
		maxCount: 16,
		passwordDigest: input.passwordDigest,
		ownerSeatId: input.seatId,
		seats: new Map([[input.seatId, seat]]),
		issuedSeatIds: new Set([input.seatId]),
		bannedUserIds: new Set(),
		issuedMessageIds: new Set(),
		nextJoinOrder: 2,
		chat: []
	};
	return {
		room,
		admission: admissionFor(room, seat, input.resumeToken.plaintext)
	};
}

function memberView(seat: SeatState): RoomMember {
	return {
		memberId: seat.seatId,
		identity: seat.identity,
		status: seat.status,
		lobbyWins: seat.lobbyWins
	};
}

export function memberFor(seat: SeatState): RoomMember {
	return memberView(seat);
}

export function summaryFor(room: RoomState): RoomSummary {
	return {
		roomId: room.roomId,
		name: room.name,
		phase: 'selecting',
		hasPassword: room.passwordDigest !== undefined,
		connectedCount: [...room.seats.values()].filter((seat) => seat.status === 'connected').length,
		reservedCount: [...room.seats.values()].filter((seat) => seat.status === 'reserved').length,
		maxCount: room.maxCount
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
		phase: 'selecting',
		hasPassword: room.passwordDigest !== undefined,
		maxCount: room.maxCount,
		ownerMemberId: room.ownerSeatId,
		self: {
			memberId: seat.seatId,
			connectionGeneration: seat.connectionGeneration,
			resumeToken
		},
		members: [...room.seats.values()].sort((a, b) => a.joinOrder - b.joinOrder).map(memberView),
		chat: [...room.chat]
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
