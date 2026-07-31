import type { ArenaIdentity } from '../auth/identity.ts';
import type { PackedInventory } from '../inventory/packed-inventory.ts';
import type {
	ArenaDnfReason,
	ArenaFinalResult,
	ArenaTelemetry,
	CompetitionFrozenRound,
	LaunchCancellationReason,
	LiveStandingsSnapshot,
	RoundResultSnapshot,
	SelectionSnapshot
} from '../protocol/messages.ts';

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
	| 'round_already_terminal'
	| 'result_invalid'
	| 'launch_stage_stale'
	| 'room_resume_failed'
	| 'server_capacity';

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
	maxCount: 32;
	members: readonly PublicRoomMember[];
}>;

export type PublicRoomMember = Readonly<{
	displayName: string;
	avatarUrl: string | null;
	connected: boolean;
}>;

export type RoomSnapshot = Readonly<{
	roomId: string;
	roomGeneration: number;
	name: string;
	phase: 'selecting' | 'loading' | 'playing';
	hasPassword: boolean;
	maxCount: 32;
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
	round?: CompetitionFrozenRound;
	liveStandings: LiveStandingsSnapshot | null;
	lastRoundResult: RoundResultSnapshot | null;
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
			round: CompetitionFrozenRound;
	  }>
	| Readonly<{
			type: 'round_probe_requested';
			targets: readonly [string];
			roomId: string;
			roomGeneration: number;
			connectionGeneration: number;
			roundId: string;
			launchAttemptId: string;
			selectionRevision: number;
			availabilityRevision: number;
			inventoryRevision: number;
			nonce: string;
			sha256: string;
			deadlineMs: number;
	  }>
	| Readonly<{
			type: 'round_load_requested';
			targets: readonly [string];
			roomId: string;
			roomGeneration: number;
			connectionGeneration: number;
			round: CompetitionFrozenRound;
	  }>
	| Readonly<{
			type: 'round_start_scheduled';
			targets: readonly [string];
			roomId: string;
			roomGeneration: number;
			connectionGeneration: number;
			roundId: string;
			launchAttemptId: string;
			startAtServerMs: number;
			startAfterMs: number;
			playDeadlineAtServerMs: number;
	  }>
	| Readonly<{
			type: 'round_started';
			targets: readonly string[];
			roomId: string;
			roomGeneration: number;
			roundId: string;
			launchAttemptId: string;
			playDeadlineAtServerMs: number;
	  }>
	| Readonly<{
			type: 'round_standings';
			targets: readonly string[];
			snapshot: LiveStandingsSnapshot;
	  }>
	| Readonly<{
			type: 'round_finalized';
			targets: readonly string[];
			roomId: string;
			roomGeneration: number;
			roundId: string;
			launchAttemptId: string;
			result: RoundResultSnapshot;
			members: readonly RoomMember[];
	  }>
	| Readonly<{
			type: 'round_launch_cancelled';
			targets: readonly string[];
			roomId: string;
			roomGeneration: number;
			roundId: string;
			launchAttemptId: string;
			reason: LaunchCancellationReason;
			selection: SelectionSnapshot | null;
			selectionRevision: number;
			availabilityRevision: number;
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
	| Readonly<{
			ok: false;
			rejection: RoomRejection;
			effects?: readonly RoomEffect[];
			directoryChange?: DirectoryChange;
	  }>;

export type DirectorySnapshot = Readonly<{
	revision: number;
	rooms: readonly RoomSummary[];
}>;

export type RoomDirectoryConfig = Readonly<{
	roomCapacity: 32;
	reconnectGraceMs: number;
	chatBacklog: number;
	maxRooms?: number;
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

export type ReclaimSeatInput = Readonly<{
	roomId: string;
	connectionId: string;
	identity: ArenaIdentity;
	nowMs: number;
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
	directoryChange?: DirectoryChange;
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
	round?: CompetitionFrozenRound;
}>;

export type TelemetryInput = Readonly<{
	roundId: string;
	launchAttemptId: string;
	telemetry: ArenaTelemetry;
}>;

export type RoundResultInput = Readonly<{
	roundId: string;
	launchAttemptId: string;
	result: ArenaFinalResult;
}>;

export type RoundAbandonInput = Readonly<{
	roundId: string;
	launchAttemptId: string;
	reason: Extract<ArenaDnfReason, 'aborted' | 'result_unavailable'>;
}>;

export type TelemetryMutation =
	| Readonly<{
			status: 'accepted';
			standingsRevision: number;
	  }>
	| Readonly<{ status: 'ignored' }>
	| Readonly<{ status: 'dropped' }>
	| Readonly<{ status: 'close'; closeCode: 1008; reason: 'rate_limited' }>;

export type TerminalMutation = Readonly<{
	status: 'accepted' | 'identical_retry';
	terminal: 'finished' | 'dnf';
	standingsRevision: number;
	finalized?: RoundResultSnapshot;
}>;

export type FrozenReplyBasis = Readonly<{
	roundId: string;
	launchAttemptId: string;
	selectionRevision: number;
	availabilityRevision: number;
	inventoryRevision: number;
}>;

export type ProbeReport = FrozenReplyBasis &
	Readonly<{ nonce: string }> &
	(
		| Readonly<{ ok: true; sha256: string }>
		| Readonly<{
				ok: false;
				reason: 'missing_file' | 'hash_mismatch' | 'read_failed' | 'cancelled';
		  }>
	);

export type LoadReport = FrozenReplyBasis &
	(
		| Readonly<{ ok: true; chartLengthMs: number }>
		| Readonly<{
				ok: false;
				reason:
					| 'missing_file'
					| 'hash_mismatch'
					| 'parse_failed'
					| 'unsupported_config'
					| 'resource_failed'
					| 'cancelled';
		  }>
	);
