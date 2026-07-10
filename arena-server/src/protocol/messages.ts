import { z } from 'zod';

import { commandErrorCodeSchema, fatalErrorCodeSchema } from './errors.ts';

export const PROTOCOL_MAJOR = 1 as const;
export const PROTOCOL_MINOR = 1 as const;
export const ROOMS_CAPABILITY = 'rooms-v1' as const;
export const ROUNDS_CAPABILITY = 'rounds-v1' as const;
/** @deprecated Prefer the capability-specific name. */
export const REQUIRED_CAPABILITY = ROOMS_CAPABILITY;
export const MAX_CLIENT_MESSAGE_BYTES = 64 * 1024;
export const MAX_SERVER_MESSAGE_BYTES = 4 * 1024 * 1024;

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
const MAX_INVENTORY_HASHES = 250_000;
const MAX_INVENTORY_BYTES = MAX_INVENTORY_HASHES * 32;
const MAX_HASHES_PER_CHUNK = 2_047;
const MAX_RANDOM_SEQUENCE = 4_096;

const utf8Encoder = new TextEncoder();
const safeIdentifierPattern = /^[A-Za-z0-9._:-]+$/;
const capabilityPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function codePointLength(value: string): number {
	return Array.from(value).length;
}

function hasUniqueKeys<T>(values: readonly T[], keyOf: (value: T) => string): boolean {
	const seen = new Set<string>();
	for (const value of values) {
		const key = keyOf(value);
		if (seen.has(key)) return false;
		seen.add(key);
	}
	return true;
}

const requestIdSchema = z.string().min(1).max(MAX_REQUEST_ID_LENGTH).regex(safeIdentifierPattern);

const opaqueIdSchema = z.string().min(1).max(MAX_OPAQUE_ID_LENGTH).regex(safeIdentifierPattern);

const safeIntegerSchema = z.number().int().safe();
const positiveGenerationSchema = safeIntegerSchema.positive();
const nonnegativeRevisionSchema = safeIntegerSchema.nonnegative();
const positiveRevisionSchema = safeIntegerSchema.positive();
const epochMillisecondsSchema = safeIntegerSchema.nonnegative();

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
	.refine((capabilities) => capabilities.includes(ROOMS_CAPABILITY));

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
		protocolMinor: z.union([z.literal(0), z.literal(PROTOCOL_MINOR)]),
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

const roomBindingSchema = z
	.object({
		roomId: opaqueIdSchema,
		roomGeneration: positiveGenerationSchema,
		connectionGeneration: positiveGenerationSchema
	})
	.strict();

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const md5Schema = z.string().regex(/^[0-9a-f]{32}$/);
const vectorDigestSchema = sha256Schema;
const transferIdSchema = z
	.string()
	.length(22)
	.regex(/^[A-Za-z0-9_-]{22}$/);
const metadataTextSchema = z.string().refine((value) => codePointLength(value) <= 200);

export const noteOrderSchema = z.enum([
	'normal',
	'mirror',
	'random',
	's_random',
	'r_random',
	'random_plus',
	's_random_plus',
	'beatoraja_random',
	'beatoraja_random_ex',
	'lr2_random',
	'lr2_random_ex'
]);
export type NoteOrder = z.infer<typeof noteOrderSchema>;

export const dpModeSchema = z.enum(['off', 'flip', 'lr2_flip', 'battle']);
export type DpMode = z.infer<typeof dpModeSchema>;

export const selectionSnapshotSchema = z
	.object({
		sha256: sha256Schema,
		md5: md5Schema.optional(),
		title: metadataTextSchema,
		subtitle: metadataTextSchema,
		artist: metadataTextSchema,
		keyMode: z.union([z.literal(5), z.literal(7), z.literal(10), z.literal(14)]),
		randomSequence: z.array(positiveGenerationSchema).max(MAX_RANDOM_SEQUENCE),
		noteOrderP1: noteOrderSchema,
		noteOrderP2: noteOrderSchema,
		dpMode: dpModeSchema,
		laneSeed: z.string().regex(/^[0-9a-f]{16}$/),
		randomizationVersion: z.literal(1)
	})
	.strict();
export type SelectionSnapshot = z.infer<typeof selectionSnapshotSchema>;

export const inventoryDeclarationSchema = z
	.object({
		libraryGeneration: positiveGenerationSchema,
		hashCount: safeIntegerSchema.min(0).max(MAX_INVENTORY_HASHES),
		byteCount: safeIntegerSchema.min(0).max(MAX_INVENTORY_BYTES),
		chunkCount: safeIntegerSchema
			.min(0)
			.max(Math.ceil(MAX_INVENTORY_HASHES / MAX_HASHES_PER_CHUNK)),
		vectorDigest: vectorDigestSchema
	})
	.strict()
	.refine((value) => value.byteCount === value.hashCount * 32)
	.refine((value) => value.chunkCount === Math.ceil(value.hashCount / MAX_HASHES_PER_CHUNK));
export type InventoryDeclaration = z.infer<typeof inventoryDeclarationSchema>;

const inventoryUploadBeginMessageSchema = z
	.object({
		type: z.literal('inventory_upload_begin'),
		requestId: requestIdSchema,
		data: roomBindingSchema.extend(inventoryDeclarationSchema.shape).strict()
	})
	.strict();

const inventoryUploadCommitMessageSchema = z
	.object({
		type: z.literal('inventory_upload_commit'),
		requestId: requestIdSchema,
		data: roomBindingSchema
			.extend({ uploadId: transferIdSchema, ...inventoryDeclarationSchema.shape })
			.strict()
	})
	.strict();

const inventoryUploadAbortMessageSchema = z
	.object({
		type: z.literal('inventory_upload_abort'),
		requestId: requestIdSchema,
		data: roomBindingSchema
			.extend({ uploadId: transferIdSchema, libraryGeneration: positiveGenerationSchema })
			.strict()
	})
	.strict();

const availabilityAppliedMessageSchema = z
	.object({
		type: z.literal('availability_applied'),
		requestId: requestIdSchema,
		data: roomBindingSchema.extend({ availabilityRevision: positiveRevisionSchema }).strict()
	})
	.strict();

const availabilityResyncMessageSchema = z
	.object({
		type: z.literal('availability_resync'),
		requestId: requestIdSchema,
		data: roomBindingSchema.extend({ currentRevision: nonnegativeRevisionSchema }).strict()
	})
	.strict();

const selectionSetMessageSchema = z
	.object({
		type: z.literal('selection_set'),
		requestId: requestIdSchema,
		data: roomBindingSchema
			.extend({
				availabilityRevision: positiveRevisionSchema,
				inventoryRevision: positiveRevisionSchema,
				selection: selectionSnapshotSchema
			})
			.strict()
	})
	.strict();

const readySetMessageSchema = z
	.object({
		type: z.literal('ready_set'),
		requestId: requestIdSchema,
		data: roomBindingSchema
			.extend({
				ready: z.boolean(),
				selectionRevision: positiveRevisionSchema,
				availabilityRevision: positiveRevisionSchema,
				inventoryRevision: positiveRevisionSchema
			})
			.strict()
	})
	.strict();

const frozenResponseFields = {
	...roomBindingSchema.shape,
	roundId: opaqueIdSchema,
	launchAttemptId: opaqueIdSchema,
	selectionRevision: positiveRevisionSchema,
	availabilityRevision: positiveRevisionSchema,
	inventoryRevision: positiveRevisionSchema
};

const roundProbeResultMessageSchema = z
	.object({
		type: z.literal('round_probe_result'),
		requestId: requestIdSchema,
		data: z.discriminatedUnion('ok', [
			z
				.object({
					...frozenResponseFields,
					nonce: opaqueIdSchema,
					ok: z.literal(true),
					sha256: sha256Schema
				})
				.strict(),
			z
				.object({
					...frozenResponseFields,
					nonce: opaqueIdSchema,
					ok: z.literal(false),
					reason: z.enum(['missing_file', 'hash_mismatch', 'read_failed', 'cancelled'])
				})
				.strict()
		])
	})
	.strict();

const roundLoadResultMessageSchema = z
	.object({
		type: z.literal('round_load_result'),
		requestId: requestIdSchema,
		data: z.discriminatedUnion('ok', [
			z.object({ ...frozenResponseFields, ok: z.literal(true) }).strict(),
			z
				.object({
					...frozenResponseFields,
					ok: z.literal(false),
					reason: z.enum([
						'missing_file',
						'hash_mismatch',
						'parse_failed',
						'unsupported_config',
						'resource_failed',
						'cancelled'
					])
				})
				.strict()
		])
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
	heartbeatReplyMessageSchema,
	inventoryUploadBeginMessageSchema,
	inventoryUploadCommitMessageSchema,
	inventoryUploadAbortMessageSchema,
	availabilityAppliedMessageSchema,
	availabilityResyncMessageSchema,
	selectionSetMessageSchema,
	readySetMessageSchema,
	roundProbeResultMessageSchema,
	roundLoadResultMessageSchema
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
		lobbyWins: nonnegativeRevisionSchema,
		ready: z.boolean(),
		inventoryState: z.enum(['missing', 'syncing', 'ready']),
		inventoryRevision: nonnegativeRevisionSchema,
		availabilityAppliedRevision: nonnegativeRevisionSchema,
		roundState: z.enum(['eligible', 'waiting', 'probing', 'loading', 'loaded', 'playing'])
	})
	.strict();

export type Member = z.infer<typeof memberSchema>;

const legacyMemberSchema = z
	.object({
		memberId: opaqueIdSchema,
		identity: publicIdentitySchema,
		status: z.enum(['connected', 'reserved']),
		lobbyWins: nonnegativeRevisionSchema
	})
	.strict();

const wireMemberSchema = z.union([memberSchema, legacyMemberSchema]);

const memberArraySchema = z
	.array(memberSchema)
	.max(MAX_MEMBERS)
	.refine((members) => hasUniqueKeys(members, (member) => member.memberId));

const legacyMemberArraySchema = z
	.array(legacyMemberSchema)
	.max(MAX_MEMBERS)
	.refine((members) => hasUniqueKeys(members, (member) => member.memberId));

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

const chatMessageArraySchema = z
	.array(chatMessageSchema)
	.max(MAX_WIRE_CHAT_BACKLOG)
	.refine((messages) => hasUniqueKeys(messages, (message) => message.messageId));

export const roomSummarySchema = z
	.object({
		roomId: opaqueIdSchema,
		name: roomNameSchema,
		phase: z.enum(['selecting', 'loading', 'playing']),
		hasPassword: z.boolean(),
		connectedCount: z.number().int().min(0).max(MAX_MEMBERS),
		reservedCount: z.number().int().min(0).max(MAX_MEMBERS),
		maxCount: z.literal(MAX_MEMBERS)
	})
	.strict()
	.refine((room) => room.connectedCount + room.reservedCount <= room.maxCount);

export type RoomSummary = z.infer<typeof roomSummarySchema>;

const roomSummaryArraySchema = z
	.array(roomSummarySchema)
	.refine((rooms) => hasUniqueKeys(rooms, (room) => room.roomId));

const removedRoomIdArraySchema = z
	.array(opaqueIdSchema)
	.refine((roomIds) => hasUniqueKeys(roomIds, (roomId) => roomId));

const selfSeatSchema = z
	.object({
		memberId: opaqueIdSchema,
		connectionGeneration: positiveGenerationSchema,
		resumeToken: opaqueIdSchema
	})
	.strict();

export const frozenParticipantSchema = z
	.object({
		memberId: opaqueIdSchema,
		inventoryRevision: positiveRevisionSchema
	})
	.strict();

const frozenParticipantArraySchema = z
	.array(frozenParticipantSchema)
	.min(1)
	.max(MAX_MEMBERS)
	.refine((participants) => hasUniqueKeys(participants, (participant) => participant.memberId));

export const frozenRoundSchema = z
	.object({
		roundId: opaqueIdSchema,
		launchAttemptId: opaqueIdSchema,
		selectionRevision: positiveRevisionSchema,
		availabilityRevision: positiveRevisionSchema,
		selection: selectionSnapshotSchema,
		participants: frozenParticipantArraySchema,
		stage: z.enum(['probing', 'loading', 'scheduled', 'playing'])
	})
	.strict();
export type FrozenRound = z.infer<typeof frozenRoundSchema>;

export const roomSnapshotSchema = z
	.object({
		roomId: opaqueIdSchema,
		roomGeneration: positiveGenerationSchema,
		name: roomNameSchema,
		phase: z.enum(['selecting', 'loading', 'playing']),
		hasPassword: z.boolean(),
		maxCount: z.literal(MAX_MEMBERS),
		ownerMemberId: opaqueIdSchema.nullable(),
		self: selfSeatSchema,
		members: memberArraySchema,
		chat: chatMessageArraySchema,
		selection: selectionSnapshotSchema.nullable(),
		selectionRevision: nonnegativeRevisionSchema,
		availabilityRevision: nonnegativeRevisionSchema,
		round: frozenRoundSchema.optional()
	})
	.strict();

export type RoomSnapshot = z.infer<typeof roomSnapshotSchema>;

const legacyRoomSnapshotSchema = z
	.object({
		roomId: opaqueIdSchema,
		roomGeneration: positiveGenerationSchema,
		name: roomNameSchema,
		phase: z.literal('selecting'),
		hasPassword: z.boolean(),
		maxCount: z.literal(MAX_MEMBERS),
		ownerMemberId: opaqueIdSchema.nullable(),
		self: selfSeatSchema,
		members: legacyMemberArraySchema,
		chat: chatMessageArraySchema
	})
	.strict();

const wireRoomSnapshotSchema = z.union([roomSnapshotSchema, legacyRoomSnapshotSchema]);

const serverCapabilitiesSchema = z
	.array(z.union([z.literal(ROOMS_CAPABILITY), z.literal(ROUNDS_CAPABILITY)]))
	.min(1)
	.max(2)
	.refine(
		(capabilities) =>
			capabilities[0] === ROOMS_CAPABILITY &&
			(capabilities.length === 1 || capabilities[1] === ROUNDS_CAPABILITY)
	);
const displayMessageKeySchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^arena\.[A-Za-z0-9.]+$/);

const resumeResultSchema = z.discriminatedUnion('status', [
	z.object({ status: z.literal('not_requested') }).strict(),
	z.object({ status: z.literal('succeeded'), room: wireRoomSnapshotSchema }).strict(),
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
				protocolMinor: z.union([z.literal(0), z.literal(PROTOCOL_MINOR)]),
				capabilities: serverCapabilitiesSchema,
				identity: publicIdentitySchema.optional(),
				resume: resumeResultSchema
			})
			.strict()
	})
	.strict()
	.refine(
		(message) =>
			message.data.protocolMinor === PROTOCOL_MINOR ||
			!message.data.capabilities.includes(ROUNDS_CAPABILITY)
	);

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
				rooms: roomSummaryArraySchema
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
				upserts: roomSummaryArraySchema,
				removedRoomIds: removedRoomIdArraySchema
			})
			.strict()
			.refine((data) => {
				const upsertIds = new Set(data.upserts.map((room) => room.roomId));
				return data.removedRoomIds.every((roomId) => !upsertIds.has(roomId));
			})
	})
	.strict();

const roomSnapshotMessageSchema = z
	.object({
		type: z.literal('room_snapshot'),
		requestId: requestIdSchema,
		data: wireRoomSnapshotSchema
	})
	.strict();

const roomMemberJoinedMessageSchema = z
	.object({
		type: z.literal('room_member_joined'),
		data: z
			.object({
				roomId: opaqueIdSchema,
				roomGeneration: positiveGenerationSchema,
				member: wireMemberSchema
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
				member: wireMemberSchema
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

const roomIdentitySchema = z
	.object({ roomId: opaqueIdSchema, roomGeneration: positiveGenerationSchema })
	.strict();

const availabilityBasisSchema = z
	.array(frozenParticipantSchema)
	.min(1)
	.max(MAX_MEMBERS)
	.refine((basis) => hasUniqueKeys(basis, (entry) => entry.memberId));

const transferVectorDeclarationFields = {
	count: safeIntegerSchema.min(0).max(MAX_INVENTORY_HASHES),
	chunkCount: safeIntegerSchema.min(0).max(Math.ceil(MAX_INVENTORY_HASHES / MAX_HASHES_PER_CHUNK)),
	digest: vectorDigestSchema
};

const inventoryUploadReadyMessageSchema = z
	.object({
		type: z.literal('inventory_upload_ready'),
		requestId: requestIdSchema,
		data: roomBindingSchema
			.extend({
				uploadId: transferIdSchema,
				...inventoryDeclarationSchema.shape,
				deadlineMs: epochMillisecondsSchema
			})
			.strict()
	})
	.strict();

const inventoryCommittedMessageSchema = z
	.object({
		type: z.literal('inventory_committed'),
		requestId: requestIdSchema,
		data: roomBindingSchema
			.extend({
				libraryGeneration: positiveGenerationSchema,
				inventoryRevision: positiveRevisionSchema,
				inventoryState: z.literal('ready')
			})
			.strict()
	})
	.strict();

const availabilityTransferBeginMessageSchema = z
	.object({
		type: z.literal('availability_transfer_begin'),
		data: z.discriminatedUnion('mode', [
			roomIdentitySchema
				.extend({
					transferId: transferIdSchema,
					mode: z.literal('reset'),
					targetRevision: positiveRevisionSchema,
					basis: availabilityBasisSchema,
					resetCount: transferVectorDeclarationFields.count,
					resetChunkCount: transferVectorDeclarationFields.chunkCount,
					resetDigest: transferVectorDeclarationFields.digest
				})
				.strict(),
			roomIdentitySchema
				.extend({
					transferId: transferIdSchema,
					mode: z.literal('delta'),
					baseRevision: positiveRevisionSchema,
					targetRevision: positiveRevisionSchema,
					basis: availabilityBasisSchema,
					addedCount: transferVectorDeclarationFields.count,
					addedChunkCount: transferVectorDeclarationFields.chunkCount,
					addedDigest: transferVectorDeclarationFields.digest,
					removedCount: transferVectorDeclarationFields.count,
					removedChunkCount: transferVectorDeclarationFields.chunkCount,
					removedDigest: transferVectorDeclarationFields.digest
				})
				.strict()
		])
	})
	.strict();

const availabilityTransferCommitMessageSchema = z
	.object({
		type: z.literal('availability_transfer_commit'),
		data: roomIdentitySchema
			.extend({ transferId: transferIdSchema, targetRevision: positiveRevisionSchema })
			.strict()
	})
	.strict();

const selectionChangedMessageSchema = z
	.object({
		type: z.literal('selection_changed'),
		data: roomIdentitySchema
			.extend({
				selectionRevision: positiveRevisionSchema,
				availabilityRevision: positiveRevisionSchema,
				selection: selectionSnapshotSchema,
				selectedByMemberId: opaqueIdSchema
			})
			.strict()
	})
	.strict();

const selectionRejectedMessageSchema = z
	.object({
		type: z.literal('selection_rejected'),
		requestId: requestIdSchema,
		data: z.discriminatedUnion('reason', [
			z
				.object({
					reason: z.literal('not_common'),
					missingMemberIds: z
						.array(opaqueIdSchema)
						.max(MAX_MEMBERS)
						.refine((ids) => hasUniqueKeys(ids, (id) => id))
				})
				.strict(),
			z.object({ reason: z.enum(['stale', 'not_allowed']) }).strict()
		])
	})
	.strict();

const roundLoadingStartedMessageSchema = z
	.object({
		type: z.literal('round_loading_started'),
		data: roomIdentitySchema.extend({ round: frozenRoundSchema }).strict()
	})
	.strict();

const roundProbeRequestedMessageSchema = z
	.object({
		type: z.literal('round_probe_requested'),
		data: roomBindingSchema
			.extend({
				roundId: opaqueIdSchema,
				launchAttemptId: opaqueIdSchema,
				selectionRevision: positiveRevisionSchema,
				availabilityRevision: positiveRevisionSchema,
				inventoryRevision: positiveRevisionSchema,
				nonce: opaqueIdSchema,
				sha256: sha256Schema,
				deadlineMs: epochMillisecondsSchema
			})
			.strict()
	})
	.strict();

const roundLoadRequestedMessageSchema = z
	.object({
		type: z.literal('round_load_requested'),
		data: roomBindingSchema.extend({ round: frozenRoundSchema }).strict()
	})
	.strict();

const roundStartScheduledMessageSchema = z
	.object({
		type: z.literal('round_start_scheduled'),
		data: roomBindingSchema
			.extend({
				roundId: opaqueIdSchema,
				launchAttemptId: opaqueIdSchema,
				startAtServerMs: epochMillisecondsSchema,
				startAfterMs: safeIntegerSchema.min(250).max(5_000)
			})
			.strict()
	})
	.strict();

const roundStartedMessageSchema = z
	.object({
		type: z.literal('round_started'),
		data: roomIdentitySchema
			.extend({ roundId: opaqueIdSchema, launchAttemptId: opaqueIdSchema })
			.strict()
	})
	.strict();

export const launchCancellationReasonSchema = z.enum([
	'missing_file',
	'hash_mismatch',
	'read_failed',
	'parse_failed',
	'unsupported_config',
	'resource_failed',
	'probe_timeout',
	'load_timeout',
	'participant_left',
	'participant_kicked',
	'server_shutdown',
	'cancelled'
]);
export type LaunchCancellationReason = z.infer<typeof launchCancellationReasonSchema>;

const roundLaunchCancelledMessageSchema = z
	.object({
		type: z.literal('round_launch_cancelled'),
		data: roomIdentitySchema
			.extend({
				roundId: opaqueIdSchema,
				launchAttemptId: opaqueIdSchema,
				reason: launchCancellationReasonSchema,
				selection: selectionSnapshotSchema.nullable(),
				selectionRevision: nonnegativeRevisionSchema,
				availabilityRevision: nonnegativeRevisionSchema
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
	commandErrorMessageSchema,
	inventoryUploadReadyMessageSchema,
	inventoryCommittedMessageSchema,
	availabilityTransferBeginMessageSchema,
	availabilityTransferCommitMessageSchema,
	selectionChangedMessageSchema,
	selectionRejectedMessageSchema,
	roundLoadingStartedMessageSchema,
	roundProbeRequestedMessageSchema,
	roundLoadRequestedMessageSchema,
	roundStartScheduledMessageSchema,
	roundStartedMessageSchema,
	roundLaunchCancelledMessageSchema
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;
