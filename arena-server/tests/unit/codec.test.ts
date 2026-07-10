import { describe, expect, test } from 'bun:test';

import { decodeClientMessage, encodeServerMessage } from '../../src/protocol/codec.ts';
import {
	createCommandError,
	createFatalError,
	ProtocolError,
	type FatalErrorCode
} from '../../src/protocol/errors.ts';
import {
	MAX_CLIENT_MESSAGE_BYTES,
	PROTOCOL_MAJOR,
	PROTOCOL_MINOR,
	REQUIRED_CAPABILITY,
	type ClientMessage,
	type RoomSnapshot,
	type ServerMessage
} from '../../src/protocol/messages.ts';

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

describe('decodeClientMessage', () => {
	test('accepts an anonymous protocol 1.0 client hello', () => {
		const message = {
			type: 'client_hello',
			data: {
				protocolMajor: PROTOCOL_MAJOR,
				protocolMinor: PROTOCOL_MINOR,
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
			[1, 1]
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
		maxCount: 16,
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
				lobbyWins: 0
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
		]
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
			createFatalError('server_shutting_down'),
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
							maxCount: 16
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
						maxCount: 16,
						resumeToken: 'must-not-leak'
					}
				]
			}
		};

		expect(() => encodeServerMessage(invalidMessage as never)).toThrow(ProtocolError);
	});

	test('builds command errors from stable codes without accepting unsafe detail', () => {
		expect(createCommandError('request-1', 'permission_denied')).toEqual({
			type: 'command_error',
			requestId: 'request-1',
			data: {
				code: 'permission_denied',
				displayMessageKey: 'arena.error.permissionDenied'
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
