import { describe, expect, test } from 'bun:test';

import type { ArenaIdentity } from '../../src/auth/identity.ts';
import {
	createRoomDirectoryWithEntropy,
	type RoomDirectory
} from '../../src/rooms/room-directory.ts';
import { BunPasswordHasher } from '../../src/rooms/bun-password-hasher.ts';
import { FakePasswordHasher } from '../helpers/fake-password-hasher.ts';

const identity: ArenaIdentity = {
	userId: 'u1',
	displayName: 'Alice',
	avatarUrl: null
};

function deterministicBytes(): (length: number) => Uint8Array {
	let value = 1;
	return (length) => new Uint8Array(length).fill(value++);
}

function createDirectory(): RoomDirectory {
	return createRoomDirectoryWithEntropy(
		{ roomCapacity: 16, reconnectGraceMs: 60_000, chatBacklog: 200 },
		new FakePasswordHasher(),
		deterministicBytes()
	);
}

describe('RoomDirectory lifecycle', () => {
	test('creates a private admission and an exact anonymous summary atomically', async () => {
		const directory = createDirectory();
		expect(directory.list()).toEqual({ revision: 0, rooms: [] });

		const created = await directory.create({
			connectionId: 'c1',
			identity,
			name: 'First room'
		});

		expect(created.ok).toBe(true);
		if (!created.ok) return;

		const summary = directory.list();
		expect(summary).toEqual({
			revision: 1,
			rooms: [
				{
					roomId: created.value.binding.roomId,
					name: 'First room',
					phase: 'selecting',
					hasPassword: false,
					connectedCount: 1,
					reservedCount: 0,
					maxCount: 16
				}
			]
		});
		expect(Object.keys(summary.rooms[0]!).sort()).toEqual([
			'connectedCount',
			'hasPassword',
			'maxCount',
			'name',
			'phase',
			'reservedCount',
			'roomId'
		]);
		expect(JSON.stringify(summary)).not.toContain('Alice');
		expect(JSON.stringify(summary)).not.toContain(created.value.resumeToken);

		expect(created.value.snapshot).toEqual({
			roomId: created.value.binding.roomId,
			roomGeneration: 1,
			name: 'First room',
			phase: 'selecting',
			hasPassword: false,
			maxCount: 16,
			ownerMemberId: created.value.binding.seatId,
			self: {
				memberId: created.value.binding.seatId,
				connectionGeneration: 1,
				resumeToken: created.value.resumeToken
			},
			members: [
				{
					memberId: created.value.binding.seatId,
					identity,
					status: 'connected',
					lobbyWins: 0,
					ready: false,
					inventoryState: 'missing',
					inventoryRevision: 0,
					availabilityAppliedRevision: 0,
					roundState: 'eligible'
				}
			],
			chat: [],
			selection: null,
			selectionRevision: 0,
			availabilityRevision: 0,
			liveStandings: null,
			lastRoundResult: null
		});
		expect(created.effects).toEqual([]);
		expect(created.directoryChange).toEqual({
			revision: 1,
			upserts: [summary.rooms[0]!],
			removedRoomIds: []
		});
	});

	test('destroys the room on the final explicit leave with one removal revision', async () => {
		const directory = createDirectory();
		const created = await directory.create({ connectionId: 'c1', identity, name: 'Temporary' });
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		const left = directory.leave(created.value.binding, 10);

		expect(left).toEqual({
			ok: true,
			value: undefined,
			effects: [
				{
					type: 'member_left',
					targets: ['c1'],
					roomId: created.value.binding.roomId,
					roomGeneration: 1,
					memberId: created.value.binding.seatId,
					reason: 'left'
				}
			],
			directoryChange: {
				revision: 2,
				upserts: [],
				removedRoomIds: [created.value.binding.roomId]
			}
		});
		expect(directory.list()).toEqual({ revision: 2, rooms: [] });
	});
});

describe('room passwords', () => {
	test('hashes and verifies exact untrimmed password bytes without exposing the digest', async () => {
		const hasher = new FakePasswordHasher();
		let byte = 1;
		const directory = createRoomDirectoryWithEntropy(
			{ roomCapacity: 16, reconnectGraceMs: 60_000, chatBacklog: 200 },
			hasher,
			(length) => new Uint8Array(length).fill(byte++)
		);
		const created = await directory.create({
			connectionId: 'c1',
			identity,
			name: 'Private',
			password: ' p '
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		expect(hasher.hashCalls).toEqual([' p ']);
		expect(directory.list().rooms[0]?.hasPassword).toBe(true);
		expect(JSON.stringify(created)).not.toContain('digest:');

		expect(
			await directory.join({
				roomId: created.value.binding.roomId,
				connectionId: 'c2',
				identity: { userId: 'u2', displayName: 'Bob', avatarUrl: null }
			})
		).toEqual({ ok: false, rejection: { code: 'room_password_invalid' } });
		expect(
			await directory.join({
				roomId: created.value.binding.roomId,
				connectionId: 'c2',
				identity: { userId: 'u2', displayName: 'Bob', avatarUrl: null },
				password: 'p'
			})
		).toEqual({ ok: false, rejection: { code: 'room_password_invalid' } });
		const joined = await directory.join({
			roomId: created.value.binding.roomId,
			connectionId: 'c2',
			identity: { userId: 'u2', displayName: 'Bob', avatarUrl: null },
			password: ' p '
		});
		expect(joined.ok).toBe(true);
		expect(hasher.verifyCalls).toEqual([
			{ password: 'p', digest: 'digest: p ' },
			{ password: ' p ', digest: 'digest: p ' }
		]);
	});

	test('defensively rejects an empty direct-domain password instead of creating a public room', async () => {
		const directory = createDirectory();
		expect(
			await directory.create({ connectionId: 'c1', identity, name: 'Invalid', password: '' })
		).toEqual({ ok: false, rejection: { code: 'room_password_invalid' } });
		expect(directory.list()).toEqual({ revision: 0, rooms: [] });
	});

	test('uses Bun asynchronous Argon2id with exact password bytes', async () => {
		const hasher = new BunPasswordHasher();
		const digest = await hasher.hash(' p ');

		expect(digest.startsWith('$argon2id$')).toBe(true);
		expect(await hasher.verify(' p ', digest)).toBe(true);
		expect(await hasher.verify('p', digest)).toBe(false);
	});

	test('checks a valid password before exposing duplicate or lifetime-ban state', async () => {
		const hasher = new FakePasswordHasher();
		let byte = 1;
		const directory = createRoomDirectoryWithEntropy(
			{ roomCapacity: 16, reconnectGraceMs: 60_000, chatBacklog: 200 },
			hasher,
			(length) => new Uint8Array(length).fill(byte++)
		);
		const created = await directory.create({
			connectionId: 'c1',
			identity,
			name: 'Private',
			password: 'secret'
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		expect(
			await directory.join({
				roomId: created.value.binding.roomId,
				connectionId: 'duplicate',
				identity,
				password: 'wrong'
			})
		).toEqual({ ok: false, rejection: { code: 'room_password_invalid' } });
		expect(
			await directory.join({
				roomId: created.value.binding.roomId,
				connectionId: 'duplicate',
				identity,
				password: 'secret'
			})
		).toEqual({ ok: false, rejection: { code: 'room_duplicate_identity' } });

		const secondIdentity = { userId: 'u2', displayName: 'Bob', avatarUrl: null } as const;
		const second = await directory.join({
			roomId: created.value.binding.roomId,
			connectionId: 'c2',
			identity: secondIdentity,
			password: 'secret'
		});
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		directory.kick(created.value.binding, second.value.binding.seatId, 0);
		expect(
			await directory.join({
				roomId: created.value.binding.roomId,
				connectionId: 'banned',
				identity: secondIdentity,
				password: 'wrong'
			})
		).toEqual({ ok: false, rejection: { code: 'room_password_invalid' } });
		expect(
			await directory.join({
				roomId: created.value.binding.roomId,
				connectionId: 'banned',
				identity: secondIdentity,
				password: 'secret'
			})
		).toEqual({ ok: false, rejection: { code: 'room_banned' } });
	});
});

describe('password admission races', () => {
	function raceDirectory(hasher: FakePasswordHasher): RoomDirectory {
		let byte = 1;
		return createRoomDirectoryWithEntropy(
			{ roomCapacity: 16, reconnectGraceMs: 60_000, chatBacklog: 200 },
			hasher,
			(length) => new Uint8Array(length).fill(byte++)
		);
	}

	async function privateRoomWithCount(
		directory: RoomDirectory,
		count: number
	): Promise<Extract<Awaited<ReturnType<RoomDirectory['create']>>, { ok: true }>> {
		const created = await directory.create({
			connectionId: 'c1',
			identity,
			name: 'Race',
			password: 'secret'
		});
		if (!created.ok) throw new Error(`setup failed: ${created.rejection.code}`);
		for (let number = 2; number <= count; number++) {
			const joined = await directory.join({
				roomId: created.value.binding.roomId,
				connectionId: `c${number}`,
				identity: { userId: `u${number}`, displayName: `Player ${number}`, avatarUrl: null },
				password: 'secret'
			});
			if (!joined.ok) throw new Error(`setup failed: ${joined.rejection.code}`);
		}
		return created;
	}

	test.each(['first', 'second'] as const)(
		'admits only the %s resolved verifier when two subjects race for the final seat',
		async (winner) => {
			const hasher = new FakePasswordHasher();
			const directory = raceDirectory(hasher);
			const created = await privateRoomWithCount(directory, 15);
			const firstVerify = hasher.deferVerify();
			const secondVerify = hasher.deferVerify();
			const first = directory.join({
				roomId: created.value.binding.roomId,
				connectionId: 'c16-a',
				identity: { userId: 'u16-a', displayName: 'A', avatarUrl: null },
				password: 'secret'
			});
			const second = directory.join({
				roomId: created.value.binding.roomId,
				connectionId: 'c16-b',
				identity: { userId: 'u16-b', displayName: 'B', avatarUrl: null },
				password: 'secret'
			});
			expect(directory.list().revision).toBe(15);

			const winnerHandle = winner === 'first' ? firstVerify : secondVerify;
			const loserHandle = winner === 'first' ? secondVerify : firstVerify;
			const winnerPromise = winner === 'first' ? first : second;
			const loserPromise = winner === 'first' ? second : first;
			winnerHandle.resolve(true);
			const admitted = await winnerPromise;
			expect(admitted.ok).toBe(true);
			if (admitted.ok) expect(admitted.directoryChange?.revision).toBe(16);
			loserHandle.resolve(true);
			expect(await loserPromise).toEqual({ ok: false, rejection: { code: 'room_full' } });
			expect(directory.list()).toMatchObject({
				revision: 16,
				rooms: [{ connectedCount: 16, reservedCount: 0 }]
			});
		}
	);

	test.each(['first', 'second'] as const)(
		'admits only the %s resolved connection when one subject races itself',
		async (winner) => {
			const hasher = new FakePasswordHasher();
			const directory = raceDirectory(hasher);
			const created = await privateRoomWithCount(directory, 1);
			const firstVerify = hasher.deferVerify();
			const secondVerify = hasher.deferVerify();
			const duplicateIdentity = { userId: 'same', displayName: 'Same', avatarUrl: null };
			const first = directory.join({
				roomId: created.value.binding.roomId,
				connectionId: 'same-a',
				identity: duplicateIdentity,
				password: 'secret'
			});
			const second = directory.join({
				roomId: created.value.binding.roomId,
				connectionId: 'same-b',
				identity: duplicateIdentity,
				password: 'secret'
			});

			const winnerHandle = winner === 'first' ? firstVerify : secondVerify;
			const loserHandle = winner === 'first' ? secondVerify : firstVerify;
			const winnerPromise = winner === 'first' ? first : second;
			const loserPromise = winner === 'first' ? second : first;
			winnerHandle.resolve(true);
			expect((await winnerPromise).ok).toBe(true);
			loserHandle.resolve(true);
			expect(await loserPromise).toEqual({
				ok: false,
				rejection: { code: 'room_duplicate_identity' }
			});
			expect(directory.list()).toMatchObject({ revision: 2, rooms: [{ connectedCount: 2 }] });
		}
	);

	test('rechecks reservations, bans, room lifetime, and connection binding after verification', async () => {
		const hasher = new FakePasswordHasher();
		const directory = raceDirectory(hasher);
		const created = await privateRoomWithCount(directory, 15);

		const firstVerify = hasher.deferVerify();
		const secondVerify = hasher.deferVerify();
		const first = directory.join({
			roomId: created.value.binding.roomId,
			connectionId: 'final-a',
			identity: { userId: 'final-a', displayName: 'A', avatarUrl: null },
			password: 'secret'
		});
		const second = directory.join({
			roomId: created.value.binding.roomId,
			connectionId: 'final-b',
			identity: { userId: 'final-b', displayName: 'B', avatarUrl: null },
			password: 'secret'
		});
		directory.disconnect(created.value.binding, 0);
		expect(directory.list()).toMatchObject({
			revision: 16,
			rooms: [{ connectedCount: 14, reservedCount: 1 }]
		});
		secondVerify.resolve(true);
		expect((await second).ok).toBe(true);
		firstVerify.resolve(true);
		expect(await first).toEqual({ ok: false, rejection: { code: 'room_full' } });
		expect(directory.list().revision).toBe(17);

		const smallHasher = new FakePasswordHasher();
		const small = raceDirectory(smallHasher);
		const smallCreated = await privateRoomWithCount(small, 1);
		const joined = await small.join({
			roomId: smallCreated.value.binding.roomId,
			connectionId: 'existing',
			identity: { userId: 'target', displayName: 'Target', avatarUrl: null },
			password: 'secret'
		});
		expect(joined.ok).toBe(true);
		if (!joined.ok) return;
		const banVerify = smallHasher.deferVerify();
		const pendingBanned = small.join({
			roomId: smallCreated.value.binding.roomId,
			connectionId: 'pending-ban',
			identity: { userId: 'target', displayName: 'Target', avatarUrl: null },
			password: 'secret'
		});
		small.kick(smallCreated.value.binding, joined.value.binding.seatId, 0);
		banVerify.resolve(true);
		expect(await pendingBanned).toEqual({ ok: false, rejection: { code: 'room_banned' } });

		const lifetimeVerify = smallHasher.deferVerify();
		const pendingDestroyed = small.join({
			roomId: smallCreated.value.binding.roomId,
			connectionId: 'pending-destroy',
			identity: { userId: 'new', displayName: 'New', avatarUrl: null },
			password: 'secret'
		});
		small.leave(smallCreated.value.binding, 0);
		lifetimeVerify.resolve(true);
		expect(await pendingDestroyed).toEqual({ ok: false, rejection: { code: 'room_not_found' } });

		const bindingHasher = new FakePasswordHasher();
		const bindingDirectory = raceDirectory(bindingHasher);
		const bindingRoom = await privateRoomWithCount(bindingDirectory, 1);
		const bindingVerify = bindingHasher.deferVerify();
		const pendingBinding = bindingDirectory.join({
			roomId: bindingRoom.value.binding.roomId,
			connectionId: 'shared-connection',
			identity: { userId: 'waiting', displayName: 'Waiting', avatarUrl: null },
			password: 'secret'
		});
		expect(
			(
				await bindingDirectory.create({
					connectionId: 'shared-connection',
					identity: { userId: 'elsewhere', displayName: 'Elsewhere', avatarUrl: null },
					name: 'Elsewhere'
				})
			).ok
		).toBe(true);
		bindingVerify.resolve(true);
		expect(await pendingBinding).toEqual({
			ok: false,
			rejection: { code: 'already_in_room' }
		});
	});
});
