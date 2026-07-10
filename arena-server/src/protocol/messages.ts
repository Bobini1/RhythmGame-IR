import { z } from 'zod';

import { commandErrorCodeSchema, fatalErrorCodeSchema } from './errors.ts';

export const PROTOCOL_MAJOR = 1 as const;
export const PROTOCOL_MINOR = 0 as const;
export const REQUIRED_CAPABILITY = 'rooms-v1' as const;
export const MAX_CLIENT_MESSAGE_BYTES = 64 * 1024;

const MAX_CAPABILITIES = 16;
const MAX_CLIENT_VERSION_CODE_POINTS = 64;
const MAX_ROOM_NAME_CODE_POINTS = 80;
const MAX_PASSWORD_BYTES = 128;
const MAX_CHAT_CODE_POINTS = 500;
const MAX_OPAQUE_ID_LENGTH = 128;
const MAX_REQUEST_ID_LENGTH = 64;
const MAX_TICKET_LENGTH = 16 * 1024;
const MAX_MEMBERS = 16;
const MAX_WIRE_CHAT_BACKLOG = 1_000;

const utf8Encoder = new TextEncoder();
const safeIdentifierPattern = /^[A-Za-z0-9._:-]+$/;
const capabilityPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function codePointLength(value: string): number {
	return Array.from(value).length;
}

const requestIdSchema = z.string().min(1).max(MAX_REQUEST_ID_LENGTH).regex(safeIdentifierPattern);

const opaqueIdSchema = z.string().min(1).max(MAX_OPAQUE_ID_LENGTH).regex(safeIdentifierPattern);

const positiveGenerationSchema = z.number().int().positive();
const epochMillisecondsSchema = z.number().int().nonnegative();

const clientVersionSchema = z
	.string()
	.refine(
		(value) =>
			codePointLength(value) >= 1 && codePointLength(value) <= MAX_CLIENT_VERSION_CODE_POINTS
	);

const capabilitySchema = z.string().min(1).max(64).regex(capabilityPattern);
const capabilitiesSchema = z
	.array(capabilitySchema)
	.min(1)
	.max(MAX_CAPABILITIES)
	.refine((capabilities) => new Set(capabilities).size === capabilities.length)
	.refine((capabilities) => capabilities.includes(REQUIRED_CAPABILITY));

const roomNameSchema = z
	.string()
	.trim()
	.refine(
		(value) => codePointLength(value) >= 1 && codePointLength(value) <= MAX_ROOM_NAME_CODE_POINTS
	);

const passwordSchema = z
	.string()
	.min(1)
	.refine((value) => utf8Encoder.encode(value).byteLength <= MAX_PASSWORD_BYTES);

const chatTextSchema = z
	.string()
	.trim()
	.refine((value) => codePointLength(value) >= 1 && codePointLength(value) <= MAX_CHAT_CODE_POINTS);

const ticketSchema = z.string().min(1).max(MAX_TICKET_LENGTH);

const resumeRequestSchema = z
	.object({
		roomId: opaqueIdSchema,
		seatToken: opaqueIdSchema
	})
	.strict();

const clientHelloDataSchema = z
	.object({
		protocolMajor: z.literal(PROTOCOL_MAJOR),
		protocolMinor: z.literal(PROTOCOL_MINOR),
		clientVersion: clientVersionSchema,
		capabilities: capabilitiesSchema,
		ticket: ticketSchema.optional(),
		resume: resumeRequestSchema.optional()
	})
	.strict()
	.refine((data) => data.resume === undefined || data.ticket !== undefined);

const clientHelloMessageSchema = z
	.object({
		type: z.literal('client_hello'),
		data: clientHelloDataSchema
	})
	.strict();

const directorySubscribeMessageSchema = z
	.object({
		type: z.literal('directory_subscribe'),
		data: z.object({}).strict()
	})
	.strict();

const roomCreateMessageSchema = z
	.object({
		type: z.literal('room_create'),
		requestId: requestIdSchema,
		data: z
			.object({
				name: roomNameSchema,
				password: passwordSchema.optional()
			})
			.strict()
	})
	.strict();

const roomJoinMessageSchema = z
	.object({
		type: z.literal('room_join'),
		requestId: requestIdSchema,
		data: z
			.object({
				roomId: opaqueIdSchema,
				password: passwordSchema.optional()
			})
			.strict()
	})
	.strict();

const roomLeaveMessageSchema = z
	.object({
		type: z.literal('room_leave'),
		requestId: requestIdSchema,
		data: z
			.object({
				roomId: opaqueIdSchema,
				roomGeneration: positiveGenerationSchema,
				connectionGeneration: positiveGenerationSchema
			})
			.strict()
	})
	.strict();

const roomKickMessageSchema = z
	.object({
		type: z.literal('room_kick'),
		requestId: requestIdSchema,
		data: z
			.object({
				roomId: opaqueIdSchema,
				roomGeneration: positiveGenerationSchema,
				connectionGeneration: positiveGenerationSchema,
				targetMemberId: opaqueIdSchema
			})
			.strict()
	})
	.strict();

const chatSendMessageSchema = z
	.object({
		type: z.literal('chat_send'),
		requestId: requestIdSchema,
		data: z
			.object({
				roomId: opaqueIdSchema,
				roomGeneration: positiveGenerationSchema,
				connectionGeneration: positiveGenerationSchema,
				text: chatTextSchema
			})
			.strict()
	})
	.strict();

const heartbeatReplyMessageSchema = z
	.object({
		type: z.literal('heartbeat_reply'),
		data: z
			.object({
				nonce: opaqueIdSchema
			})
			.strict()
	})
	.strict();

export const clientMessageSchema = z.discriminatedUnion('type', [
	clientHelloMessageSchema,
	directorySubscribeMessageSchema,
	roomCreateMessageSchema,
	roomJoinMessageSchema,
	roomLeaveMessageSchema,
	roomKickMessageSchema,
	chatSendMessageSchema,
	heartbeatReplyMessageSchema
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const publicIdentitySchema = z
	.object({
		userId: opaqueIdSchema,
		displayName: z
			.string()
			.refine((value) => codePointLength(value) >= 1 && codePointLength(value) <= 80),
		avatarUrl: z.string().url().max(2_048).nullable()
	})
	.strict();

export type PublicIdentity = z.infer<typeof publicIdentitySchema>;

export const memberSchema = z
	.object({
		memberId: opaqueIdSchema,
		identity: publicIdentitySchema,
		status: z.enum(['connected', 'reserved']),
		lobbyWins: z.number().int().nonnegative()
	})
	.strict();

export type Member = z.infer<typeof memberSchema>;

export const chatMessageSchema = z
	.object({
		messageId: opaqueIdSchema,
		authorMemberId: opaqueIdSchema,
		authorDisplayName: z
			.string()
			.refine((value) => codePointLength(value) >= 1 && codePointLength(value) <= 80),
		sentAtMs: epochMillisecondsSchema,
		text: z
			.string()
			.refine(
				(value) => codePointLength(value) >= 1 && codePointLength(value) <= MAX_CHAT_CODE_POINTS
			)
	})
	.strict();

export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const roomSummarySchema = z
	.object({
		roomId: opaqueIdSchema,
		name: roomNameSchema,
		phase: z.literal('selecting'),
		hasPassword: z.boolean(),
		connectedCount: z.number().int().min(0).max(MAX_MEMBERS),
		reservedCount: z.number().int().min(0).max(MAX_MEMBERS),
		maxCount: z.literal(MAX_MEMBERS)
	})
	.strict()
	.refine((room) => room.connectedCount + room.reservedCount <= room.maxCount);

export type RoomSummary = z.infer<typeof roomSummarySchema>;

const selfSeatSchema = z
	.object({
		memberId: opaqueIdSchema,
		connectionGeneration: positiveGenerationSchema,
		resumeToken: opaqueIdSchema
	})
	.strict();

export const roomSnapshotSchema = z
	.object({
		roomId: opaqueIdSchema,
		roomGeneration: positiveGenerationSchema,
		name: roomNameSchema,
		phase: z.literal('selecting'),
		hasPassword: z.boolean(),
		maxCount: z.literal(MAX_MEMBERS),
		ownerMemberId: opaqueIdSchema.nullable(),
		self: selfSeatSchema,
		members: z.array(memberSchema).max(MAX_MEMBERS),
		chat: z.array(chatMessageSchema).max(MAX_WIRE_CHAT_BACKLOG)
	})
	.strict();

export type RoomSnapshot = z.infer<typeof roomSnapshotSchema>;

const serverCapabilitiesSchema = z.tuple([z.literal(REQUIRED_CAPABILITY)]);
const displayMessageKeySchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^arena\.[A-Za-z0-9.]+$/);

const resumeResultSchema = z.discriminatedUnion('status', [
	z.object({ status: z.literal('not_requested') }).strict(),
	z.object({ status: z.literal('succeeded'), room: roomSnapshotSchema }).strict(),
	z
		.object({
			status: z.literal('failed'),
			code: z.literal('room_resume_failed'),
			displayMessageKey: z.literal('arena.error.resumeFailed')
		})
		.strict()
]);

const serverHelloMessageSchema = z
	.object({
		type: z.literal('server_hello'),
		data: z
			.object({
				protocolMajor: z.literal(PROTOCOL_MAJOR),
				protocolMinor: z.literal(PROTOCOL_MINOR),
				capabilities: serverCapabilitiesSchema,
				identity: publicIdentitySchema.optional(),
				resume: resumeResultSchema
			})
			.strict()
	})
	.strict();

const fatalErrorMessageSchema = z
	.object({
		type: z.literal('fatal_error'),
		data: z
			.object({
				code: fatalErrorCodeSchema,
				displayMessageKey: displayMessageKeySchema
			})
			.strict()
	})
	.strict();

const directorySnapshotMessageSchema = z
	.object({
		type: z.literal('directory_snapshot'),
		data: z
			.object({
				revision: z.number().int().nonnegative(),
				rooms: z.array(roomSummarySchema)
			})
			.strict()
	})
	.strict();

const roomDirectoryUpdatedMessageSchema = z
	.object({
		type: z.literal('room_directory_updated'),
		data: z
			.object({
				revision: z.number().int().nonnegative(),
				upserts: z.array(roomSummarySchema),
				removedRoomIds: z.array(opaqueIdSchema)
			})
			.strict()
	})
	.strict();

const roomSnapshotMessageSchema = z
	.object({
		type: z.literal('room_snapshot'),
		requestId: requestIdSchema,
		data: roomSnapshotSchema
	})
	.strict();

const roomMemberJoinedMessageSchema = z
	.object({
		type: z.literal('room_member_joined'),
		data: z
			.object({
				roomId: opaqueIdSchema,
				roomGeneration: positiveGenerationSchema,
				member: memberSchema
			})
			.strict()
	})
	.strict();

const roomMemberUpdatedMessageSchema = z
	.object({
		type: z.literal('room_member_updated'),
		data: z
			.object({
				roomId: opaqueIdSchema,
				roomGeneration: positiveGenerationSchema,
				member: memberSchema
			})
			.strict()
	})
	.strict();

const roomMemberLeftMessageSchema = z
	.object({
		type: z.literal('room_member_left'),
		data: z
			.object({
				roomId: opaqueIdSchema,
				roomGeneration: positiveGenerationSchema,
				memberId: opaqueIdSchema,
				reason: z.enum(['left', 'kicked', 'grace_expired'])
			})
			.strict()
	})
	.strict();

const roomOwnerChangedMessageSchema = z
	.object({
		type: z.literal('room_owner_changed'),
		data: z
			.object({
				roomId: opaqueIdSchema,
				roomGeneration: positiveGenerationSchema,
				ownerMemberId: opaqueIdSchema.nullable()
			})
			.strict()
	})
	.strict();

const chatMessageEventSchema = z
	.object({
		type: z.literal('chat_message'),
		data: z
			.object({
				roomId: opaqueIdSchema,
				roomGeneration: positiveGenerationSchema,
				message: chatMessageSchema
			})
			.strict()
	})
	.strict();

const serverHeartbeatMessageSchema = z
	.object({
		type: z.literal('server_heartbeat'),
		data: z
			.object({
				nonce: opaqueIdSchema,
				sentAtMs: epochMillisecondsSchema
			})
			.strict()
	})
	.strict();

const serverGoingAwayMessageSchema = z
	.object({
		type: z.literal('server_going_away'),
		data: z
			.object({
				displayMessageKey: z.literal('arena.serverGoingAway'),
				retryAfterMs: z.number().int().nonnegative().optional()
			})
			.strict()
	})
	.strict();

const commandErrorMessageSchema = z
	.object({
		type: z.literal('command_error'),
		requestId: requestIdSchema,
		data: z
			.object({
				code: commandErrorCodeSchema,
				displayMessageKey: displayMessageKeySchema
			})
			.strict()
	})
	.strict();

export const serverMessageSchema = z.discriminatedUnion('type', [
	serverHelloMessageSchema,
	fatalErrorMessageSchema,
	directorySnapshotMessageSchema,
	roomDirectoryUpdatedMessageSchema,
	roomSnapshotMessageSchema,
	roomMemberJoinedMessageSchema,
	roomMemberUpdatedMessageSchema,
	roomMemberLeftMessageSchema,
	roomOwnerChangedMessageSchema,
	chatMessageEventSchema,
	serverHeartbeatMessageSchema,
	serverGoingAwayMessageSchema,
	commandErrorMessageSchema
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;
