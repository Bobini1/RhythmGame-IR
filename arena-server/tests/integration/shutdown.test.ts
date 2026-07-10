import { afterEach, describe, expect, test } from 'bun:test';

import { ArenaApplication } from '../../src/application/arena-application.ts';
import type { ArenaIdentity, VerifiedArenaTicket } from '../../src/auth/identity.ts';
import type { TicketVerifier } from '../../src/auth/ticket-verifier.ts';
import { loadArenaConfig } from '../../src/config.ts';
import { InventoryUploadManager } from '../../src/inventory/inventory-upload-manager.ts';
import type { ClientMessage } from '../../src/protocol/messages.ts';
import { createRoomDirectory } from '../../src/rooms/room-directory.ts';
import { startArenaServer, type ArenaServerHandle } from '../../src/transport/start-server.ts';
import { FakePasswordHasher } from '../helpers/fake-password-hasher.ts';

let handle: ArenaServerHandle | undefined;

afterEach(async () => {
	await handle?.shutdown({ drainMs: 0 });
	handle = undefined;
});

describe('Arena graceful shutdown', () => {
	test('rejects upgrades first, keeps health live during drain, and finalizes once', async () => {
		let shutdownCalls = 0;
		let finalizeCalls = 0;
		const application = {
			connect: () => [],
			disconnect: () => [],
			receive: async () => [],
			receiveBinary: async () => [],
			sweep: () => [],
			nextDeadlineMs: () => undefined,
			shutdown: () => {
				shutdownCalls += 1;
				return [];
			},
			finalizeShutdown: () => {
				finalizeCalls += 1;
			}
		} as unknown as ArenaApplication;
		handle = startArenaServer({
			application,
			config: loadArenaConfig({ HOST: '127.0.0.1' }),
			portOverride: 0,
			maintenanceIntervalMs: 60_000
		});
		const origin = `http://127.0.0.1:${handle.port}`;

		const first = handle.shutdown({ drainMs: 100 });
		const second = handle.shutdown({ drainMs: 0 });
		expect(second).toBe(first);
		expect((await fetch(`${origin}/healthz`)).status).toBe(200);
		expect((await fetch(`${origin}/ws`)).status).toBe(503);
		expect(shutdownCalls).toBe(1);
		expect(finalizeCalls).toBe(0);
		await first;
		expect(shutdownCalls).toBe(1);
		expect(finalizeCalls).toBe(1);
		await expect(fetch(`${origin}/healthz`)).rejects.toThrow();
	});

	test('application shutdown stops new work, aborts uploads, and destroys ephemeral rooms', async () => {
		const identity: ArenaIdentity = {
			userId: 'shutdown-user',
			displayName: 'Shutdown User',
			avatarUrl: null
		};
		const verifier: TicketVerifier = {
			async verify(_ticket, now): Promise<VerifiedArenaTicket> {
				return {
					identity,
					emailVerified: true,
					jti: 'shutdown-jti',
					issuedAt: new Date(now.getTime() - 1_000),
					expiresAt: new Date(now.getTime() + 60_000),
					protocolMajor: 1,
					protocolMinor: 2
				};
			}
		};
		const uploads = new InventoryUploadManager({ newTransferId: () => new Uint8Array(16).fill(1) });
		const directory = createRoomDirectory(
			{ roomCapacity: 16, reconnectGraceMs: 60_000, chatBacklog: 200 },
			new FakePasswordHasher(),
			(inventory) => uploads.releaseCommitted(inventory)
		);
		const application = new ArenaApplication({
			ticketVerifier: verifier,
			roomDirectory: directory,
			now: () => 1_000,
			newNonce: () => 'shutdown-nonce',
			inventoryUploadManager: uploads
		});
		application.connect('connection');
		await application.receive('connection', hello('ticket'), 1_000);
		const created = await application.receive(
			'connection',
			{ type: 'room_create', requestId: 'create', data: { name: 'Ephemeral' } },
			1_001
		);
		const snapshot = created.find(
			(delivery) => delivery.kind === 'send' && delivery.message.type === 'room_snapshot'
		);
		if (snapshot?.kind !== 'send' || snapshot.message.type !== 'room_snapshot') {
			throw new Error('room setup failed');
		}
		const room = snapshot.message.data;
		const begun = uploads.begin(
			'connection',
			identity.userId,
			{
				libraryGeneration: 1,
				hashCount: 1,
				byteCount: 32,
				chunkCount: 1,
				vectorDigest: '00'.repeat(32)
			},
			1_002
		);
		expect(begun.ok).toBe(true);
		expect(uploads.pendingReservedBytes).toBe(32);
		expect(directory.list().rooms).toHaveLength(1);

		application.shutdown(1_003);
		expect(uploads.pendingReservedBytes).toBe(0);
		expect(
			await application.receive(
				'connection',
				{
					type: 'chat_send',
					requestId: 'ignored',
					data: {
						roomId: room.roomId,
						roomGeneration: room.roomGeneration,
						connectionGeneration: room.self.connectionGeneration,
						text: 'must not be accepted'
					}
				},
				1_004
			)
		).toEqual([]);
		application.finalizeShutdown();
		expect(directory.list().rooms).toEqual([]);
		expect(application.nextDeadlineMs()).toBeUndefined();
	});
});

function hello(ticket: string): ClientMessage {
	return {
		type: 'client_hello',
		data: {
			protocolMajor: 1,
			protocolMinor: 2,
			clientVersion: 'shutdown-test',
			capabilities: ['rooms-v1', 'rounds-v1', 'competition-v1'],
			ticket
		}
	};
}
