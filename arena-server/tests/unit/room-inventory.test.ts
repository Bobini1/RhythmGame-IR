import { describe, expect, test } from 'bun:test';

import type { ArenaIdentity } from '../../src/auth/identity.ts';
import { PackedInventory, SHA256_BYTES } from '../../src/inventory/packed-inventory.ts';
import {
	createRoomDirectoryWithEntropy,
	type RoomDirectory
} from '../../src/rooms/room-directory.ts';
import { FakePasswordHasher } from '../helpers/fake-password-hasher.ts';

const alice: ArenaIdentity = { userId: 'alice', displayName: 'Alice', avatarUrl: null };
const bob: ArenaIdentity = { userId: 'bob', displayName: 'Bob', avatarUrl: null };

function packed(values: readonly number[]): PackedInventory {
	const bytes = new Uint8Array(values.length * SHA256_BYTES);
	for (let index = 0; index < values.length; ++index) {
		new DataView(bytes.buffer, index * SHA256_BYTES, SHA256_BYTES).setUint32(
			28,
			values[index]!,
			false
		);
	}
	return PackedInventory.fromSortedBytes(bytes);
}

function values(inventory: PackedInventory): number[] {
	const bytes = inventory.copyBytes();
	return Array.from({ length: inventory.count }, (_, index) =>
		new DataView(bytes.buffer, index * SHA256_BYTES, SHA256_BYTES).getUint32(28, false)
	);
}

function createDirectory(released: PackedInventory[] = []): RoomDirectory {
	let entropy = 1;
	return createRoomDirectoryWithEntropy(
		{ roomCapacity: 16, reconnectGraceMs: 60_000, chatBacklog: 200 },
		new FakePasswordHasher(),
		(length) => new Uint8Array(length).fill(entropy++),
		(inventory) => released.push(inventory)
	);
}

async function twoSeats(directory: RoomDirectory) {
	const created = await directory.create({ connectionId: 'c1', identity: alice, name: 'Room' });
	if (!created.ok) throw new Error('create failed');
	const joined = await directory.join({
		roomId: created.value.binding.roomId,
		connectionId: 'c2',
		identity: bob
	});
	if (!joined.ok) throw new Error('join failed');
	return { first: created.value, second: joined.value };
}

describe('RoomDirectory inventory and common availability', () => {
	test('commits strictly increasing generations and publishes the exact intersection', async () => {
		const directory = createDirectory();
		const { first, second } = await twoSeats(directory);
		expect(directory.markInventorySyncing(first.binding, 1, 0).ok).toBe(true);
		const firstCommit = directory.replaceInventory(
			first.binding,
			{ libraryGeneration: 1 },
			packed([1, 2, 3]),
			1
		);
		expect(firstCommit.ok).toBe(true);
		if (!firstCommit.ok) return;
		expect(firstCommit.value.availabilityRevision).toBe(0);

		expect(directory.markInventorySyncing(second.binding, 1, 2).ok).toBe(true);
		const secondCommit = directory.replaceInventory(
			second.binding,
			{ libraryGeneration: 1 },
			packed([2, 3, 4]),
			3
		);
		expect(secondCommit.ok).toBe(true);
		if (!secondCommit.ok) return;
		expect(secondCommit.value.availabilityRevision).toBe(1);
		const snapshot = directory.requestAvailabilityReset(first.binding, 4);
		expect(snapshot.ok).toBe(true);
		if (!snapshot.ok) return;
		expect(values(snapshot.value.inventory)).toEqual([2, 3]);
		expect(snapshot.value.basis.map((entry) => entry.memberId).sort()).toEqual(
			[first.binding.seatId, second.binding.seatId].sort()
		);
	});

	test('keeps reserved seats in the basis and requires exact availability acknowledgement', async () => {
		const directory = createDirectory();
		const { first, second } = await twoSeats(directory);
		directory.markInventorySyncing(first.binding, 1, 0);
		directory.replaceInventory(first.binding, { libraryGeneration: 1 }, packed([1, 2]), 1);
		directory.markInventorySyncing(second.binding, 1, 2);
		const committed = directory.replaceInventory(
			second.binding,
			{ libraryGeneration: 1 },
			packed([2, 3]),
			3
		);
		if (!committed.ok) throw new Error('commit failed');
		expect(
			directory.ackAvailability(first.binding, committed.value.availabilityRevision + 1, 4)
		).toEqual({
			ok: false,
			rejection: { code: 'availability_stale' }
		});
		expect(
			directory.ackAvailability(first.binding, committed.value.availabilityRevision, 4).ok
		).toBe(true);
		directory.disconnect(second.binding, 5);
		const reset = directory.requestAvailabilityReset(first.binding, 6);
		expect(reset.ok).toBe(true);
		if (reset.ok) expect(reset.value.basis).toHaveLength(2);
	});

	test('replaces atomically, rejects stale generations, and releases vectors on lifecycle removal', async () => {
		const released: PackedInventory[] = [];
		const directory = createDirectory(released);
		const created = await directory.create({ connectionId: 'c1', identity: alice, name: 'Room' });
		if (!created.ok) throw new Error('create failed');
		directory.markInventorySyncing(created.value.binding, 2, 0);
		const original = packed([1, 2]);
		expect(
			directory.replaceInventory(created.value.binding, { libraryGeneration: 2 }, original, 1).ok
		).toBe(true);
		expect(directory.markInventorySyncing(created.value.binding, 2, 2)).toEqual({
			ok: false,
			rejection: { code: 'inventory_stale' }
		});
		directory.markInventorySyncing(created.value.binding, 3, 3);
		const replacement = packed([2, 3]);
		expect(
			directory.replaceInventory(created.value.binding, { libraryGeneration: 3 }, replacement, 4).ok
		).toBe(true);
		expect(released).toContain(original);
		directory.leave(created.value.binding, 5);
		expect(released).toContain(replacement);
	});

	test('restores prior inventory state when a partial replacement aborts', async () => {
		const directory = createDirectory();
		const created = await directory.create({ connectionId: 'c1', identity: alice, name: 'Room' });
		if (!created.ok) throw new Error('create failed');
		directory.markInventorySyncing(created.value.binding, 1, 0);
		directory.replaceInventory(created.value.binding, { libraryGeneration: 1 }, packed([1]), 1);
		directory.markInventorySyncing(created.value.binding, 2, 2);
		const aborted = directory.abortInventorySync(created.value.binding, 2, 3);
		expect(aborted.ok).toBe(true);
		const reset = directory.requestAvailabilityReset(created.value.binding, 4);
		expect(reset.ok).toBe(true);
		if (reset.ok) expect(values(reset.value.inventory)).toEqual([1]);
	});
});
