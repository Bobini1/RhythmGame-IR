import type { ArenaIdentity } from '../auth/identity.ts';

export type RoomRejectionCode =
	| 'already_in_room'
	| 'room_not_found'
	| 'room_password_invalid'
	| 'room_full'
	| 'room_banned'
	| 'room_duplicate_identity'
	| 'room_generation_stale'
	| 'connection_generation_stale'
	| 'permission_denied'
	| 'target_not_found'
	| 'cannot_kick_self'
	| 'chat_empty'
	| 'chat_too_long'
	| 'rate_limited'
	| 'room_resume_failed';

export type RoomRejection = Readonly<{ code: RoomRejectionCode }>;

export type RoomMember = Readonly<{
	memberId: string;
	identity: ArenaIdentity;
	status: 'connected' | 'reserved';
	lobbyWins: number;
}>;

export type ChatMessage = Readonly<{
	messageId: string;
	authorMemberId: string;
	authorDisplayName: string;
	sentAtMs: number;
	text: string;
}>;

export type RoomSummary = Readonly<{
	roomId: string;
	name: string;
	phase: 'selecting';
	hasPassword: boolean;
	connectedCount: number;
	reservedCount: number;
	maxCount: 16;
}>;

export type RoomSnapshot = Readonly<{
	roomId: string;
	roomGeneration: number;
	name: string;
	phase: 'selecting';
	hasPassword: boolean;
	maxCount: 16;
	ownerMemberId: string | null;
	self: Readonly<{
		memberId: string;
		connectionGeneration: number;
		resumeToken: string;
	}>;
	members: readonly RoomMember[];
	chat: readonly ChatMessage[];
}>;

export type SeatConnectionRef = Readonly<{
	roomId: string;
	roomGeneration: number;
	seatId: string;
	connectionId: string;
	connectionGeneration: number;
	userId: string;
}>;

export type SeatAdmission = Readonly<{
	snapshot: RoomSnapshot;
	resumeToken: string;
	binding: SeatConnectionRef;
	staleConnectionId?: string;
}>;

export type MemberLeftEffect = Readonly<{
	type: 'member_left';
	targets: readonly string[];
	roomId: string;
	roomGeneration: number;
	memberId: string;
	reason: 'left' | 'kicked' | 'grace_expired';
	invalidatedBinding?: SeatConnectionRef;
}>;

export type RoomEffect =
	| MemberLeftEffect
	| Readonly<{
			type: 'member_joined';
			targets: readonly string[];
			roomId: string;
			roomGeneration: number;
			member: RoomMember;
	  }>
	| Readonly<{
			type: 'member_updated';
			targets: readonly string[];
			roomId: string;
			roomGeneration: number;
			member: RoomMember;
	  }>
	| Readonly<{
			type: 'chat_message';
			targets: readonly string[];
			roomId: string;
			roomGeneration: number;
			message: ChatMessage;
	  }>
	| Readonly<{
			type: 'owner_changed';
			targets: readonly string[];
			roomId: string;
			roomGeneration: number;
			ownerMemberId: string | null;
	  }>;

export type DirectoryChange = Readonly<{
	revision: number;
	upserts: readonly RoomSummary[];
	removedRoomIds: readonly string[];
}>;

export type DomainResult<T> =
	| Readonly<{
			ok: true;
			value: T;
			effects: readonly RoomEffect[];
			directoryChange?: DirectoryChange;
	  }>
	| Readonly<{ ok: false; rejection: RoomRejection }>;

export type DirectorySnapshot = Readonly<{
	revision: number;
	rooms: readonly RoomSummary[];
}>;

export type RoomDirectoryConfig = Readonly<{
	roomCapacity: 16;
	reconnectGraceMs: number;
	chatBacklog: number;
}>;

export type CreateRoomInput = Readonly<{
	connectionId: string;
	identity: ArenaIdentity;
	name: string;
	password?: string;
}>;

export type JoinRoomInput = Readonly<{
	roomId: string;
	connectionId: string;
	identity: ArenaIdentity;
	password?: string;
}>;

export type ResumeSeatInput = Readonly<{
	roomId: string;
	connectionId: string;
	identity: ArenaIdentity;
	resumeToken: string;
	nowMs: number;
}>;

export type RoomTransition = Readonly<{
	effects: readonly RoomEffect[];
	directoryChange: DirectoryChange;
}>;
