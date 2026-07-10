export const SHA256_BYTES = 32;
export const MAX_INVENTORY_HASHES = 250_000;
export const MAX_INVENTORY_BYTES = MAX_INVENTORY_HASHES * SHA256_BYTES;

function compareHash(left: Uint8Array, right: Uint8Array): number {
	for (let index = 0; index < SHA256_BYTES; ++index) {
		const difference = left[index]! - right[index]!;
		if (difference !== 0) return difference;
	}
	return 0;
}

export class PackedInventory {
	readonly #bytes: Uint8Array;

	private constructor(bytes: Uint8Array) {
		this.#bytes = bytes;
	}

	static fromSortedBytes(input: Uint8Array): PackedInventory {
		if (
			!(input instanceof Uint8Array) ||
			input.byteLength % SHA256_BYTES !== 0 ||
			input.byteLength > MAX_INVENTORY_BYTES
		) {
			throw new Error('Invalid packed inventory.');
		}
		const bytes = Uint8Array.from(input);
		for (let offset = SHA256_BYTES; offset < bytes.byteLength; offset += SHA256_BYTES) {
			if (
				compareHash(
					bytes.subarray(offset - SHA256_BYTES, offset),
					bytes.subarray(offset, offset + SHA256_BYTES)
				) >= 0
			) {
				throw new Error('Invalid packed inventory ordering.');
			}
		}
		return new PackedInventory(bytes);
	}

	get count(): number {
		return this.#bytes.byteLength / SHA256_BYTES;
	}

	get byteLength(): number {
		return this.#bytes.byteLength;
	}

	copyBytes(): Uint8Array {
		return Uint8Array.from(this.#bytes);
	}
}
