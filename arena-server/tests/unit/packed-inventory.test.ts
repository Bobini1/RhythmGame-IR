import { describe, expect, test } from 'bun:test';

import { PackedInventory, SHA256_BYTES } from '../../src/inventory/packed-inventory.ts';

function packed(values: readonly number[]): PackedInventory {
	const bytes = new Uint8Array(values.length * SHA256_BYTES);
	for (let index = 0; index < values.length; ++index) {
		new DataView(bytes.buffer, index * SHA256_BYTES, SHA256_BYTES).setUint32(
			SHA256_BYTES - 4,
			values[index]!,
			false
		);
	}
	return PackedInventory.fromSortedBytes(bytes);
}

function hash(value: number): Uint8Array {
	return packed([value]).copyBytes();
}

function values(inventory: PackedInventory): number[] {
	const bytes = inventory.copyBytes();
	return Array.from({ length: inventory.count }, (_, index) =>
		new DataView(bytes.buffer, index * SHA256_BYTES, SHA256_BYTES).getUint32(
			SHA256_BYTES - 4,
			false
		)
	);
}

describe('PackedInventory set operations', () => {
	test('computes identical, disjoint, and partial intersections without string expansion', () => {
		expect(values(packed([1, 2, 3]).intersect(packed([1, 2, 3])))).toEqual([1, 2, 3]);
		expect(values(packed([1, 2]).intersect(packed([3, 4])))).toEqual([]);
		expect(
			values(PackedInventory.intersectAll([packed([1, 2, 3]), packed([2, 3, 4]), packed([3, 5])]))
		).toEqual([3]);
	});

	test('uses binary lookup and computes disjoint add/remove deltas', () => {
		const before = packed([1, 3, 5]);
		const after = packed([2, 3, 4]);
		expect(before.contains(hash(1))).toBe(true);
		expect(before.contains(hash(2))).toBe(false);
		const delta = before.deltaTo(after);
		expect(values(delta.added)).toEqual([2, 4]);
		expect(values(delta.removed)).toEqual([1, 5]);
	});

	test('rejects malformed, duplicate, descending, and over-cap vectors', () => {
		expect(() => PackedInventory.fromSortedBytes(new Uint8Array(31))).toThrow();
		expect(() => packed([1, 1])).toThrow();
		expect(() => packed([2, 1])).toThrow();
		expect(() => PackedInventory.fromSortedBytes(new Uint8Array((250_000 + 1) * 32))).toThrow();
		expect(() => packed([1]).contains(new Uint8Array(31))).toThrow();
	});
});
