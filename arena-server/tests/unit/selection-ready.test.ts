import { describe, expect, test } from 'bun:test';

import type { ArenaIdentity } from '../../src/auth/identity.ts';
import { PackedInventory } from '../../src/inventory/packed-inventory.ts';
import type { SelectionSnapshot } from '../../src/protocol/messages.ts';
import {
	createRoomDirectoryWithEntropy,
	type RoomDirectory
} from '../../src/rooms/room-directory.ts';
import type { SeatAdmission } from '../../src/rooms/models.ts';
import { FakePasswordHasher } from '../helpers/fake-password-hasher.ts';

const alice: ArenaIdentity = { userId: 'alice', displayName: 'Alice', avatarUrl: null };
const bob: ArenaIdentity = { userId: 'bob', displayName: 'Bob', avatarUrl: null };

function sha(value: number): string {
	return value.toString(16).padStart(64, '0');
}

function packed(values: readonly number[]): PackedInventory {
	return PackedInventory.fromSortedBytes(
		Uint8Array.from(
			values.flatMap((value) => [
				...new Uint8Array(28),
				...Buffer.from(value.toString(16).padStart(8, '0'), 'hex')
			])
		)
	);
}

function selection(value: number, title = `Chart ${value}`): SelectionSnapshot {
	return {
		sha256: sha(value),
		title,
		subtitle: '',
		artist: 'Artist',
		keyMode: 7,
		randomSequence: [1, 2],
		noteOrderP1: 'normal_or_mirror',
		noteOrderP2: 'normal_or_mirror',
		dpMode: 'off',
		laneSeed: '0123456789abcdef',
		randomizationVersion: 1
	};
}

function createDirectory(): RoomDirectory {
	let entropy = 1;
	return createRoomDirectoryWithEntropy(
		{ roomCapacity: 32, reconnectGraceMs: 60_000, chatBacklog: 200 },
		new FakePasswordHasher(),
		(length) => new Uint8Array(length).fill(entropy++)
	);
}

async function readyRoom(directory: RoomDirectory, includeBob = true) {
	const created = await directory.create({ connectionId: 'c1', identity: alice, name: 'Room' });
	if (!created.ok) throw new Error('create failed');
	const seats: SeatAdmission[] = [created.value];
	if (includeBob) {
		const joined = await directory.join({
			roomId: created.value.binding.roomId,
			connectionId: 'c2',
			identity: bob
		});
		if (!joined.ok) throw new Error('join failed');
		seats.push(joined.value);
	}
	for (const [index, seat] of seats.entries()) {
		directory.markInventorySyncing(seat.binding, 1, index);
		const committed = directory.replaceInventory(
			seat.binding,
			{ libraryGeneration: 1 },
			packed(index === 0 ? [1, 2, 3] : [2, 3, 4]),
			index
		);
		if (!committed.ok) throw new Error('inventory commit failed');
	}
	const availability = directory.requestAvailabilityReset(seats[0]!.binding, 10);
	if (!availability.ok) throw new Error('availability missing');
	for (const seat of seats) {
		const acknowledged = directory.ackAvailability(seat.binding, availability.value.revision, 11);
		if (!acknowledged.ok) throw new Error('ack failed');
	}
	return { seats, availabilityRevision: availability.value.revision };
}

describe('Arena selection and ready state', () => {
	test('allows any member to replace an immutable selection in acceptance order', async () => {
		const directory = createDirectory();
		const { seats, availabilityRevision } = await readyRoom(directory);
		const first = directory.select(
			seats[0]!.binding,
			selection(2, 'First'),
			{ availabilityRevision, inventoryRevision: 1 },
			20
		);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.value.selectionRevision).toBe(1);
		const mutable = selection(3, 'Second');
		const second = directory.select(
			seats[1]!.binding,
			mutable,
			{ availabilityRevision, inventoryRevision: 2 },
			21
		);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		mutable.title = 'mutated after acceptance';
		expect(second.value.selection.title).toBe('Second');
		expect(second.value.selectionRevision).toBe(2);
		expect(second.value.selectedByMemberId).toBe(seats[1]!.binding.seatId);
	});

	test('rejects a non-common or stale selection without replacing the previous one', async () => {
		const directory = createDirectory();
		const { seats, availabilityRevision } = await readyRoom(directory);
		const accepted = directory.select(
			seats[0]!.binding,
			selection(2),
			{ availabilityRevision, inventoryRevision: 1 },
			20
		);
		if (!accepted.ok) throw new Error('selection failed');
		const rejected = directory.select(
			seats[0]!.binding,
			selection(1),
			{ availabilityRevision, inventoryRevision: 1 },
			21
		);
		expect(rejected).toEqual({
			ok: false,
			rejection: { code: 'selection_not_common', missingMemberIds: [seats[1]!.binding.seatId] }
		});
		expect(
			directory.select(
				seats[0]!.binding,
				selection(3),
				{ availabilityRevision: availabilityRevision + 1, inventoryRevision: 1 },
				22
			)
		).toEqual({ ok: false, rejection: { code: 'selection_stale' } });
		const ready = directory.setReady(
			seats[0]!.binding,
			true,
			{
				selectionRevision: accepted.value.selectionRevision,
				availabilityRevision,
				inventoryRevision: 1
			},
			23
		);
		expect(ready.ok).toBe(true);
	});

	test('atomically freezes the ordered roster only when every eligible seat is connected and ready', async () => {
		const directory = createDirectory();
		const { seats, availabilityRevision } = await readyRoom(directory);
		const selected = directory.select(
			seats[0]!.binding,
			selection(2),
			{ availabilityRevision, inventoryRevision: 1 },
			20
		);
		if (!selected.ok) throw new Error('selection failed');
		const revisions = {
			selectionRevision: selected.value.selectionRevision,
			availabilityRevision,
			inventoryRevision: 1
		};
		const firstReady = directory.setReady(seats[0]!.binding, true, revisions, 21);
		expect(firstReady.ok).toBe(true);
		if (!firstReady.ok) return;
		expect(firstReady.value.round).toBeUndefined();
		const frozen = directory.setReady(
			seats[1]!.binding,
			true,
			{ ...revisions, inventoryRevision: 2 },
			22
		);
		expect(frozen.ok).toBe(true);
		if (!frozen.ok || frozen.value.round === undefined) return;
		expect(frozen.value.round.stage).toBe('probing');
		expect(frozen.value.round.selection).toEqual(selected.value.selection);
		expect(frozen.value.round.participants).toEqual([
			{ memberId: seats[0]!.binding.seatId, inventoryRevision: 1, identity: alice },
			{ memberId: seats[1]!.binding.seatId, inventoryRevision: 2, identity: bob }
		]);
		const effectTypes = frozen.effects.map((effect) => effect.type);
		expect(effectTypes).toContain('round_loading_started');
		expect(effectTypes.indexOf('round_loading_started')).toBeLessThan(
			effectTypes.indexOf('round_probe_requested')
		);
	});

	test('does not freeze while an eligible reserved seat is disconnected', async () => {
		const directory = createDirectory();
		const { seats, availabilityRevision } = await readyRoom(directory);
		const selected = directory.select(
			seats[0]!.binding,
			selection(2),
			{ availabilityRevision, inventoryRevision: 1 },
			20
		);
		if (!selected.ok) throw new Error('selection failed');
		directory.disconnect(seats[1]!.binding, 21);
		const result = directory.setReady(
			seats[0]!.binding,
			true,
			{
				selectionRevision: selected.value.selectionRevision,
				availabilityRevision,
				inventoryRevision: 1
			},
			22
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.round).toBeUndefined();
	});

	test('disconnect clears only that seat while preserving other next-round ready states', async () => {
		const directory = createDirectory();
		const { seats, availabilityRevision } = await readyRoom(directory);
		const selected = directory.select(
			seats[0]!.binding,
			selection(2),
			{ availabilityRevision, inventoryRevision: 1 },
			20
		);
		if (!selected.ok) throw new Error('selection failed');
		const ready = directory.setReady(
			seats[0]!.binding,
			true,
			{
				selectionRevision: selected.value.selectionRevision,
				availabilityRevision,
				inventoryRevision: 1
			},
			21
		);
		expect(ready.ok).toBe(true);
		directory.disconnect(seats[1]!.binding, 22);
		const resumed = directory.resume({
			roomId: seats[1]!.binding.roomId,
			connectionId: 'c2-resumed',
			identity: bob,
			resumeToken: seats[1]!.resumeToken,
			nowMs: 23
		});
		expect(resumed.ok).toBe(true);
		if (resumed.ok) {
			expect(
				resumed.value.snapshot.members.find(
					(member) => member.memberId === seats[0]!.binding.seatId
				)?.ready
			).toBe(true);
		}
	});

	test('supports a one-player freeze and marks a post-freeze join as waiting', async () => {
		const directory = createDirectory();
		const { seats, availabilityRevision } = await readyRoom(directory, false);
		const selected = directory.select(
			seats[0]!.binding,
			selection(1),
			{ availabilityRevision, inventoryRevision: 1 },
			20
		);
		if (!selected.ok) throw new Error('selection failed');
		const frozen = directory.setReady(
			seats[0]!.binding,
			true,
			{
				selectionRevision: selected.value.selectionRevision,
				availabilityRevision,
				inventoryRevision: 1
			},
			21
		);
		expect(frozen.ok && frozen.value.round?.participants).toHaveLength(1);
		if (frozen.ok && frozen.value.round !== undefined) {
			frozen.value.round.selection.title = 'mutated returned round';
		}
		const joined = await directory.join({
			roomId: seats[0]!.binding.roomId,
			connectionId: 'c2',
			identity: bob
		});
		expect(joined.ok).toBe(true);
		if (joined.ok) {
			expect(joined.value.snapshot.phase).toBe('loading');
			expect(joined.value.snapshot.members.at(-1)?.roundState).toBe('waiting');
			expect(joined.value.snapshot.round?.participants).toHaveLength(1);
			expect(joined.value.snapshot.round?.selection.title).toBe('Chart 1');
		}
	});
});
