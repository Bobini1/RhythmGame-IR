import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

import { decodeClientMessage, encodeServerMessage } from '../../src/protocol/codec.ts';
import {
	commandErrorCodes,
	createCommandError,
	createFatalError,
	fatalErrorCodeSchema,
	fatalErrorCodes,
	ProtocolError,
	type FatalErrorCode
} from '../../src/protocol/errors.ts';
import {
	MAX_CLIENT_MESSAGE_BYTES,
	MAX_SERVER_MESSAGE_BYTES,
	PROTOCOL_MAJOR,
	PROTOCOL_MINOR,
	REQUIRED_CAPABILITY,
	roomSummarySchema,
	type ClientMessage,
	type RoomSnapshot,
	type ServerMessage
} from '../../src/protocol/messages.ts';

describe('unreleased Arena protocol contract', () => {
	test('uses exact protocol 1.0', () => {
		expect(PROTOCOL_MAJOR).toBe(1);
		expect(PROTOCOL_MINOR).toBe(0);
		expectProtocolError(
			() =>
				decodeClientMessage(
					JSON.stringify({
						type: 'client_hello',
						data: {
							protocolMajor: 1,
							protocolMinor: 1,
							clientVersion: 'test',
							capabilities: ['rooms-v1', 'rounds-v1']
						}
					})
				),
			'protocol_incompatible'
		);
	});

	test('publishes every public member and accepts at most 32 members', () => {
		const members = Array.from({ length: 32 }, (_, index) => ({
			displayName: `Player ${index + 1}`,
			avatarUrl: index === 1 ? 'https://example.test/player-2.png' : null,
			connected: index !== 2
		}));
		const summary = {
			roomId: 'room-123',
			name: 'Arena room',
			phase: 'selecting' as const,
			hasPassword: false,
			connectedCount: 31,
			reservedCount: 1,
			maxCount: 32,
			members
		};

		expect(roomSummarySchema.parse(summary).members).toEqual(members);
		expect(() =>
			roomSummarySchema.parse({
				...summary,
				connectedCount: 32,
				reservedCount: 1,
				members: [...members, { displayName: 'Player 33', avatarUrl: null, connected: true }]
			})
		).toThrow();
	});
});

function encode(value: unknown): string {
	return JSON.stringify(value);
}

function expectProtocolError(
	action: () => unknown,
	code: FatalErrorCode,
	forbiddenValues: readonly string[] = []
): void {
	try {
		action();
		expect.unreachable('expected a ProtocolError');
	} catch (error) {
		expect(error).toBeInstanceOf(ProtocolError);
		expect((error as ProtocolError).code).toBe(code);

		const publicError = String(error) + JSON.stringify(error);
		for (const forbidden of forbiddenValues) {
			expect(publicError).not.toContain(forbidden);
		}
	}
}

const fixtureCaseSchema = z
	.object({
		name: z.string().min(1),
		message: z.unknown()
	})
	.strict();

const invalidFixtureCaseSchema = fixtureCaseSchema
	.extend({
		typescriptFailure: fatalErrorCodeSchema,
		cppFailure: fatalErrorCodeSchema
	})
	.strict();

const protocolFixtureSchema = z
	.object({
		fixtureSchema: z.literal(1),
		protocolMajor: z.literal(1),
		protocolMinor: z.literal(0),
		clientMessages: z.array(fixtureCaseSchema),
		serverMessages: z.array(fixtureCaseSchema),
		invalidServerMessages: z.array(invalidFixtureCaseSchema)
	})
	.strict();

function protocolFixture() {
	const path = `${import.meta.dir}/../../fixtures/protocol-v1.json`;
	const parsed = protocolFixtureSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
	if (!parsed.success) throw new Error('Invalid Arena protocol fixture manifest.');
	return parsed.data;
}

function canonicalJson(value: unknown): string {
	const normalize = (item: unknown): unknown => {
		if (Array.isArray(item)) return item.map(normalize);
		if (typeof item !== 'object' || item === null) return item;
		return Object.fromEntries(
			Object.entries(item as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, normalize(child)])
		);
	};
	return JSON.stringify(normalize(value));
}

function typeCounts(cases: readonly { message: unknown }[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const fixtureCase of cases) {
		const message = fixtureCase.message as { type?: unknown };
		if (typeof message.type !== 'string') continue;
		counts[message.type] = (counts[message.type] ?? 0) + 1;
	}
	return counts;
}

describe('decodeClientMessage', () => {
	test('accepts an anonymous protocol 1.0 client hello', () => {
		const message = {
			type: 'client_hello',
			data: {
				protocolMajor: PROTOCOL_MAJOR,
				protocolMinor: 0,
				clientVersion: '0.1.0',
				capabilities: [REQUIRED_CAPABILITY]
			}
		} satisfies ClientMessage;

		expect(decodeClientMessage(encode(message))).toEqual(message);
	});

	test('accepts ticket-bearing hello with an authenticated seat-resume request', () => {
		const message = {
			type: 'client_hello',
			data: {
				protocolMajor: 1,
				protocolMinor: 0,
				clientVersion: '2026.7.10',
				capabilities: ['rooms-v1', 'future-extension'],
				ticket: 'header.payload.signature',
				resume: { roomId: 'room-123', seatToken: 'resume_token-123' }
			}
		} satisfies ClientMessage;

		expect(decodeClientMessage(encode(message))).toEqual(message);
	});

	test('accepts every Phase 1 non-hello client command', () => {
		const messages: ClientMessage[] = [
			{ type: 'directory_subscribe', data: {} },
			{
				type: 'room_create',
				requestId: 'create-1',
				data: { name: 'Public room' }
			},
			{
				type: 'room_create',
				requestId: 'create-2',
				data: { name: 'Password room', password: 'do not trim me ' }
			},
			{
				type: 'room_join',
				requestId: 'join-1',
				data: { roomId: 'room-123', password: 'password' }
			},
			{
				type: 'room_leave',
				requestId: 'leave-1',
				data: { roomId: 'room-123', roomGeneration: 3, connectionGeneration: 2 }
			},
			{
				type: 'room_kick',
				requestId: 'kick-1',
				data: {
					roomId: 'room-123',
					roomGeneration: 3,
					connectionGeneration: 2,
					targetMemberId: 'member-456'
				}
			},
			{
				type: 'chat_send',
				requestId: 'chat-1',
				data: {
					roomId: 'room-123',
					roomGeneration: 3,
					connectionGeneration: 2,
					text: 'Hello Arena!'
				}
			},
			{ type: 'heartbeat_reply', data: { nonce: 'heartbeat-123' } }
		];

		for (const message of messages) {
			expect(decodeClientMessage(encode(message))).toEqual(message);
		}
	});

	test('normalizes bounded room names and chat at the protocol boundary', () => {
		expect(
			decodeClientMessage(
				encode({
					type: 'room_create',
					requestId: 'create-trimmed',
					data: { name: '  Trimmed room  ' }
				})
			)
		).toEqual({
			type: 'room_create',
			requestId: 'create-trimmed',
			data: { name: 'Trimmed room' }
		});

		expect(
			decodeClientMessage(
				encode({
					type: 'chat_send',
					requestId: 'chat-trimmed',
					data: {
						roomId: 'room-123',
						roomGeneration: 3,
						connectionGeneration: 2,
						text: '  hello  '
					}
				})
			)
		).toEqual({
			type: 'chat_send',
			requestId: 'chat-trimmed',
			data: {
				roomId: 'room-123',
				roomGeneration: 3,
				connectionGeneration: 2,
				text: 'hello'
			}
		});
	});

	test('requires request IDs exactly for mutation commands', () => {
		expectProtocolError(
			() => decodeClientMessage(encode({ type: 'room_create', data: { name: 'Room' } })),
			'malformed_message'
		);
		expectProtocolError(
			() =>
				decodeClientMessage(
					encode({
						type: 'directory_subscribe',
						requestId: 'not-allowed',
						data: {}
					})
				),
			'malformed_message'
		);
	});

	test('rejects unknown fields at both envelope and data levels', () => {
		expectProtocolError(
			() =>
				decodeClientMessage(
					encode({
						type: 'directory_subscribe',
						data: {},
						unexpected: true
					})
				),
			'malformed_message'
		);
		expectProtocolError(
			() =>
				decodeClientMessage(
					encode({
						type: 'room_join',
						requestId: 'join-1',
						data: { roomId: 'room-123', unexpected: true }
					})
				),
			'malformed_message'
		);
	});

	test('rejects an incompatible protocol version with a stable code', () => {
		for (const [protocolMajor, protocolMinor] of [
			[2, 0],
			[1, 3]
		]) {
			expectProtocolError(
				() =>
					decodeClientMessage(
						encode({
							type: 'client_hello',
							data: {
								protocolMajor,
								protocolMinor,
								clientVersion: '0.1.0',
								capabilities: ['rooms-v1']
							}
						})
					),
				'protocol_incompatible'
			);
		}
	});

	test('requires one unique rooms-v1 capability', () => {
		const hello = (capabilities: string[]) =>
			encode({
				type: 'client_hello',
				data: {
					protocolMajor: 1,
					protocolMinor: 0,
					clientVersion: '0.1.0',
					capabilities
				}
			});

		expectProtocolError(
			() => decodeClientMessage(hello(['future-extension'])),
			'capability_required'
		);
		expectProtocolError(
			() => decodeClientMessage(hello(['rooms-v1', 'rooms-v1'])),
			'malformed_message'
		);
	});

	test('requires a ticket whenever resume data is present', () => {
		const seatToken = 'secret-seat-token';
		expectProtocolError(
			() =>
				decodeClientMessage(
					encode({
						type: 'client_hello',
						data: {
							protocolMajor: 1,
							protocolMinor: 0,
							clientVersion: '0.1.0',
							capabilities: ['rooms-v1'],
							resume: { roomId: 'room-123', seatToken }
						}
					})
				),
			'malformed_message',
			[seatToken]
		);
	});

	test('rejects malformed JSON without retaining the raw frame', () => {
		const ticket = 'sentinel-ticket-secret';
		expectProtocolError(() => decodeClientMessage(`{"ticket":"${ticket}"`), 'malformed_message', [
			ticket
		]);
	});

	test('measures the 64 KiB limit in UTF-8 bytes before parsing', () => {
		const chatBody = '💥'.repeat(17_000);
		const text = encode({
			type: 'chat_send',
			requestId: 'oversize',
			data: {
				roomId: 'room-123',
				roomGeneration: 3,
				connectionGeneration: 2,
				text: chatBody
			}
		});

		expect(text.length).toBeLessThan(MAX_CLIENT_MESSAGE_BYTES);
		expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(MAX_CLIENT_MESSAGE_BYTES);
		expectProtocolError(() => decodeClientMessage(text), 'frame_too_large', [
			chatBody.slice(0, 32)
		]);
	});

	test('accepts an exactly 65,536-byte valid client frame', () => {
		const message = { type: 'directory_subscribe', data: {} } satisfies ClientMessage;
		const encoded = encode(message);
		const exact = `${encoded}${' '.repeat(
			MAX_CLIENT_MESSAGE_BYTES - new TextEncoder().encode(encoded).byteLength
		)}`;

		expect(new TextEncoder().encode(exact).byteLength).toBe(MAX_CLIENT_MESSAGE_BYTES);
		expect(decodeClientMessage(exact)).toEqual(message);
	});

	test('rejects empty and over-bound sensitive values without echoing them', () => {
		const password = 'é'.repeat(65);
		expectProtocolError(
			() =>
				decodeClientMessage(
					encode({
						type: 'room_create',
						requestId: 'create-secret',
						data: { name: 'Room', password }
					})
				),
			'malformed_message',
			[password]
		);
		expectProtocolError(
			() =>
				decodeClientMessage(
					encode({
						type: 'chat_send',
						requestId: 'empty-chat',
						data: {
							roomId: 'room-123',
							roomGeneration: 3,
							connectionGeneration: 2,
							text: '   '
						}
					})
				),
			'malformed_message'
		);
	});
});

describe('server protocol messages', () => {
	const room: RoomSnapshot = {
		roomId: 'room-123',
		roomGeneration: 3,
		name: 'Arena room',
		phase: 'selecting',
		hasPassword: true,
		maxCount: 32,
		ownerMemberId: 'member-1',
		self: {
			memberId: 'member-1',
			connectionGeneration: 2,
			resumeToken: 'resume_token-123'
		},
		members: [
			{
				memberId: 'member-1',
				identity: {
					userId: 'user-1',
					displayName: 'Alice',
					avatarUrl: null
				},
				status: 'connected',
				lobbyWins: 0,
				ready: false,
				inventoryState: 'missing',
				inventoryRevision: 0,
				availabilityAppliedRevision: 0,
				roundState: 'eligible'
			}
		],
		chat: [
			{
				messageId: 'message-1',
				authorMemberId: 'member-1',
				authorDisplayName: 'Alice',
				sentAtMs: 1_752_172_800_000,
				text: 'Hello'
			}
		],
		selection: null,
		selectionRevision: 0,
		availabilityRevision: 0
	};

	test('encodes every Phase 1 server event as a strict envelope', () => {
		const member = room.members[0]!;
		const chatMessage = room.chat[0]!;
		const messages: ServerMessage[] = [
			{
				type: 'server_hello',
				data: {
					protocolMajor: 1,
					protocolMinor: 0,
					capabilities: ['rooms-v1'],
					resume: { status: 'not_requested' }
				}
			},
			{
				type: 'server_hello',
				data: {
					protocolMajor: 1,
					protocolMinor: 0,
					capabilities: ['rooms-v1'],
					identity: member.identity,
					resume: { status: 'succeeded', room }
				}
			},
			{
				type: 'server_hello',
				data: {
					protocolMajor: 1,
					protocolMinor: 0,
					capabilities: ['rooms-v1'],
					identity: member.identity,
					resume: {
						status: 'failed',
						code: 'room_resume_failed',
						displayMessageKey: 'arena.error.resumeFailed'
					}
				}
			},
			createFatalError('frame_too_large'),
			{
				type: 'directory_snapshot',
				data: {
					revision: 4,
					rooms: [
						{
							roomId: 'room-123',
							name: 'Arena room',
							phase: 'selecting',
							hasPassword: true,
							connectedCount: 1,
							reservedCount: 0,
							maxCount: 32,
							members: [{ displayName: 'Alice', avatarUrl: null, connected: true }]
						}
					]
				}
			},
			{
				type: 'room_directory_updated',
				data: {
					revision: 5,
					upserts: [],
					removedRoomIds: ['room-removed']
				}
			},
			{ type: 'room_snapshot', requestId: 'join-1', data: room },
			{
				type: 'room_member_joined',
				data: { roomId: 'room-123', roomGeneration: 3, member }
			},
			{
				type: 'room_member_updated',
				data: { roomId: 'room-123', roomGeneration: 3, member }
			},
			{
				type: 'room_member_left',
				data: {
					roomId: 'room-123',
					roomGeneration: 3,
					memberId: 'member-2',
					reason: 'kicked'
				}
			},
			{
				type: 'room_owner_changed',
				data: {
					roomId: 'room-123',
					roomGeneration: 3,
					ownerMemberId: 'member-1'
				}
			},
			{
				type: 'chat_message',
				data: { roomId: 'room-123', roomGeneration: 3, message: chatMessage }
			},
			{
				type: 'server_heartbeat',
				data: { nonce: 'heartbeat-123', sentAtMs: 1_752_172_800_000 }
			},
			{
				type: 'server_going_away',
				data: { displayMessageKey: 'arena.serverGoingAway', retryAfterMs: 1_000 }
			},
			createCommandError('join-1', 'room_password_invalid')
		];

		for (const message of messages) {
			expect(JSON.parse(encodeServerMessage(message))).toEqual(message);
		}
	});

	test('rejects an accidental private field in a public directory message', () => {
		const invalidMessage = {
			type: 'directory_snapshot',
			data: {
				revision: 1,
				rooms: [
					{
						roomId: 'room-123',
						name: 'Room',
						phase: 'selecting',
						hasPassword: true,
						connectedCount: 1,
						reservedCount: 0,
						maxCount: 32,
						members: [{ displayName: 'Alice', avatarUrl: null, connected: true }],
						resumeToken: 'must-not-leak'
					}
				]
			}
		};

		expect(() => encodeServerMessage(invalidMessage as never)).toThrow(ProtocolError);
	});

	test('rejects duplicate and overlapping server wire identifiers atomically', () => {
		const summary = {
			roomId: 'room-duplicate',
			name: 'Room',
			phase: 'selecting' as const,
			hasPassword: false,
			connectedCount: 1,
			reservedCount: 0,
			maxCount: 32 as const,
			members: [{ displayName: 'Alice', avatarUrl: null, connected: true }]
		};
		const invalidMessages = [
			{
				type: 'directory_snapshot',
				data: { revision: 1, rooms: [summary, { ...summary }] }
			},
			{
				type: 'room_directory_updated',
				data: { revision: 2, upserts: [summary, { ...summary }], removedRoomIds: [] }
			},
			{
				type: 'room_directory_updated',
				data: {
					revision: 2,
					upserts: [],
					removedRoomIds: ['room-duplicate', 'room-duplicate']
				}
			},
			{
				type: 'room_directory_updated',
				data: { revision: 2, upserts: [summary], removedRoomIds: ['room-duplicate'] }
			},
			{
				type: 'room_snapshot',
				requestId: 'join-duplicate-member',
				data: { ...room, members: [room.members[0]!, { ...room.members[0]! }] }
			},
			{
				type: 'room_snapshot',
				requestId: 'join-duplicate-chat',
				data: { ...room, chat: [room.chat[0]!, { ...room.chat[0]! }] }
			}
		];

		for (const message of invalidMessages) {
			expectProtocolError(() => encodeServerMessage(message as never), 'malformed_message', [
				'room-duplicate'
			]);
		}
	});

	test('rejects an outgoing server frame above four MiB without retaining its contents', () => {
		const sentinel = 'sentinel-oversized-server-room';
		const rooms = Array.from({ length: 28_000 }, (_, index) => ({
			roomId: `room-${index}`,
			name: `${sentinel}-${index}`.padEnd(80, 'x'),
			phase: 'selecting' as const,
			hasPassword: false,
			connectedCount: 1,
			reservedCount: 0,
			maxCount: 32 as const,
			members: [{ displayName: `Player ${index}`, avatarUrl: null, connected: true }]
		}));
		const message = {
			type: 'directory_snapshot',
			data: { revision: 1, rooms }
		} satisfies ServerMessage;
		const rawBytes = new TextEncoder().encode(JSON.stringify(message)).byteLength;

		expect(rawBytes).toBeGreaterThan(MAX_SERVER_MESSAGE_BYTES);
		expectProtocolError(() => encodeServerMessage(message), 'frame_too_large', [sentinel]);
	});

	test('builds command errors from stable codes without accepting unsafe detail', () => {
		expect(createCommandError('request-1', 'permission_denied')).toEqual({
			type: 'command_error',
			requestId: 'request-1',
			data: {
				code: 'permission_denied',
				displayMessageKey: 'arena.error.roomActionUnavailable'
			}
		});
		expect(createFatalError('frame_too_large')).toEqual({
			type: 'fatal_error',
			data: {
				code: 'frame_too_large',
				displayMessageKey: 'arena.error.frameTooLarge'
			}
		});
	});
});

describe('protocol v1 canonical fixture', () => {
	test('is strict, complete, and accepted by the TypeScript codec', () => {
		const fixture = protocolFixture();
		expect(fixture.clientMessages).toHaveLength(12);
		expect(fixture.serverMessages).toHaveLength(44);
		expect(fixture.invalidServerMessages).toHaveLength(9);

		const names = [
			...fixture.clientMessages,
			...fixture.serverMessages,
			...fixture.invalidServerMessages
		].map((entry) => entry.name);
		expect(new Set(names).size).toBe(names.length);
		expect(typeCounts(fixture.clientMessages)).toEqual({
			client_hello: 3,
			directory_subscribe: 1,
			room_create: 2,
			room_join: 2,
			room_leave: 1,
			room_kick: 1,
			chat_send: 1,
			heartbeat_reply: 1
		});
		expect(typeCounts(fixture.serverMessages)).toEqual({
			server_hello: 4,
			directory_snapshot: 1,
			room_directory_updated: 1,
			room_snapshot: 1,
			room_member_joined: 1,
			room_member_updated: 2,
			room_member_left: 3,
			room_owner_changed: 2,
			chat_message: 1,
			server_heartbeat: 1,
			server_going_away: 2,
			command_error: 16,
			fatal_error: 9
		});
		expect(
			fixture.serverMessages
				.filter(
					(fixtureCase) => (fixtureCase.message as { type?: unknown }).type === 'command_error'
				)
				.map((fixtureCase) => (fixtureCase.message as { data: { code: string } }).data.code)
				.sort()
		).toEqual(commandErrorCodes.slice(0, 16).sort());
		expect(
			fixture.serverMessages
				.filter((fixtureCase) => (fixtureCase.message as { type?: unknown }).type === 'fatal_error')
				.map((fixtureCase) => (fixtureCase.message as { data: { code: string } }).data.code)
				.sort()
		).toEqual(fatalErrorCodes.filter((code) => code !== 'malformed_inventory').sort());

		for (const fixtureCase of fixture.clientMessages) {
			const decoded = decodeClientMessage(JSON.stringify(fixtureCase.message));
			if (canonicalJson(decoded) !== canonicalJson(fixtureCase.message)) {
				throw new Error(`Client protocol fixture failed: ${fixtureCase.name}`);
			}
		}

		for (const fixtureCase of fixture.serverMessages) {
			const encoded = JSON.parse(encodeServerMessage(fixtureCase.message as never)) as unknown;
			if (canonicalJson(encoded) !== canonicalJson(fixtureCase.message)) {
				throw new Error(`Server protocol fixture failed: ${fixtureCase.name}`);
			}
		}

		for (const fixtureCase of fixture.invalidServerMessages) {
			try {
				encodeServerMessage(fixtureCase.message as never);
				throw new Error(`Invalid server protocol fixture was accepted: ${fixtureCase.name}`);
			} catch (error) {
				if (!(error instanceof ProtocolError) || error.code !== fixtureCase.typescriptFailure) {
					throw new Error(
						`Invalid server protocol fixture failed unexpectedly: ${fixtureCase.name}`
					);
				}
			}
		}
	});
});
