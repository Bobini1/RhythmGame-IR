import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import { ArenaApplication } from '../../src/application/arena-application.ts';
import type { ArenaIdentity, VerifiedArenaTicket } from '../../src/auth/identity.ts';
import { TicketVerificationError, type TicketVerifier } from '../../src/auth/ticket-verifier.ts';
import type { ClientMessage, RoomSnapshot, ServerMessage } from '../../src/protocol/messages.ts';
import { encodeHashChunk } from '../../src/protocol/binary.ts';
import {
	createRoomDirectoryWithEntropy,
	type RoomDirectory
} from '../../src/rooms/room-directory.ts';
import type { PasswordHasher } from '../../src/rooms/password-hasher.ts';
import { FakePasswordHasher } from '../helpers/fake-password-hasher.ts';

const NOW = Date.parse('2026-07-10T12:00:00.000Z');
const alice: ArenaIdentity = { userId: 'alice', displayName: 'Alice', avatarUrl: null };
const bob: ArenaIdentity = { userId: 'bob', displayName: 'Bob', avatarUrl: null };

class FakeTicketVerifier implements TicketVerifier {
	readonly calls: Array<Readonly<{ ticket: string; now: Date }>> = [];

	async verify(ticket: string, now: Date): Promise<VerifiedArenaTicket> {
		this.calls.push({ ticket, now });
		if (ticket === 'invalid-ticket') throw new TicketVerificationError('invalid_ticket');
		const identity = ticket.startsWith('bob') ? bob : alice;
		return {
			identity,
			emailVerified: true,
			jti: 'jti-1',
			issuedAt: new Date(now.getTime() - 1_000),
			expiresAt: new Date(now.getTime() + 89_000),
			protocolMajor: 1,
			protocolMinor: 0
		};
	}
}

class DeferredTicketVerifier implements TicketVerifier {
	resolve!: (ticket: VerifiedArenaTicket) => void;
	readonly promise = new Promise<VerifiedArenaTicket>((resolve) => {
		this.resolve = resolve;
	});

	verify(): Promise<VerifiedArenaTicket> {
		return this.promise;
	}
}

class DeferredHashPasswordHasher implements PasswordHasher {
	resolve!: (digest: string) => void;
	readonly hashPromise = new Promise<string>((resolve) => {
		this.resolve = resolve;
	});

	hash(): Promise<string> {
		return this.hashPromise;
	}

	async verify(password: string, digest: string): Promise<boolean> {
		return digest === `digest:${password}`;
	}
}

function deterministicBytes(): (length: number) => Uint8Array {
	let value = 1;
	return (length) => new Uint8Array(length).fill(value++);
}

function createDirectory(): RoomDirectory {
	return createRoomDirectoryWithEntropy(
		{ roomCapacity: 32, reconnectGraceMs: 60_000, chatBacklog: 200 },
		new FakePasswordHasher(),
		deterministicBytes()
	);
}

function hello(ticket?: string): ClientMessage {
	const authenticated = ticket !== undefined;
	return {
		type: 'client_hello',
		data: {
			protocolMajor: 1,
			protocolMinor: 0,
			clientVersion: 'test',
			capabilities: authenticated ? ['rooms-v1', 'rounds-v1', 'competition-v1'] : ['rooms-v1'],
			...(ticket === undefined ? {} : { ticket })
		}
	};
}

function createApplication(directory = createDirectory()) {
	const verifier = new FakeTicketVerifier();
	const application = new ArenaApplication({
		ticketVerifier: verifier,
		roomDirectory: directory,
		now: () => NOW,
		newNonce: () => 'nonce-1'
	});
	return { application, directory, verifier };
}

async function authenticate(
	application: ArenaApplication,
	connectionId: string,
	ticket = `${connectionId}-ticket`,
	nowMs = NOW
): Promise<void> {
	application.connect(connectionId);
	const deliveries = await application.receive(connectionId, hello(ticket), nowMs);
	expect(deliveries[0]).toEqual(
		expect.objectContaining({
			kind: 'send',
			connectionIds: [connectionId],
			message: expect.objectContaining({ type: 'server_hello' })
		})
	);
}

function messagesFor(
	deliveries: readonly import('../../src/application/delivery.ts').Delivery[],
	connectionId: string
): ServerMessage[] {
	return deliveries.flatMap((delivery) =>
		delivery.kind === 'send' && delivery.connectionIds.includes(connectionId)
			? [delivery.message]
			: []
	);
}

function snapshotFrom(
	deliveries: readonly import('../../src/application/delivery.ts').Delivery[]
): RoomSnapshot {
	const message = deliveries.find(
		(delivery) => delivery.kind === 'send' && delivery.message.type === 'room_snapshot'
	);
	if (message?.kind !== 'send' || message.message.type !== 'room_snapshot') {
		throw new Error('Expected a room_snapshot delivery.');
	}
	if (!('selection' in message.message.data)) {
		throw new Error('Expected a Phase 2 room_snapshot delivery.');
	}
	return message.message.data;
}

function inventoryBytes(values: readonly number[]): Uint8Array {
	const bytes = new Uint8Array(values.length * 32);
	for (let index = 0; index < values.length; ++index) {
		new DataView(bytes.buffer, index * 32, 32).setUint32(28, values[index]!, false);
	}
	return bytes;
}

function inventoryDeclaration(bytes: Uint8Array, libraryGeneration: number) {
	return {
		libraryGeneration,
		hashCount: bytes.byteLength / 32,
		byteCount: bytes.byteLength,
		chunkCount: bytes.byteLength === 0 ? 0 : 1,
		vectorDigest: createHash('sha256').update(bytes).digest('hex')
	};
}

describe('ArenaApplication connection protocol', () => {
	test('treats binary before an expected room upload as fatal without reflecting bytes', async () => {
		const { application } = createApplication();
		application.connect('binary-before-hello');
		const secretBytes = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
		const deliveries = await application.receiveBinary('binary-before-hello', secretBytes, NOW);
		expect(deliveries).toEqual([
			{
				kind: 'send',
				connectionIds: ['binary-before-hello'],
				message: {
					type: 'fatal_error',
					data: {
						code: 'unexpected_binary',
						displayMessageKey: 'arena.error.unexpectedBinary'
					}
				}
			},
			{
				kind: 'close',
				connectionId: 'binary-before-hello',
				code: 1003,
				reason: 'unexpected_binary'
			}
		]);
		expect(JSON.stringify(deliveries)).not.toContain('deadbeef');
	});

	test('requires client_hello first and accepts it only once', async () => {
		const { application } = createApplication();
		application.connect('c1');

		const missingHello = await application.receive(
			'c1',
			{ type: 'directory_subscribe', data: {} },
			NOW
		);
		expect(missingHello).toEqual([
			{
				kind: 'send',
				connectionIds: ['c1'],
				message: {
					type: 'fatal_error',
					data: { code: 'hello_required', displayMessageKey: 'arena.error.helloRequired' }
				}
			},
			{ kind: 'close', connectionId: 'c1', code: 1002, reason: 'hello_required' }
		]);

		application.connect('c2');
		const accepted = await application.receive('c2', hello(), NOW);
		expect(accepted).toEqual([
			{
				kind: 'send',
				connectionIds: ['c2'],
				message: {
					type: 'server_hello',
					data: {
						protocolMajor: 1,
						protocolMinor: 0,
						capabilities: ['rooms-v1'],
						resume: { status: 'not_requested' }
					}
				}
			}
		]);
		expect(await application.receive('c2', hello(), NOW)).toEqual([
			expect.objectContaining({
				kind: 'send',
				message: expect.objectContaining({
					type: 'fatal_error',
					data: expect.objectContaining({ code: 'hello_repeated' })
				})
			}),
			{ kind: 'close', connectionId: 'c2', code: 1002, reason: 'hello_repeated' }
		]);
	});

	test('lets anonymous clients subscribe but rejects authenticated mutations without closing', async () => {
		const { application } = createApplication();
		application.connect('c1');
		await application.receive('c1', hello(), NOW);

		expect(await application.receive('c1', { type: 'directory_subscribe', data: {} }, NOW)).toEqual(
			[
				{
					kind: 'send',
					connectionIds: ['c1'],
					message: { type: 'directory_snapshot', data: { revision: 0, rooms: [] } }
				}
			]
		);
		expect(
			await application.receive(
				'c1',
				{ type: 'room_create', requestId: 'create-1', data: { name: 'Room' } },
				NOW
			)
		).toEqual([
			{
				kind: 'send',
				connectionIds: ['c1'],
				message: {
					type: 'command_error',
					requestId: 'create-1',
					data: { code: 'auth_required', displayMessageKey: 'arena.error.authRequired' }
				}
			}
		]);
	});

	test('negotiates capabilities in server order and gates playable-room admission', async () => {
		const { application } = createApplication();
		application.connect('legacy-auth');
		const legacyHello = await application.receive(
			'legacy-auth',
			{
				type: 'client_hello',
				data: {
					protocolMajor: 1,
					protocolMinor: 0,
					clientVersion: 'legacy',
					capabilities: ['rooms-v1'],
					ticket: 'legacy-ticket'
				}
			},
			NOW
		);
		expect(messagesFor(legacyHello, 'legacy-auth')).toEqual([
			expect.objectContaining({
				type: 'server_hello',
				data: expect.objectContaining({ protocolMinor: 0, capabilities: ['rooms-v1'] })
			})
		]);
		expect(
			messagesFor(
				await application.receive(
					'legacy-auth',
					{ type: 'room_create', requestId: 'legacy-create', data: { name: 'No' } },
					NOW
				),
				'legacy-auth'
			)
		).toEqual([
			{
				type: 'command_error',
				requestId: 'legacy-create',
				data: {
					code: 'competition_capability_required',
					displayMessageKey: 'arena.error.competitionCapabilityRequired'
				}
			}
		]);

		application.connect('modern-auth');
		const modernHello = await application.receive(
			'modern-auth',
			{
				type: 'client_hello',
				data: {
					protocolMajor: 1,
					protocolMinor: 0,
					clientVersion: 'modern',
					capabilities: ['rounds-v1', 'rooms-v1'],
					ticket: 'modern-ticket'
				}
			},
			NOW
		);
		expect(messagesFor(modernHello, 'modern-auth')).toEqual([
			expect.objectContaining({
				type: 'server_hello',
				data: expect.objectContaining({
					protocolMinor: 0,
					capabilities: ['rooms-v1', 'rounds-v1']
				})
			})
		]);
		expect(
			messagesFor(
				await application.receive(
					'modern-auth',
					{ type: 'room_create', requestId: 'modern-create', data: { name: 'No' } },
					NOW
				),
				'modern-auth'
			)
		).toEqual([
			{
				type: 'command_error',
				requestId: 'modern-create',
				data: {
					code: 'competition_capability_required',
					displayMessageKey: 'arena.error.competitionCapabilityRequired'
				}
			}
		]);

		application.connect('competition-auth');
		const competitionHello = await application.receive(
			'competition-auth',
			{
				type: 'client_hello',
				data: {
					protocolMajor: 1,
					protocolMinor: 0,
					clientVersion: 'competition',
					capabilities: ['competition-v1', 'rooms-v1', 'rounds-v1'],
					ticket: 'competition-ticket'
				}
			},
			NOW
		);
		expect(messagesFor(competitionHello, 'competition-auth')).toEqual([
			expect.objectContaining({
				type: 'server_hello',
				data: expect.objectContaining({
					protocolMinor: 0,
					capabilities: ['rooms-v1', 'rounds-v1', 'competition-v1']
				})
			})
		]);
		const competitionCreated = await application.receive(
			'competition-auth',
			{ type: 'room_create', requestId: 'competition-create', data: { name: 'Competition' } },
			NOW
		);
		const competitionRoom = snapshotFrom(competitionCreated);
		expect(
			messagesFor(
				await application.receive(
					'modern-auth',
					{
						type: 'room_join',
						requestId: 'modern-join',
						data: { roomId: competitionRoom.roomId }
					},
					NOW
				),
				'modern-auth'
			)
		).toEqual([
			{
				type: 'command_error',
				requestId: 'modern-join',
				data: {
					code: 'competition_capability_required',
					displayMessageKey: 'arena.error.competitionCapabilityRequired'
				}
			}
		]);
	});

	test('authenticates from the verifier and correlates create while leave is observed by room events', async () => {
		const { application, verifier } = createApplication();
		application.connect('c1');
		const serverHello = await application.receive('c1', hello('sentinel-ticket'), NOW);
		expect(verifier.calls).toEqual([{ ticket: 'sentinel-ticket', now: new Date(NOW) }]);
		expect(serverHello[0]).toEqual(
			expect.objectContaining({
				kind: 'send',
				message: expect.objectContaining({
					type: 'server_hello',
					data: expect.objectContaining({ identity: alice })
				})
			})
		);
		expect(JSON.stringify(serverHello)).not.toContain('sentinel-ticket');

		const created = await application.receive(
			'c1',
			{ type: 'room_create', requestId: 'create-1', data: { name: 'Room' } },
			NOW
		);
		expect(created[0]).toEqual(
			expect.objectContaining({
				kind: 'send',
				connectionIds: ['c1'],
				message: expect.objectContaining({ type: 'room_snapshot', requestId: 'create-1' })
			})
		);
		const snapshot = created[0]?.kind === 'send' ? created[0].message : undefined;
		expect(snapshot?.type).toBe('room_snapshot');
		if (snapshot?.type !== 'room_snapshot') return;

		const left = await application.receive(
			'c1',
			{
				type: 'room_leave',
				requestId: 'leave-1',
				data: {
					roomId: snapshot.data.roomId,
					roomGeneration: snapshot.data.roomGeneration,
					connectionGeneration: snapshot.data.self.connectionGeneration
				}
			},
			NOW
		);
		expect(
			left.some(
				(delivery) => delivery.kind === 'send' && delivery.message.type === 'room_member_left'
			)
		).toBe(true);
		expect(JSON.stringify(left)).not.toContain('leave-1');
	});
});

describe('ArenaApplication room orchestration', () => {
	test('restores inventory state after a terminal upload validation failure', async () => {
		const { application } = createApplication();
		await authenticate(application, 'alice');
		const created = await application.receive(
			'alice',
			{ type: 'room_create', requestId: 'create-invalid-upload', data: { name: 'Upload' } },
			NOW
		);
		const room = snapshotFrom(created);
		const bytes = inventoryBytes([1]);
		const declaration = inventoryDeclaration(bytes, 1);
		const begun = await application.receive(
			'alice',
			{
				type: 'inventory_upload_begin',
				requestId: 'begin-invalid-upload',
				data: {
					roomId: room.roomId,
					roomGeneration: room.roomGeneration,
					connectionGeneration: room.self.connectionGeneration,
					...declaration
				}
			},
			NOW
		);
		const ready = messagesFor(begun, 'alice').find(
			(message) => message.type === 'inventory_upload_ready'
		);
		if (ready?.type !== 'inventory_upload_ready') throw new Error('upload not ready');
		await application.receiveBinary(
			'alice',
			encodeHashChunk({
				kind: 1,
				transferId: Uint8Array.from(Buffer.from(ready.data.uploadId, 'base64url')),
				chunkIndex: 0,
				hashes: bytes
			}),
			NOW + 1
		);
		const rejected = await application.receive(
			'alice',
			{
				type: 'inventory_upload_commit',
				requestId: 'commit-invalid-upload',
				data: {
					roomId: room.roomId,
					roomGeneration: room.roomGeneration,
					connectionGeneration: room.self.connectionGeneration,
					uploadId: ready.data.uploadId,
					...declaration,
					vectorDigest: '00'.repeat(32)
				}
			},
			NOW + 2
		);
		expect(messagesFor(rejected, 'alice')).toContainEqual(
			expect.objectContaining({
				type: 'command_error',
				data: expect.objectContaining({ code: 'inventory_invalid' })
			})
		);

		application.disconnect('alice', NOW + 3);
		application.connect('alice-resumed');
		const resumeHello = hello('alice-fresh') as Extract<ClientMessage, { type: 'client_hello' }>;
		const resumed = await application.receive(
			'alice-resumed',
			{
				type: 'client_hello',
				data: {
					...resumeHello.data,
					resume: { roomId: room.roomId, seatToken: room.self.resumeToken }
				}
			} as Extract<ClientMessage, { type: 'client_hello' }>,
			NOW + 4
		);
		const serverHello = messagesFor(resumed, 'alice-resumed')[0];
		if (serverHello?.type !== 'server_hello' || serverHello.data.resume.status !== 'succeeded') {
			throw new Error('resume failed');
		}
		const resumedMember = serverHello.data.resume.room.members[0];
		if (resumedMember === undefined || !('inventoryState' in resumedMember)) {
			throw new Error('expected Phase 2 member state');
		}
		expect(resumedMember.inventoryState).toBe('missing');
	});

	test('publishes two exact inventories and sends one atomic common reset per seat', async () => {
		const { application } = createApplication();
		await authenticate(application, 'alice');
		await authenticate(application, 'bob', 'bob-ticket');
		const created = await application.receive(
			'alice',
			{ type: 'room_create', requestId: 'create-inventory', data: { name: 'Inventory' } },
			NOW
		);
		const aliceRoom = snapshotFrom(created);
		const joined = await application.receive(
			'bob',
			{ type: 'room_join', requestId: 'join-inventory', data: { roomId: aliceRoom.roomId } },
			NOW
		);
		const bobRoom = snapshotFrom(joined);

		const upload = async (
			connectionId: string,
			room: RoomSnapshot,
			values: readonly number[],
			requestSuffix: string
		) => {
			const bytes = inventoryBytes(values);
			const declaration = inventoryDeclaration(bytes, 1);
			const begun = await application.receive(
				connectionId,
				{
					type: 'inventory_upload_begin',
					requestId: `begin-${requestSuffix}`,
					data: {
						roomId: room.roomId,
						roomGeneration: room.roomGeneration,
						connectionGeneration: room.self.connectionGeneration,
						...declaration
					}
				},
				NOW
			);
			const ready = messagesFor(begun, connectionId).find(
				(message) => message.type === 'inventory_upload_ready'
			);
			if (ready?.type !== 'inventory_upload_ready') throw new Error('upload not ready');
			if (bytes.byteLength > 0) {
				expect(
					await application.receiveBinary(
						connectionId,
						encodeHashChunk({
							kind: 1,
							transferId: Uint8Array.from(Buffer.from(ready.data.uploadId, 'base64url')),
							chunkIndex: 0,
							hashes: bytes
						}),
						NOW + 1
					)
				).toEqual([]);
			}
			return application.receive(
				connectionId,
				{
					type: 'inventory_upload_commit',
					requestId: `commit-${requestSuffix}`,
					data: {
						roomId: room.roomId,
						roomGeneration: room.roomGeneration,
						connectionGeneration: room.self.connectionGeneration,
						uploadId: ready.data.uploadId,
						...declaration
					}
				},
				NOW + 2
			);
		};

		const firstCommit = await upload('alice', aliceRoom, [1, 2, 3], 'alice');
		expect(
			messagesFor(firstCommit, 'alice').some(
				(message) => message.type === 'availability_transfer_begin'
			)
		).toBe(false);
		const secondCommit = await upload('bob', bobRoom, [2, 3, 4], 'bob');
		for (const connectionId of ['alice', 'bob']) {
			const messages = messagesFor(secondCommit, connectionId);
			expect(messages.some((message) => message.type === 'availability_transfer_begin')).toBe(true);
			expect(messages.some((message) => message.type === 'availability_transfer_commit')).toBe(
				true
			);
		}
		const binary = secondCommit.filter((delivery) => delivery.kind === 'send_binary');
		expect(binary).toHaveLength(2);
		expect(
			binary.every(
				(delivery) => delivery.kind === 'send_binary' && delivery.bytes.byteLength === 96
			)
		).toBe(true);
	});

	test('correlates password join, broadcasts revisions, and keeps resume token private', async () => {
		const directory = createRoomDirectoryWithEntropy(
			{ roomCapacity: 32, reconnectGraceMs: 60_000, chatBacklog: 200 },
			new FakePasswordHasher(),
			deterministicBytes()
		);
		const { application } = createApplication(directory);

		application.connect('browser');
		await application.receive('browser', hello(), NOW);
		await application.receive('browser', { type: 'directory_subscribe', data: {} }, NOW);
		await authenticate(application, 'alice-1');
		const created = await application.receive(
			'alice-1',
			{
				type: 'room_create',
				requestId: 'create-private',
				data: { name: 'Private room', password: 'correct horse' }
			},
			NOW
		);
		const room = snapshotFrom(created);
		expect(messagesFor(created, 'browser').map((message) => message.type)).toEqual([
			'room_directory_updated'
		]);

		await authenticate(application, 'bob-1', 'bob-ticket');
		const rejected = await application.receive(
			'bob-1',
			{
				type: 'room_join',
				requestId: 'join-wrong',
				data: { roomId: room.roomId, password: 'wrong' }
			},
			NOW
		);
		expect(messagesFor(rejected, 'bob-1')).toEqual([
			{
				type: 'command_error',
				requestId: 'join-wrong',
				data: {
					code: 'room_password_invalid',
					displayMessageKey: 'arena.error.roomPasswordInvalid'
				}
			}
		]);

		const joined = await application.receive(
			'bob-1',
			{
				type: 'room_join',
				requestId: 'join-correct',
				data: { roomId: room.roomId, password: 'correct horse' }
			},
			NOW
		);
		const bobSnapshot = snapshotFrom(joined);
		expect(messagesFor(joined, 'bob-1')[0]).toEqual(
			expect.objectContaining({ type: 'room_snapshot', requestId: 'join-correct' })
		);
		expect(messagesFor(joined, 'alice-1').map((message) => message.type)).toEqual([
			'room_member_joined'
		]);
		expect(messagesFor(joined, 'browser').map((message) => message.type)).toEqual([
			'room_directory_updated'
		]);
		const publicDeliveries = joined.filter(
			(delivery) => delivery.kind !== 'send' || !delivery.connectionIds.includes('bob-1')
		);
		expect(JSON.stringify(publicDeliveries)).not.toContain(bobSnapshot.self.resumeToken);
	});

	test('rejects mismatched binding fields in order and unbinds a live kick target', async () => {
		const { application } = createApplication();
		await authenticate(application, 'alice-1');
		const created = await application.receive(
			'alice-1',
			{ type: 'room_create', requestId: 'create-1', data: { name: 'Room' } },
			NOW
		);
		const owner = snapshotFrom(created);
		await authenticate(application, 'bob-1', 'bob-ticket');
		const joined = await application.receive(
			'bob-1',
			{ type: 'room_join', requestId: 'join-1', data: { roomId: owner.roomId } },
			NOW
		);
		const member = snapshotFrom(joined);

		const mismatches: Array<
			Readonly<{
				requestId: string;
				data: Extract<ClientMessage, { type: 'chat_send' }>['data'];
				code: string;
			}>
		> = [
			{
				requestId: 'wrong-room',
				data: {
					roomId: 'another-room',
					roomGeneration: member.roomGeneration + 1,
					connectionGeneration: member.self.connectionGeneration + 1,
					text: 'secret-chat'
				},
				code: 'not_in_room'
			},
			{
				requestId: 'wrong-room-generation',
				data: {
					roomId: member.roomId,
					roomGeneration: member.roomGeneration + 1,
					connectionGeneration: member.self.connectionGeneration + 1,
					text: 'secret-chat'
				},
				code: 'room_generation_stale'
			},
			{
				requestId: 'wrong-connection-generation',
				data: {
					roomId: member.roomId,
					roomGeneration: member.roomGeneration,
					connectionGeneration: member.self.connectionGeneration + 1,
					text: 'secret-chat'
				},
				code: 'connection_generation_stale'
			}
		];
		for (const mismatch of mismatches) {
			const deliveries = await application.receive(
				'bob-1',
				{ type: 'chat_send', requestId: mismatch.requestId, data: mismatch.data },
				NOW
			);
			expect(messagesFor(deliveries, 'bob-1')[0]).toEqual(
				expect.objectContaining({
					type: 'command_error',
					requestId: mismatch.requestId,
					data: expect.objectContaining({ code: mismatch.code })
				})
			);
			expect(JSON.stringify(deliveries)).not.toContain('secret-chat');
		}

		const validChat = await application.receive(
			'bob-1',
			{
				type: 'chat_send',
				requestId: 'chat-valid',
				data: {
					roomId: member.roomId,
					roomGeneration: member.roomGeneration,
					connectionGeneration: member.self.connectionGeneration,
					text: 'hello'
				}
			},
			NOW
		);
		expect(messagesFor(validChat, 'alice-1').map((message) => message.type)).toEqual([
			'chat_message'
		]);
		expect(messagesFor(validChat, 'bob-1').map((message) => message.type)).toEqual([
			'chat_message'
		]);

		const kicked = await application.receive(
			'alice-1',
			{
				type: 'room_kick',
				requestId: 'kick-1',
				data: {
					roomId: owner.roomId,
					roomGeneration: owner.roomGeneration,
					connectionGeneration: owner.self.connectionGeneration,
					targetMemberId: member.self.memberId
				}
			},
			NOW
		);
		expect(messagesFor(kicked, 'bob-1')).toEqual([
			expect.objectContaining({
				type: 'room_member_left',
				data: expect.objectContaining({ reason: 'kicked' })
			})
		]);
		const afterKick = await application.receive(
			'bob-1',
			{
				type: 'chat_send',
				requestId: 'chat-after-kick',
				data: {
					roomId: member.roomId,
					roomGeneration: member.roomGeneration,
					connectionGeneration: member.self.connectionGeneration,
					text: 'should not send'
				}
			},
			NOW
		);
		expect(messagesFor(afterKick, 'bob-1')[0]).toEqual(
			expect.objectContaining({
				type: 'command_error',
				requestId: 'chat-after-kick',
				data: expect.objectContaining({ code: 'not_in_room' })
			})
		);
	});
});

describe('ArenaApplication resume and liveness', () => {
	test('resumes just before grace expiry and uses one non-enumerating failure at the exact boundary', async () => {
		const { application } = createApplication();
		await authenticate(application, 'alice-1');
		const created = await application.receive(
			'alice-1',
			{ type: 'room_create', requestId: 'create-1', data: { name: 'Room' } },
			NOW
		);
		const room = snapshotFrom(created);
		application.disconnect('alice-1', NOW);

		application.connect('alice-legacy-resume');
		const legacyResume = await application.receive(
			'alice-legacy-resume',
			{
				type: 'client_hello',
				data: {
					protocolMajor: 1,
					protocolMinor: 0,
					clientVersion: 'legacy-resume',
					capabilities: ['rooms-v1', 'rounds-v1'],
					ticket: 'alice-legacy-fresh',
					resume: { roomId: room.roomId, seatToken: room.self.resumeToken }
				}
			},
			NOW + 1
		);
		expect(messagesFor(legacyResume, 'alice-legacy-resume')).toEqual([
			expect.objectContaining({
				type: 'server_hello',
				data: expect.objectContaining({
					protocolMinor: 0,
					resume: {
						status: 'failed',
						code: 'competition_capability_required',
						displayMessageKey: 'arena.error.competitionCapabilityRequired'
					}
				})
			})
		]);

		application.connect('alice-2');
		const resumed = await application.receive(
			'alice-2',
			{
				...hello('alice-fresh'),
				data: {
					...hello('alice-fresh').data,
					resume: { roomId: room.roomId, seatToken: room.self.resumeToken }
				}
			} as Extract<ClientMessage, { type: 'client_hello' }>,
			NOW + 59_999
		);
		expect(messagesFor(resumed, 'alice-2')[0]).toEqual(
			expect.objectContaining({
				type: 'server_hello',
				data: expect.objectContaining({
					identity: alice,
					resume: expect.objectContaining({ status: 'succeeded' })
				})
			})
		);
		const resumedHello = messagesFor(resumed, 'alice-2')[0];
		if (resumedHello?.type !== 'server_hello' || resumedHello.data.resume.status !== 'succeeded') {
			throw new Error('Expected successful resume hello.');
		}
		expect(resumedHello.data.resume.room.self.connectionGeneration).toBe(2);
		expect(resumedHello.data.resume.room.self.resumeToken).not.toBe(room.self.resumeToken);

		application.disconnect('alice-2', NOW + 59_999);
		application.connect('alice-3');
		const expired = await application.receive(
			'alice-3',
			{
				...hello('alice-another-fresh'),
				data: {
					...hello('alice-another-fresh').data,
					resume: {
						roomId: room.roomId,
						seatToken: resumedHello.data.resume.room.self.resumeToken
					}
				}
			} as Extract<ClientMessage, { type: 'client_hello' }>,
			NOW + 119_999
		);
		// The second reservation started at NOW + 59_999, so NOW + 119_999 is the exclusive boundary.
		expect(messagesFor(expired, 'alice-3')).toEqual([
			{
				type: 'server_hello',
				data: {
					protocolMajor: 1,
					protocolMinor: 0,
					capabilities: ['rooms-v1', 'rounds-v1', 'competition-v1'],
					identity: alice,
					resume: {
						status: 'failed',
						code: 'room_resume_failed',
						displayMessageKey: 'arena.error.resumeFailed'
					}
				}
			}
		]);
		expect(
			await application.receive('alice-3', { type: 'directory_subscribe', data: {} }, NOW + 119_999)
		).toHaveLength(1);
	});

	test('detaches a matching stale live binding before closing the replaced socket', async () => {
		const { application, directory } = createApplication();
		await authenticate(application, 'alice-1');
		const created = await application.receive(
			'alice-1',
			{ type: 'room_create', requestId: 'create-1', data: { name: 'Room' } },
			NOW
		);
		const room = snapshotFrom(created);
		const oldBinding = {
			roomId: room.roomId,
			roomGeneration: room.roomGeneration,
			seatId: room.self.memberId,
			connectionId: 'alice-1',
			connectionGeneration: room.self.connectionGeneration,
			userId: alice.userId
		};
		expect(directory.disconnect(oldBinding, NOW).ok).toBe(true);

		application.connect('alice-2');
		const resumed = await application.receive(
			'alice-2',
			{
				...hello('alice-fresh'),
				data: {
					...hello('alice-fresh').data,
					resume: { roomId: room.roomId, seatToken: room.self.resumeToken }
				}
			} as Extract<ClientMessage, { type: 'client_hello' }>,
			NOW + 1
		);
		expect(resumed[0]).toEqual(
			expect.objectContaining({
				kind: 'send',
				connectionIds: ['alice-2'],
				message: expect.objectContaining({ type: 'server_hello' })
			})
		);
		expect(resumed).toContainEqual({
			kind: 'close',
			connectionId: 'alice-1',
			code: 4001,
			reason: 'seat_replaced'
		});
		expect(
			await application.receive(
				'alice-1',
				{
					type: 'chat_send',
					requestId: 'stale-chat',
					data: {
						roomId: room.roomId,
						roomGeneration: room.roomGeneration,
						connectionGeneration: room.self.connectionGeneration,
						text: 'stale'
					}
				},
				NOW + 2
			)
		).toEqual([]);
		expect(application.disconnect('alice-1', NOW + 2)).toEqual([]);
	});

	test('enforces hello and heartbeat deadlines once and reserves a timed-out room seat', async () => {
		const { application } = createApplication();
		application.connect('silent');
		expect(application.sweep(NOW + 9_999)).toEqual([]);
		expect(application.sweep(NOW + 10_000)).toEqual([
			expect.objectContaining({
				kind: 'send',
				message: expect.objectContaining({
					type: 'fatal_error',
					data: expect.objectContaining({ code: 'hello_required' })
				})
			}),
			{ kind: 'close', connectionId: 'silent', code: 1002, reason: 'hello_required' }
		]);
		expect(application.sweep(NOW + 10_000)).toEqual([]);

		await authenticate(application, 'alice-1');
		await application.receive(
			'alice-1',
			{ type: 'room_create', requestId: 'create-1', data: { name: 'Room' } },
			NOW
		);
		const heartbeat = application.sweep(NOW + 20_000);
		expect(messagesFor(heartbeat, 'alice-1')).toEqual([
			{ type: 'server_heartbeat', data: { nonce: 'nonce-1', sentAtMs: NOW + 20_000 } }
		]);
		expect(application.sweep(NOW + 20_000)).toEqual([]);
		await application.receive(
			'alice-1',
			{ type: 'heartbeat_reply', data: { nonce: 'wrong-nonce' } },
			NOW + 20_001
		);
		const timeout = application.sweep(NOW + 60_000);
		expect(timeout).toContainEqual({
			kind: 'close',
			connectionId: 'alice-1',
			code: 1001,
			reason: 'heartbeat_timeout'
		});
		expect(application.sweep(NOW + 60_000)).toEqual([]);
	});
});

describe('ArenaApplication awaited-operation safety', () => {
	test('drops a completed ticket verification after disconnect without retaining credentials', async () => {
		const verifier = new DeferredTicketVerifier();
		const directory = createDirectory();
		const application = new ArenaApplication({
			ticketVerifier: verifier,
			roomDirectory: directory,
			now: () => NOW,
			newNonce: () => 'nonce'
		});
		application.connect('c1');
		const pending = application.receive('c1', hello('sentinel-ticket'), NOW);
		expect(application.disconnect('c1', NOW + 1)).toEqual([]);
		verifier.resolve({
			identity: alice,
			emailVerified: true,
			jti: 'jti-late',
			issuedAt: new Date(NOW - 1_000),
			expiresAt: new Date(NOW + 89_000),
			protocolMajor: 1,
			protocolMinor: 0
		});
		expect(await pending).toEqual([]);
	});

	test('compensates a room committed after its creating connection disappears', async () => {
		const hasher = new DeferredHashPasswordHasher();
		const directory = createRoomDirectoryWithEntropy(
			{ roomCapacity: 32, reconnectGraceMs: 60_000, chatBacklog: 200 },
			hasher,
			deterministicBytes()
		);
		const { application } = createApplication(directory);
		application.connect('browser');
		await application.receive('browser', hello(), NOW);
		await application.receive('browser', { type: 'directory_subscribe', data: {} }, NOW);
		await authenticate(application, 'alice-1');

		const pending = application.receive(
			'alice-1',
			{
				type: 'room_create',
				requestId: 'create-slow',
				data: { name: 'Ghost candidate', password: 'sentinel-password' }
			},
			NOW
		);
		expect(application.disconnect('alice-1', NOW + 1)).toEqual([]);
		hasher.resolve('digest:sentinel-password');
		const cleanup = await pending;
		expect(directory.list().rooms).toEqual([]);
		expect(messagesFor(cleanup, 'browser')).toEqual([
			expect.objectContaining({
				type: 'room_directory_updated',
				data: expect.objectContaining({ upserts: [], removedRoomIds: expect.any(Array) })
			})
		]);
		expect(JSON.stringify(cleanup)).not.toContain('sentinel-password');
	});

	test('compensates a password join without exposing a member that was never admitted', async () => {
		const hasher = new FakePasswordHasher();
		const directory = createRoomDirectoryWithEntropy(
			{ roomCapacity: 32, reconnectGraceMs: 60_000, chatBacklog: 200 },
			hasher,
			deterministicBytes()
		);
		const { application } = createApplication(directory);
		application.connect('browser');
		await application.receive('browser', hello(), NOW);
		await application.receive('browser', { type: 'directory_subscribe', data: {} }, NOW);
		await authenticate(application, 'alice-1');
		const created = await application.receive(
			'alice-1',
			{
				type: 'room_create',
				requestId: 'create-private',
				data: { name: 'Private', password: 'sentinel-password' }
			},
			NOW
		);
		const room = snapshotFrom(created);
		await authenticate(application, 'bob-1', 'bob-ticket');
		const deferred = hasher.deferVerify();
		const pending = application.receive(
			'bob-1',
			{
				type: 'room_join',
				requestId: 'join-slow',
				data: { roomId: room.roomId, password: 'sentinel-password' }
			},
			NOW
		);
		expect(application.disconnect('bob-1', NOW + 1)).toEqual([]);
		deferred.resolve(true);
		const cleanup = await pending;

		expect(directory.list().rooms[0]).toEqual(
			expect.objectContaining({ connectedCount: 1, reservedCount: 0 })
		);
		expect(messagesFor(cleanup, 'alice-1')).toEqual([]);
		expect(messagesFor(cleanup, 'browser')).toEqual([
			expect.objectContaining({
				type: 'room_directory_updated',
				data: expect.objectContaining({ upserts: [expect.objectContaining({ connectedCount: 1 })] })
			})
		]);
		expect(JSON.stringify(cleanup)).not.toContain('sentinel-password');
	});

	test('sanitizes ticket failures without reflecting credential or verifier text', async () => {
		const { application } = createApplication();
		application.connect('c1');
		const failed = await application.receive('c1', hello('invalid-ticket'), NOW);
		expect(failed).toEqual([
			expect.objectContaining({
				kind: 'send',
				message: {
					type: 'fatal_error',
					data: { code: 'invalid_ticket', displayMessageKey: 'arena.error.invalidTicket' }
				}
			}),
			{ kind: 'close', connectionId: 'c1', code: 1008, reason: 'invalid_ticket' }
		]);
		expect(JSON.stringify(failed)).not.toContain('invalid-ticket');
	});
});

describe('ArenaApplication identity mutation limits', () => {
	test('expires password-attempt limits without reflecting the password', async () => {
		const { application } = createApplication();
		await authenticate(application, 'alice-1');
		const created = await application.receive(
			'alice-1',
			{
				type: 'room_create',
				requestId: 'create-private',
				data: { name: 'Private', password: 'correct-password' }
			},
			NOW
		);
		const room = snapshotFrom(created);
		await authenticate(application, 'bob-1', 'bob-ticket');

		for (let attempt = 1; attempt <= 10; attempt += 1) {
			const rejected = await application.receive(
				'bob-1',
				{
					type: 'room_join',
					requestId: `wrong-${attempt}`,
					data: { roomId: room.roomId, password: 'sentinel-wrong-password' }
				},
				NOW
			);
			expect(messagesFor(rejected, 'bob-1')[0]).toEqual(
				expect.objectContaining({
					type: 'command_error',
					data: expect.objectContaining({ code: 'room_password_invalid' })
				})
			);
		}
		const limited = await application.receive(
			'bob-1',
			{
				type: 'room_join',
				requestId: 'wrong-11',
				data: { roomId: room.roomId, password: 'sentinel-wrong-password' }
			},
			NOW
		);
		expect(messagesFor(limited, 'bob-1')[0]).toEqual(
			expect.objectContaining({
				type: 'command_error',
				requestId: 'wrong-11',
				data: expect.objectContaining({ code: 'rate_limited' })
			})
		);
		expect(JSON.stringify(limited)).not.toContain('sentinel-wrong-password');

		const expired = await application.receive(
			'bob-1',
			{
				type: 'room_join',
				requestId: 'after-window',
				data: { roomId: room.roomId, password: 'sentinel-wrong-password' }
			},
			NOW + 60_000
		);
		expect(messagesFor(expired, 'bob-1')[0]).toEqual(
			expect.objectContaining({
				type: 'command_error',
				data: expect.objectContaining({ code: 'room_password_invalid' })
			})
		);
	});
});
