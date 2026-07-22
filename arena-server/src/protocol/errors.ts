import { z } from 'zod';

export const commandErrorCodes = [
	'auth_required',
	'already_in_room',
	'not_in_room',
	'room_not_found',
	'room_password_invalid',
	'room_full',
	'room_banned',
	'room_duplicate_identity',
	'room_generation_stale',
	'connection_generation_stale',
	'permission_denied',
	'target_not_found',
	'cannot_kick_self',
	'chat_empty',
	'chat_too_long',
	'rate_limited',
	'rounds_capability_required',
	'competition_capability_required',
	'inventory_invalid',
	'inventory_stale',
	'inventory_capacity_exceeded',
	'availability_stale',
	'selection_not_common',
	'selection_stale',
	'ready_not_allowed',
	'round_stale',
	'launch_stage_stale',
	'result_invalid',
	'round_already_terminal',
	'server_capacity'
] as const;

export const fatalErrorCodes = [
	'malformed_message',
	'frame_too_large',
	'unexpected_binary',
	'malformed_inventory',
	'hello_required',
	'hello_repeated',
	'protocol_incompatible',
	'capability_required',
	'invalid_ticket',
	'ticket_replayed'
] as const;

export const commandErrorCodeSchema = z.enum(commandErrorCodes);
export const fatalErrorCodeSchema = z.enum(fatalErrorCodes);

export type CommandErrorCode = z.infer<typeof commandErrorCodeSchema>;
export type FatalErrorCode = z.infer<typeof fatalErrorCodeSchema>;

const commandDisplayMessageKeys = {
	auth_required: 'arena.error.authRequired',
	already_in_room: 'arena.error.alreadyInRoom',
	not_in_room: 'arena.error.roomMembershipChanged',
	room_not_found: 'arena.error.roomNotFound',
	room_password_invalid: 'arena.error.roomPasswordInvalid',
	room_full: 'arena.error.roomFull',
	room_banned: 'arena.error.roomBanned',
	room_duplicate_identity: 'arena.error.roomDuplicateIdentity',
	room_generation_stale: 'arena.error.roomStateChanged',
	connection_generation_stale: 'arena.error.roomStateChanged',
	permission_denied: 'arena.error.roomActionUnavailable',
	target_not_found: 'arena.error.roomMembershipChanged',
	cannot_kick_self: 'arena.error.roomActionUnavailable',
	chat_empty: 'arena.error.chatRejected',
	chat_too_long: 'arena.error.chatRejected',
	rate_limited: 'arena.error.rateLimited',
	rounds_capability_required: 'arena.error.roundsCapabilityRequired',
	competition_capability_required: 'arena.error.competitionCapabilityRequired',
	inventory_invalid: 'arena.error.inventoryInvalid',
	inventory_stale: 'arena.error.roomLibraryChanged',
	inventory_capacity_exceeded: 'arena.error.inventoryCapacityExceeded',
	availability_stale: 'arena.error.roomLibraryChanged',
	selection_not_common: 'arena.error.selectionNotCommon',
	selection_stale: 'arena.error.roomLibraryChanged',
	ready_not_allowed: 'arena.error.readyNotAllowed',
	round_stale: 'arena.error.roomStateChanged',
	launch_stage_stale: 'arena.error.roomStateChanged',
	result_invalid: 'arena.error.resultInvalid',
	round_already_terminal: 'arena.error.roomStateChanged',
	server_capacity: 'arena.error.serverCapacity'
} as const satisfies Record<CommandErrorCode, string>;

const fatalDisplayMessageKeys = {
	malformed_message: 'arena.error.malformedMessage',
	frame_too_large: 'arena.error.frameTooLarge',
	unexpected_binary: 'arena.error.unexpectedBinary',
	malformed_inventory: 'arena.error.malformedInventory',
	hello_required: 'arena.error.helloRequired',
	hello_repeated: 'arena.error.helloRepeated',
	protocol_incompatible: 'arena.error.protocolIncompatible',
	capability_required: 'arena.error.capabilityRequired',
	invalid_ticket: 'arena.error.invalidTicket',
	ticket_replayed: 'arena.error.invalidTicket'
} as const satisfies Record<FatalErrorCode, string>;

const protocolErrorMessages = {
	malformed_message: 'The Arena protocol message is malformed.',
	frame_too_large: 'The Arena protocol frame exceeds the size limit.',
	unexpected_binary: 'The Arena binary frame was not expected.',
	malformed_inventory: 'The Arena inventory transfer is malformed.',
	hello_required: 'The Arena protocol requires a client hello first.',
	hello_repeated: 'The Arena client hello may only be sent once.',
	protocol_incompatible: 'The Arena protocol version is incompatible.',
	capability_required: 'The Arena client lacks a required capability.',
	invalid_ticket: 'The Arena identity ticket is invalid.',
	ticket_replayed: 'The Arena identity ticket is invalid.'
} as const satisfies Record<FatalErrorCode, string>;

export class ProtocolError extends Error {
	readonly code: FatalErrorCode;
	readonly displayMessageKey: string;

	constructor(code: FatalErrorCode) {
		super(protocolErrorMessages[code]);
		this.name = 'ProtocolError';
		this.code = code;
		this.displayMessageKey = fatalDisplayMessageKeys[code];
	}

	toJSON(): Readonly<{ name: string; code: FatalErrorCode; displayMessageKey: string }> {
		return {
			name: this.name,
			code: this.code,
			displayMessageKey: this.displayMessageKey
		};
	}
}

export function createCommandError(requestId: string, code: CommandErrorCode) {
	return {
		type: 'command_error' as const,
		requestId,
		data: {
			code,
			displayMessageKey: commandDisplayMessageKeys[code]
		}
	};
}

export function createFatalError(code: FatalErrorCode) {
	return {
		type: 'fatal_error' as const,
		data: {
			code,
			displayMessageKey: fatalDisplayMessageKeys[code]
		}
	};
}
