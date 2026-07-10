import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';

import { planAvailabilityTransfer } from '../../src/inventory/availability-transfer.ts';
import { PackedInventory, SHA256_BYTES } from '../../src/inventory/packed-inventory.ts';
import { decodeHashChunk } from '../../src/protocol/binary.ts';

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

const transferId = Uint8Array.from({ length: 16 }, (_, index) => index);
const common = {
	roomId: 'room-1',
	roomGeneration: 2,
	transferId,
	targetRevision: 4,
	basis: [{ memberId: 'member-1', inventoryRevision: 3 }]
} as const;

describe('availability transfer planning', () => {
	test('forces an atomic reset after join/resume/resync or an unknown base', () => {
		const next = packed([2, 3]);
		const plan = planAvailabilityTransfer({
			...common,
			previous: packed([1, 2]),
			next,
			forceReset: true
		});
		expect(plan.begin.type).toBe('availability_transfer_begin');
		expect(plan.begin.data).toEqual({
			roomId: 'room-1',
			roomGeneration: 2,
			transferId: Buffer.from(transferId).toString('base64url'),
			mode: 'reset',
			targetRevision: 4,
			basis: [...common.basis],
			resetCount: 2,
			resetChunkCount: 1,
			resetDigest: createHash('sha256').update(next.copyBytes()).digest('hex')
		});
		expect(plan.frames).toHaveLength(1);
		expect(decodeHashChunk(plan.frames[0]!).kind).toBe(2);
		expect(plan.commit.data.targetRevision).toBe(4);
	});

	test('uses remove-then-add delta only when it is smaller than the reset', () => {
		const previous = packed([1, 2, 3, 4]);
		const next = packed([1, 2, 3, 5]);
		const plan = planAvailabilityTransfer({
			...common,
			baseRevision: 3,
			previous,
			next,
			forceReset: false
		});
		expect(plan.begin.data.mode).toBe('delta');
		expect(plan.frames.map((frame) => decodeHashChunk(frame).kind)).toEqual([4, 3]);
		const reset = planAvailabilityTransfer({
			...common,
			baseRevision: 3,
			previous: packed([1, 2]),
			next: packed([3]),
			forceReset: false
		});
		expect(reset.begin.data.mode).toBe('reset');
	});

	test('represents an empty reset with no binary chunks and a real empty digest', () => {
		const plan = planAvailabilityTransfer({ ...common, next: packed([]), forceReset: true });
		expect(plan.frames).toEqual([]);
		expect(plan.begin.data).toEqual(
			expect.objectContaining({
				mode: 'reset',
				resetCount: 0,
				resetChunkCount: 0,
				resetDigest: createHash('sha256').update(new Uint8Array()).digest('hex')
			})
		);
	});
});
