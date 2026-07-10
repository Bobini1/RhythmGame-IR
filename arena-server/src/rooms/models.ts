import type { ArenaIdentity } from '../auth/identity.ts';
import type { PackedInventory } from '../inventory/packed-inventory.ts';
import type { FrozenRound, SelectionSnapshot } from '../protocol/messages.ts';

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
	| 'inventory_invalid'
	| 'inventory_stale'
	| 'inventory_capacity_exceeded'
	| 'availability_stale'
	| 'selection_not_common'
	| 'selection_stale'
	| 'ready_not_allowed'
	| 'round_stale'
	| 'launch_stage_stale'
	| 'room_resume_failed';

export type RoomRejection = Readonly<{
	code: RoomRejectionCode;
	missingMemberIds?: readonly string[];
}>;

export type RoomMember = Readonly<{
	memberId: string;
	identity: ArenaIdentity;
	status: 'connected' | 'reserved';
	lobbyWins: number;
	ready: boolean;
	inventoryState: 'missing' | 'syncing' | 'ready';
	inventoryRevision: number;
	availabilityAppliedRevision: number;
	roundState: 'eligible' | 'waiting' | 'probing' | 'loading' | 'loaded' | 'playing';
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
	phase: 'selecting' | 'loading' | 'playing';
	hasPassword: boolean;
	connectedCount: number;
	reservedCount: number;
	maxCount: 16;
}>;

export type RoomSnapshot = Readonly<{
	roomId: string;
	roomGeneration: number;
	name: string;
	phase: 'selecting' | 'loading' | 'playing';
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
	selection: SelectionSnapshot | null;
	selectionRevision: number;
	availabilityRevision: number;
	round?: FrozenRound;
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

export type AvailabilityBasisEntry = Readonly<{
	memberId: string;
	inventoryRevision: number;
}>;

export type AvailabilitySnapshot = Readonly<{
	revision: number;
	basis: readonly AvailabilityBasisEntry[];
	inventory: PackedInventory;
}>;

export type AvailabilityChangedEffect = Readonly<{
	type: 'availability_changed';
	targets: readonly string[];
	roomId: string;
	roomGeneration: number;
	previousRevision: number;
	targetRevision: number;
	basis: readonly AvailabilityBasisEntry[];
	previous?: PackedInventory;
	current: PackedInventory;
	recipients: readonly Readonly<{
		connectionId: string;
		baseRevision: number;
		forceReset: boolean;
	}>[];
}>;

export type RoomEffect =
	| MemberLeftEffect
	| AvailabilityChangedEffect
	| Readonly<{
			type: 'selection_changed';
			targets: readonly string[];
			roomId: string;
			roomGeneration: number;
			selectionRevision: number;
			availabilityRevision: number;
			selection: SelectionSnapshot | null;
			selectedByMemberId: string | null;
	  }>
	| Readonly<{
			type: 'round_loading_started';
			targets: readonly string[];
			roomId: string;
			roomGeneration: number;
			round: FrozenRound;
	  }>
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

export type UploadAdmission = Readonly<{
	libraryGeneration: number;
	inventoryState: 'syncing';
}>;

export type InventoryCommit = Readonly<{
	libraryGeneration: number;
	inventoryRevision: number;
	availabilityRevision: number;
}>;

export type SelectionCommit = Readonly<{
	selection: SelectionSnapshot;
	selectionRevision: number;
	availabilityRevision: number;
	selectedByMemberId: string;
}>;

export type ReadyCommit = Readonly<{
	ready: boolean;
	round?: FrozenRound;
}>;
