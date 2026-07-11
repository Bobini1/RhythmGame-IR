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

	contains(hash: Uint8Array): boolean {
		if (!(hash instanceof Uint8Array) || hash.byteLength !== SHA256_BYTES) {
			throw new Error('A packed inventory lookup requires one SHA-256 value.');
		}
		let low = 0;
		let high = this.count;
		while (low < high) {
			const middle = low + Math.floor((high - low) / 2);
			const offset = middle * SHA256_BYTES;
			const comparison = compareHash(this.#bytes.subarray(offset, offset + SHA256_BYTES), hash);
			if (comparison < 0) low = middle + 1;
			else if (comparison > 0) high = middle;
			else return true;
		}
		return false;
	}

	intersect(other: PackedInventory): PackedInventory {
		if (this.equals(other)) return new PackedInventory(this.#bytes.slice());
		const output = new Uint8Array(Math.min(this.byteLength, other.byteLength));
		let left = 0;
		let right = 0;
		let written = 0;
		while (left < this.byteLength && right < other.byteLength) {
			const leftHash = this.#bytes.subarray(left, left + SHA256_BYTES);
			const rightHash = other.#bytes.subarray(right, right + SHA256_BYTES);
			const comparison = compareHash(leftHash, rightHash);
			if (comparison < 0) left += SHA256_BYTES;
			else if (comparison > 0) right += SHA256_BYTES;
			else {
				output.set(leftHash, written);
				written += SHA256_BYTES;
				left += SHA256_BYTES;
				right += SHA256_BYTES;
			}
		}
		return new PackedInventory(output.slice(0, written));
	}

	static intersectAll(inventories: readonly PackedInventory[]): PackedInventory {
		if (inventories.length === 0) return new PackedInventory(new Uint8Array());
		const ordered = [...inventories].sort((left, right) => left.count - right.count);
		let result = ordered[0]!;
		for (let index = 1; index < ordered.length && result.count > 0; ++index) {
			if (!result.equals(ordered[index]!)) result = result.intersect(ordered[index]!);
		}
		return new PackedInventory(result.#bytes.slice());
	}

	deltaTo(next: PackedInventory): Readonly<{ added: PackedInventory; removed: PackedInventory }> {
		const addedBytes = new Uint8Array(next.byteLength);
		const removedBytes = new Uint8Array(this.byteLength);
		let currentOffset = 0;
		let nextOffset = 0;
		let addedOffset = 0;
		let removedOffset = 0;
		while (currentOffset < this.byteLength || nextOffset < next.byteLength) {
			if (currentOffset >= this.byteLength) {
				addedBytes.set(next.#bytes.subarray(nextOffset), addedOffset);
				addedOffset += next.byteLength - nextOffset;
				break;
			}
			if (nextOffset >= next.byteLength) {
				removedBytes.set(this.#bytes.subarray(currentOffset), removedOffset);
				removedOffset += this.byteLength - currentOffset;
				break;
			}
			const currentHash = this.#bytes.subarray(currentOffset, currentOffset + SHA256_BYTES);
			const nextHash = next.#bytes.subarray(nextOffset, nextOffset + SHA256_BYTES);
			const comparison = compareHash(currentHash, nextHash);
			if (comparison < 0) {
				removedBytes.set(currentHash, removedOffset);
				removedOffset += SHA256_BYTES;
				currentOffset += SHA256_BYTES;
			} else if (comparison > 0) {
				addedBytes.set(nextHash, addedOffset);
				addedOffset += SHA256_BYTES;
				nextOffset += SHA256_BYTES;
			} else {
				currentOffset += SHA256_BYTES;
				nextOffset += SHA256_BYTES;
			}
		}
		return {
			added: new PackedInventory(addedBytes.slice(0, addedOffset)),
			removed: new PackedInventory(removedBytes.slice(0, removedOffset))
		};
	}

	equals(other: PackedInventory): boolean {
		if (this.byteLength !== other.byteLength) return false;
		return (
			Buffer.compare(
				Buffer.from(this.#bytes.buffer, this.#bytes.byteOffset, this.#bytes.byteLength),
				Buffer.from(other.#bytes.buffer, other.#bytes.byteOffset, other.#bytes.byteLength)
			) === 0
		);
	}

	copyBytes(): Uint8Array {
		return Uint8Array.from(this.#bytes);
	}
}
