import { describe, expect, test } from 'bun:test';

import type { ArenaIdentity } from '../../src/auth/identity.ts';
import {
	createRoomDirectoryWithEntropy,
	type RoomDirectory
} from '../../src/rooms/room-directory.ts';
import { FakePasswordHasher } from '../helpers/fake-password-hasher.ts';
import { FakeClock } from '../helpers/fake-clock.ts';

function user(number: number): ArenaIdentity {
	return { userId: `u${number}`, displayName: `Player ${number}`, avatarUrl: null };
}

function createDirectory(): RoomDirectory {
	let byte = 1;
	return createRoomDirectoryWithEntropy(
		{ roomCapacity: 32, reconnectGraceMs: 60_000, chatBacklog: 200 },
		new FakePasswordHasher(),
		(length) => new Uint8Array(length).fill(byte++)
	);
}

describe('Room ownership and moderation', () => {
	test('admits a unique subject, broadcasts the member, and enforces one connection binding', async () => {
		const directory = createDirectory();
		const created = await directory.create({ connectionId: 'c1', identity: user(1), name: 'Room' });
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		const joined = await directory.join({
			roomId: created.value.binding.roomId,
			connectionId: 'c2',
			identity: user(2)
		});
		expect(joined.ok).toBe(true);
		if (!joined.ok) return;

		expect(joined.value.snapshot.ownerMemberId).toBe(created.value.binding.seatId);
		expect(joined.value.snapshot.members.map((member) => member.identity.userId)).toEqual([
			'u1',
			'u2'
		]);
		expect(joined.effects).toEqual([
			{
				type: 'member_joined',
				targets: ['c1'],
				roomId: created.value.binding.roomId,
				roomGeneration: 1,
				member: joined.value.snapshot.members[1]!
			}
		]);
		expect(joined.directoryChange?.revision).toBe(2);
		expect(directory.list().rooms[0]).toMatchObject({ connectedCount: 2, reservedCount: 0 });

		expect(
			await directory.join({
				roomId: created.value.binding.roomId,
				connectionId: 'c3',
				identity: user(2)
			})
		).toEqual({ ok: false, rejection: { code: 'room_duplicate_identity' } });
		expect(
			await directory.create({ connectionId: 'c1', identity: user(3), name: 'Other' })
		).toEqual({ ok: false, rejection: { code: 'already_in_room' } });

		const crossRoom = await directory.create({
			connectionId: 'c3',
			identity: user(1),
			name: 'Other'
		});
		expect(crossRoom.ok).toBe(true);
	});

	test('counts all thirty-two seats toward the fixed capacity', async () => {
		const directory = createDirectory();
		const created = await directory.create({ connectionId: 'c1', identity: user(1), name: 'Full' });
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		for (let number = 2; number <= 32; number++) {
			const joined = await directory.join({
				roomId: created.value.binding.roomId,
				connectionId: `c${number}`,
				identity: user(number)
			});
			expect(joined.ok).toBe(true);
		}

		expect(
			await directory.join({
				roomId: created.value.binding.roomId,
				connectionId: 'c33',
				identity: user(33)
			})
		).toEqual({ ok: false, rejection: { code: 'room_full' } });
		expect(directory.list()).toMatchObject({
			revision: 32,
			rooms: [{ connectedCount: 32, reservedCount: 0, maxCount: 32 }]
		});
	});

	test('transfers owner to the oldest connected member on explicit leave', async () => {
		const directory = createDirectory();
		const created = await directory.create({ connectionId: 'c1', identity: user(1), name: 'Room' });
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const second = await directory.join({
			roomId: created.value.binding.roomId,
			connectionId: 'c2',
			identity: user(2)
		});
		const third = await directory.join({
			roomId: created.value.binding.roomId,
			connectionId: 'c3',
			identity: user(3)
		});
		expect(second.ok && third.ok).toBe(true);
		if (!second.ok || !third.ok) return;

		const left = directory.leave(created.value.binding, 10);
		expect(left.ok).toBe(true);
		if (!left.ok) return;
		expect(left.effects).toEqual([
			{
				type: 'member_left',
				targets: ['c1', 'c2', 'c3'],
				roomId: created.value.binding.roomId,
				roomGeneration: 1,
				memberId: created.value.binding.seatId,
				reason: 'left'
			},
			{
				type: 'owner_changed',
				targets: ['c2', 'c3'],
				roomId: created.value.binding.roomId,
				roomGeneration: 1,
				ownerMemberId: second.value.binding.seatId
			}
		]);
		expect(left.directoryChange?.revision).toBe(4);
		expect(directory.list().rooms[0]).toMatchObject({ connectedCount: 2, reservedCount: 0 });
	});

	test('omits a zero-target owner event when the owner leaves only reserved members', async () => {
		const directory = createDirectory();
		const created = await directory.create({ connectionId: 'c1', identity: user(1), name: 'Room' });
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const second = await directory.join({
			roomId: created.value.binding.roomId,
			connectionId: 'c2',
			identity: user(2)
		});
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		directory.disconnect(second.value.binding, 0);

		const left = directory.leave(created.value.binding, 1);
		expect(left.ok).toBe(true);
		if (!left.ok) return;
		expect(left.effects).toEqual([
			{
				type: 'member_left',
				targets: ['c1'],
				roomId: created.value.binding.roomId,
				roomGeneration: 1,
				memberId: created.value.binding.seatId,
				reason: 'left'
			}
		]);
		expect(directory.list().rooms[0]).toMatchObject({ connectedCount: 0, reservedCount: 1 });
	});

	test('omits a zero-target member event when a fresh subject joins an all-reserved room', async () => {
		const directory = createDirectory();
		const created = await directory.create({ connectionId: 'c1', identity: user(1), name: 'Room' });
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		directory.disconnect(created.value.binding, 0);

		const joined = await directory.join({
			roomId: created.value.binding.roomId,
			connectionId: 'c2',
			identity: user(2)
		});

		expect(joined.ok).toBe(true);
		if (!joined.ok) return;
		expect(joined.value.snapshot.ownerMemberId).toBe(joined.value.binding.seatId);
		expect(joined.value.snapshot.members.map((member) => member.status)).toEqual([
			'reserved',
			'connected'
		]);
		expect(joined.effects).toEqual([]);
		expect(joined.directoryChange).toMatchObject({
			revision: 3,
			upserts: [{ connectedCount: 1, reservedCount: 1 }]
		});
	});

	test('allows only the owner to kick another member and bans the subject for room lifetime', async () => {
		const directory = createDirectory();
		const created = await directory.create({ connectionId: 'c1', identity: user(1), name: 'Room' });
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const second = await directory.join({
			roomId: created.value.binding.roomId,
			connectionId: 'c2',
			identity: user(2)
		});
		expect(second.ok).toBe(true);
		if (!second.ok) return;

		expect(directory.kick(second.value.binding, created.value.binding.seatId, 0)).toEqual({
			ok: false,
			rejection: { code: 'permission_denied' }
		});
		expect(directory.kick(created.value.binding, created.value.binding.seatId, 0)).toEqual({
			ok: false,
			rejection: { code: 'cannot_kick_self' }
		});
		expect(directory.kick(created.value.binding, 'missing-member', 0)).toEqual({
			ok: false,
			rejection: { code: 'target_not_found' }
		});

		const kicked = directory.kick(created.value.binding, second.value.binding.seatId, 0);
		expect(kicked.ok).toBe(true);
		if (!kicked.ok) return;
		expect(kicked.effects).toEqual([
			{
				type: 'member_left',
				targets: ['c1', 'c2'],
				roomId: created.value.binding.roomId,
				roomGeneration: 1,
				memberId: second.value.binding.seatId,
				reason: 'kicked',
				invalidatedBinding: second.value.binding
			}
		]);
		expect(kicked.directoryChange?.revision).toBe(3);
		expect(
			await directory.join({
				roomId: created.value.binding.roomId,
				connectionId: 'c3',
				identity: user(2)
			})
		).toEqual({ ok: false, rejection: { code: 'room_banned' } });

		directory.leave(created.value.binding, 1);
		const recreated = await directory.create({
			connectionId: 'c4',
			identity: user(2),
			name: 'Fresh'
		});
		expect(recreated.ok).toBe(true);
	});
});

describe('Room disconnect and resume', () => {
	test('guarantees token rotation even if deterministic entropy repeats token material', async () => {
		let opaqueByte = 1;
		let tokenCall = 0;
		const directory = createRoomDirectoryWithEntropy(
			{ roomCapacity: 32, reconnectGraceMs: 60_000, chatBacklog: 200 },
			new FakePasswordHasher(),
			(length) =>
				new Uint8Array(length).fill(length === 32 ? (tokenCall++ < 2 ? 42 : 43) : opaqueByte++)
		);
		const created = await directory.create({ connectionId: 'c1', identity: user(1), name: 'Room' });
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		directory.disconnect(created.value.binding, 0);

		const resumed = directory.resume({
			roomId: created.value.binding.roomId,
			connectionId: 'c2',
			identity: user(1),
			resumeToken: created.value.resumeToken,
			nowMs: 1
		});
		expect(resumed.ok).toBe(true);
		if (resumed.ok) expect(resumed.value.resumeToken).not.toBe(created.value.resumeToken);
	});

	test('reserves the exact binding, transfers ownership, and atomically rotates resume state', async () => {
		const directory = createDirectory();
		const clock = new FakeClock(1_000);
		const created = await directory.create({ connectionId: 'c1', identity: user(1), name: 'Room' });
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const second = await directory.join({
			roomId: created.value.binding.roomId,
			connectionId: 'c2',
			identity: user(2)
		});
		expect(second.ok).toBe(true);
		if (!second.ok) return;

		const disconnected = directory.disconnect(created.value.binding, clock.now());
		expect(disconnected.ok).toBe(true);
		if (!disconnected.ok) return;
		expect(disconnected.effects).toEqual([
			{
				type: 'member_updated',
				targets: ['c2'],
				roomId: created.value.binding.roomId,
				roomGeneration: 1,
				member: { ...created.value.snapshot.members[0]!, status: 'reserved' }
			},
			{
				type: 'owner_changed',
				targets: ['c2'],
				roomId: created.value.binding.roomId,
				roomGeneration: 1,
				ownerMemberId: second.value.binding.seatId
			}
		]);
		expect(disconnected.directoryChange).toMatchObject({
			revision: 3,
			upserts: [{ connectedCount: 1, reservedCount: 1 }]
		});
		expect(directory.disconnect(created.value.binding, clock.now())).toEqual({
			ok: true,
			value: undefined,
			effects: []
		});

		clock.set(60_999);
		const resumed = directory.resume({
			roomId: created.value.binding.roomId,
			connectionId: 'c3',
			identity: user(1),
			resumeToken: created.value.resumeToken,
			nowMs: clock.now()
		});
		expect(resumed.ok).toBe(true);
		if (!resumed.ok) return;
		expect(resumed.value.binding).toEqual({
			...created.value.binding,
			connectionId: 'c3',
			connectionGeneration: 2
		});
		expect(resumed.value.staleConnectionId).toBe('c1');
		expect(resumed.value.resumeToken).not.toBe(created.value.resumeToken);
		expect(resumed.value.snapshot.ownerMemberId).toBe(second.value.binding.seatId);
		expect(resumed.effects).toEqual([
			{
				type: 'member_updated',
				targets: ['c2'],
				roomId: created.value.binding.roomId,
				roomGeneration: 1,
				member: { ...created.value.snapshot.members[0]!, status: 'connected' }
			}
		]);
		expect(resumed.directoryChange?.revision).toBe(4);

		expect(directory.disconnect(created.value.binding, clock.now())).toEqual({
			ok: true,
			value: undefined,
			effects: []
		});
		expect(directory.leave(created.value.binding, clock.now())).toEqual({
			ok: false,
			rejection: { code: 'connection_generation_stale' }
		});
		expect(directory.kick(created.value.binding, second.value.binding.seatId, clock.now())).toEqual(
			{ ok: false, rejection: { code: 'connection_generation_stale' } }
		);

		directory.disconnect(resumed.value.binding, clock.now());
		expect(
			directory.resume({
				roomId: created.value.binding.roomId,
				connectionId: 'c4',
				identity: user(1),
				resumeToken: created.value.resumeToken,
				nowMs: clock.now()
			})
		).toEqual({ ok: false, rejection: { code: 'room_resume_failed' } });
		const resumedAgain = directory.resume({
			roomId: created.value.binding.roomId,
			connectionId: 'c4',
			identity: user(1),
			resumeToken: resumed.value.resumeToken,
			nowMs: clock.now()
		});
		expect(resumedAgain.ok).toBe(true);
		if (resumedAgain.ok) expect(resumedAgain.value.binding.connectionGeneration).toBe(3);
	});

	test('uses an exclusive grace deadline and removes each expired seat exactly once', async () => {
		const beforeDeadline = createDirectory();
		const before = await beforeDeadline.create({
			connectionId: 'c1',
			identity: user(1),
			name: 'Before'
		});
		expect(before.ok).toBe(true);
		if (!before.ok) return;
		beforeDeadline.disconnect(before.value.binding, 1_000);
		expect(
			beforeDeadline.resume({
				roomId: before.value.binding.roomId,
				connectionId: 'c2',
				identity: user(1),
				resumeToken: before.value.resumeToken,
				nowMs: 60_999
			}).ok
		).toBe(true);

		const atDeadline = createDirectory();
		const at = await atDeadline.create({ connectionId: 'c1', identity: user(1), name: 'At' });
		expect(at.ok).toBe(true);
		if (!at.ok) return;
		atDeadline.disconnect(at.value.binding, 1_000);
		expect(
			atDeadline.resume({
				roomId: at.value.binding.roomId,
				connectionId: 'c2',
				identity: user(1),
				resumeToken: at.value.resumeToken,
				nowMs: 61_000
			})
		).toEqual({ ok: false, rejection: { code: 'room_resume_failed' } });
		expect(atDeadline.list().revision).toBe(2);
		expect(atDeadline.sweep(61_000)).toEqual([
			{
				effects: [],
				directoryChange: {
					revision: 3,
					upserts: [],
					removedRoomIds: [at.value.binding.roomId]
				}
			}
		]);
		expect(atDeadline.sweep(61_000)).toEqual([]);
		expect(atDeadline.list()).toEqual({ revision: 3, rooms: [] });
	});

	test('keeps a reserved seat in capacity and allows the owner to kick it without a live binding', async () => {
		const directory = createDirectory();
		const created = await directory.create({ connectionId: 'c1', identity: user(1), name: 'Full' });
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		let lastBinding = created.value.binding;
		for (let number = 2; number <= 32; number++) {
			const joined = await directory.join({
				roomId: created.value.binding.roomId,
				connectionId: `c${number}`,
				identity: user(number)
			});
			expect(joined.ok).toBe(true);
			if (joined.ok) lastBinding = joined.value.binding;
		}
		directory.disconnect(lastBinding, 0);

		expect(
			await directory.join({
				roomId: created.value.binding.roomId,
				connectionId: 'c33',
				identity: user(33)
			})
		).toEqual({ ok: false, rejection: { code: 'room_full' } });
		expect(
			await directory.join({
				roomId: created.value.binding.roomId,
				connectionId: 'duplicate',
				identity: user(32)
			})
		).toEqual({ ok: false, rejection: { code: 'room_duplicate_identity' } });

		const kicked = directory.kick(created.value.binding, lastBinding.seatId, 1);
		expect(kicked.ok).toBe(true);
		if (!kicked.ok) return;
		expect(kicked.effects[0]).toEqual({
			type: 'member_left',
			targets: Array.from({ length: 31 }, (_, index) => `c${index + 1}`),
			roomId: created.value.binding.roomId,
			roomGeneration: 1,
			memberId: lastBinding.seatId,
			reason: 'kicked'
		});
	});

	test('makes every invalid resume case indistinguishable and assigns a null owner to the first resumer', async () => {
		const directory = createDirectory();
		const created = await directory.create({ connectionId: 'c1', identity: user(1), name: 'Room' });
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const second = await directory.join({
			roomId: created.value.binding.roomId,
			connectionId: 'c2',
			identity: user(2)
		});
		expect(second.ok).toBe(true);
		if (!second.ok) return;

		const failure = { ok: false, rejection: { code: 'room_resume_failed' } } as const;
		expect(
			directory.resume({
				roomId: 'wrong-room',
				connectionId: 'cx',
				identity: user(1),
				resumeToken: created.value.resumeToken,
				nowMs: 0
			})
		).toEqual(failure);
		expect(
			directory.resume({
				roomId: created.value.binding.roomId,
				connectionId: 'cx',
				identity: user(3),
				resumeToken: created.value.resumeToken,
				nowMs: 0
			})
		).toEqual(failure);
		expect(
			directory.resume({
				roomId: created.value.binding.roomId,
				connectionId: 'cx',
				identity: user(1),
				resumeToken: 'wrong-token',
				nowMs: 0
			})
		).toEqual(failure);
		expect(
			directory.resume({
				roomId: created.value.binding.roomId,
				connectionId: 'cx',
				identity: user(1),
				resumeToken: created.value.resumeToken,
				nowMs: 0
			})
		).toEqual(failure);

		directory.disconnect(created.value.binding, 0);
		directory.disconnect(second.value.binding, 0);
		const firstBack = directory.resume({
			roomId: created.value.binding.roomId,
			connectionId: 'c3',
			identity: user(1),
			resumeToken: created.value.resumeToken,
			nowMs: 1
		});
		expect(firstBack.ok).toBe(true);
		if (!firstBack.ok) return;
		expect(firstBack.value.snapshot.ownerMemberId).toBe(created.value.binding.seatId);
		const secondBack = directory.resume({
			roomId: created.value.binding.roomId,
			connectionId: 'c4',
			identity: user(2),
			resumeToken: second.value.resumeToken,
			nowMs: 1
		});
		expect(secondBack.ok).toBe(true);
		if (secondBack.ok)
			expect(secondBack.value.snapshot.ownerMemberId).toBe(created.value.binding.seatId);
	});
});

describe('Room chat', () => {
	test('derives the author and time, trims plain text, and rejects bounds without a revision', async () => {
		const directory = createDirectory();
		const created = await directory.create({ connectionId: 'c1', identity: user(1), name: 'Room' });
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		const sent = directory.sendChat(created.value.binding, '  <b>x</b>  ', 1234);
		expect(sent.ok).toBe(true);
		if (!sent.ok) return;
		expect(sent.value).toMatchObject({
			authorMemberId: created.value.binding.seatId,
			authorDisplayName: 'Player 1',
			sentAtMs: 1234,
			text: '<b>x</b>'
		});
		expect(sent.effects).toEqual([
			{
				type: 'chat_message',
				targets: ['c1'],
				roomId: created.value.binding.roomId,
				roomGeneration: 1,
				message: sent.value
			}
		]);
		expect(sent).not.toHaveProperty('directoryChange');
		expect(directory.list().revision).toBe(1);
		expect(directory.sendChat(created.value.binding, '   ', 1235)).toEqual({
			ok: false,
			rejection: { code: 'chat_empty' }
		});
		expect(directory.sendChat(created.value.binding, '😀'.repeat(501), 1236)).toEqual({
			ok: false,
			rejection: { code: 'chat_too_long' }
		});
		expect(directory.sendChat(created.value.binding, '😀'.repeat(500), 1237).ok).toBe(true);
	});

	test('uses a five-per-ten-second sliding window that survives resumption', async () => {
		const directory = createDirectory();
		const created = await directory.create({ connectionId: 'c1', identity: user(1), name: 'Room' });
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		for (const nowMs of [0, 1, 2, 3, 9_999]) {
			expect(directory.sendChat(created.value.binding, `at-${nowMs}`, nowMs).ok).toBe(true);
		}
		expect(directory.sendChat(created.value.binding, 'sixth', 9_999)).toEqual({
			ok: false,
			rejection: { code: 'rate_limited' }
		});

		directory.disconnect(created.value.binding, 9_999);
		const resumed = directory.resume({
			roomId: created.value.binding.roomId,
			connectionId: 'c2',
			identity: user(1),
			resumeToken: created.value.resumeToken,
			nowMs: 9_999
		});
		expect(resumed.ok).toBe(true);
		if (!resumed.ok) return;
		expect(directory.sendChat(resumed.value.binding, 'after-resume', 9_999)).toEqual({
			ok: false,
			rejection: { code: 'rate_limited' }
		});
		expect(directory.sendChat(resumed.value.binding, 'boundary', 10_000).ok).toBe(true);
		expect(directory.sendChat(created.value.binding, 'stale', 20_000)).toEqual({
			ok: false,
			rejection: { code: 'connection_generation_stale' }
		});
	});

	test('keeps the newest 200 messages in acceptance order with copied author names', async () => {
		const directory = createDirectory();
		const created = await directory.create({ connectionId: 'c1', identity: user(1), name: 'Room' });
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		for (let number = 1; number <= 201; number++) {
			const result = directory.sendChat(
				created.value.binding,
				`message-${number}`,
				(number - 1) * 2_001
			);
			expect(result.ok).toBe(true);
		}
		const second = await directory.join({
			roomId: created.value.binding.roomId,
			connectionId: 'c2',
			identity: user(2)
		});
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.value.snapshot.chat).toHaveLength(200);
		expect(second.value.snapshot.chat.map((message) => message.text)).toEqual(
			Array.from({ length: 200 }, (_, index) => `message-${index + 2}`)
		);
		expect(
			second.value.snapshot.chat.every((message) => message.authorDisplayName === 'Player 1')
		).toBe(true);

		directory.leave(created.value.binding, 500_000);
		const third = await directory.join({
			roomId: created.value.binding.roomId,
			connectionId: 'c3',
			identity: user(3)
		});
		expect(third.ok).toBe(true);
		if (third.ok) expect(third.value.snapshot.chat[0]?.authorDisplayName).toBe('Player 1');
	});
});
