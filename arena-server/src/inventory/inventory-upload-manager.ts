import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { decodeHashChunk } from '../protocol/binary.ts';
import { ProtocolError } from '../protocol/errors.ts';
import { inventoryDeclarationSchema, type InventoryDeclaration } from '../protocol/messages.ts';
import { PackedInventory, SHA256_BYTES } from './packed-inventory.ts';

export const DEFAULT_INVENTORY_UPLOAD_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_PENDING_INVENTORY_BYTES = 128 * 1024 * 1024;
export const DEFAULT_MAX_COMMITTED_INVENTORY_BYTES = 512 * 1024 * 1024;

type UploadCode =
	| 'unexpected_binary'
	| 'malformed_inventory'
	| 'inventory_invalid'
	| 'inventory_stale'
	| 'inventory_capacity_exceeded'
	| 'rate_limited';

type PendingUpload = {
	connectionId: string;
	identityId: string;
	uploadId: string;
	rawUploadId: Uint8Array;
	declaration: InventoryDeclaration;
	deadlineMs: number;
	chunks: Uint8Array[];
	receivedHashes: number;
	lastHash?: Uint8Array;
};

export type BeginResult =
	| Readonly<{
			ok: true;
			uploadId: string;
			rawUploadId: Uint8Array;
			deadlineMs: number;
	  }>
	| Readonly<{
			ok: false;
			code: Extract<
				UploadCode,
				'inventory_invalid' | 'inventory_capacity_exceeded' | 'rate_limited'
			>;
	  }>;

export type AppendResult =
	| Readonly<{ ok: true; receivedChunks: number; receivedHashes: number }>
	| Readonly<{
			ok: false;
			code: Extract<UploadCode, 'unexpected_binary' | 'malformed_inventory' | 'inventory_stale'>;
	  }>;

export type CommitResult =
	| Readonly<{ ok: true; inventory: PackedInventory }>
	| Readonly<{
			ok: false;
			code: Extract<
				UploadCode,
				'inventory_invalid' | 'inventory_stale' | 'inventory_capacity_exceeded'
			>;
	  }>;

export type InventoryUploadManagerOptions = Readonly<{
	newTransferId?: () => Uint8Array;
	uploadTimeoutMs?: number;
	maxPendingBytes?: number;
	maxCommittedBytes?: number;
}>;

const BEGIN_LIMIT = 6;
const BEGIN_WINDOW_MS = 60_000;

function declarationsEqual(left: InventoryDeclaration, right: InventoryDeclaration): boolean {
	return (
		left.libraryGeneration === right.libraryGeneration &&
		left.hashCount === right.hashCount &&
		left.byteCount === right.byteCount &&
		left.chunkCount === right.chunkCount &&
		left.vectorDigest === right.vectorDigest
	);
}

function compareHash(left: Uint8Array, right: Uint8Array): number {
	for (let index = 0; index < SHA256_BYTES; ++index) {
		const difference = left[index]! - right[index]!;
		if (difference !== 0) return difference;
	}
	return 0;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

export class InventoryUploadManager {
	readonly #newTransferId: () => Uint8Array;
	readonly #uploadTimeoutMs: number;
	readonly #maxPendingBytes: number;
	readonly #maxCommittedBytes: number;
	readonly #pending = new Map<string, PendingUpload>();
	readonly #beginWindows = new Map<string, number[]>();
	readonly #issuedUploadIds = new Set<string>();
	readonly #committedReservations = new WeakSet<PackedInventory>();
	#pendingReservedBytes = 0;
	#committedBytes = 0;

	constructor(options: InventoryUploadManagerOptions = {}) {
		this.#newTransferId = options.newTransferId ?? (() => randomBytes(16));
		this.#uploadTimeoutMs = options.uploadTimeoutMs ?? DEFAULT_INVENTORY_UPLOAD_TIMEOUT_MS;
		this.#maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_INVENTORY_BYTES;
		this.#maxCommittedBytes = options.maxCommittedBytes ?? DEFAULT_MAX_COMMITTED_INVENTORY_BYTES;
		for (const value of [this.#uploadTimeoutMs, this.#maxPendingBytes, this.#maxCommittedBytes]) {
			if (!Number.isSafeInteger(value) || value < 0) {
				throw new Error('Invalid inventory upload manager limit.');
			}
		}
	}

	get pendingReservedBytes(): number {
		return this.#pendingReservedBytes;
	}

	get committedBytes(): number {
		return this.#committedBytes;
	}

	begin(
		connectionId: string,
		identityId: string,
		declaration: InventoryDeclaration,
		nowMs: number
	): BeginResult {
		const parsed = inventoryDeclarationSchema.safeParse(declaration);
		if (!parsed.success) return { ok: false, code: 'inventory_invalid' };
		const previous = this.#pending.get(connectionId);
		const prospectiveBytes =
			this.#pendingReservedBytes - (previous?.declaration.byteCount ?? 0) + parsed.data.byteCount;
		if (prospectiveBytes > this.#maxPendingBytes) {
			return { ok: false, code: 'inventory_capacity_exceeded' };
		}
		const activeBegins = (this.#beginWindows.get(identityId) ?? []).filter(
			(timestamp) => timestamp > nowMs - BEGIN_WINDOW_MS
		);
		if (activeBegins.length >= BEGIN_LIMIT) return { ok: false, code: 'rate_limited' };

		if (previous !== undefined) this.#discard(previous);
		const rawUploadId = this.#allocateTransferId();
		const uploadId = Buffer.from(rawUploadId).toString('base64url');
		const pending: PendingUpload = {
			connectionId,
			identityId,
			uploadId,
			rawUploadId,
			declaration: parsed.data,
			deadlineMs: nowMs + this.#uploadTimeoutMs,
			chunks: [],
			receivedHashes: 0
		};
		this.#pending.set(connectionId, pending);
		this.#pendingReservedBytes += pending.declaration.byteCount;
		activeBegins.push(nowMs);
		this.#beginWindows.set(identityId, activeBegins);
		return {
			ok: true,
			uploadId,
			rawUploadId: rawUploadId.slice(),
			deadlineMs: pending.deadlineMs
		};
	}

	append(connectionId: string, encodedFrame: Uint8Array, nowMs: number): AppendResult {
		const pending = this.#pending.get(connectionId);
		if (pending === undefined) return { ok: false, code: 'unexpected_binary' };
		if (nowMs >= pending.deadlineMs) {
			this.#discard(pending);
			return { ok: false, code: 'inventory_stale' };
		}

		let frame;
		try {
			frame = decodeHashChunk(encodedFrame);
		} catch (error) {
			this.#discard(pending);
			if (error instanceof ProtocolError) return { ok: false, code: 'malformed_inventory' };
			throw error;
		}
		if (
			frame.kind !== 1 ||
			!sameBytes(frame.transferId, pending.rawUploadId) ||
			frame.chunkIndex !== pending.chunks.length ||
			frame.hashes.byteLength === 0 ||
			pending.chunks.length >= pending.declaration.chunkCount
		) {
			this.#discard(pending);
			return { ok: false, code: 'malformed_inventory' };
		}

		const chunkHashes = frame.hashes.byteLength / SHA256_BYTES;
		if (pending.receivedHashes + chunkHashes > pending.declaration.hashCount) {
			this.#discard(pending);
			return { ok: false, code: 'malformed_inventory' };
		}
		let previous = pending.lastHash;
		for (let offset = 0; offset < frame.hashes.byteLength; offset += SHA256_BYTES) {
			const current = frame.hashes.subarray(offset, offset + SHA256_BYTES);
			if (previous !== undefined && compareHash(previous, current) >= 0) {
				this.#discard(pending);
				return { ok: false, code: 'malformed_inventory' };
			}
			previous = current;
		}
		pending.chunks.push(frame.hashes);
		pending.receivedHashes += chunkHashes;
		pending.lastHash = frame.hashes.slice(-SHA256_BYTES);
		return {
			ok: true,
			receivedChunks: pending.chunks.length,
			receivedHashes: pending.receivedHashes
		};
	}

	commit(
		connectionId: string,
		uploadId: string,
		declaration: InventoryDeclaration,
		nowMs: number
	): CommitResult {
		const pending = this.#pending.get(connectionId);
		if (pending === undefined || pending.uploadId !== uploadId) {
			return { ok: false, code: 'inventory_stale' };
		}
		if (nowMs >= pending.deadlineMs) {
			this.#discard(pending);
			return { ok: false, code: 'inventory_stale' };
		}
		const parsed = inventoryDeclarationSchema.safeParse(declaration);
		if (
			!parsed.success ||
			!declarationsEqual(parsed.data, pending.declaration) ||
			pending.chunks.length !== pending.declaration.chunkCount ||
			pending.receivedHashes !== pending.declaration.hashCount
		) {
			this.#discard(pending);
			return { ok: false, code: 'inventory_invalid' };
		}

		const bytes = Buffer.concat(pending.chunks, pending.declaration.byteCount);
		const actualDigest = createHash('sha256').update(bytes).digest();
		const expectedDigest = Buffer.from(pending.declaration.vectorDigest, 'hex');
		if (!timingSafeEqual(actualDigest, expectedDigest)) {
			this.#discard(pending);
			return { ok: false, code: 'inventory_invalid' };
		}
		if (this.#committedBytes + bytes.byteLength > this.#maxCommittedBytes) {
			this.#discard(pending);
			return { ok: false, code: 'inventory_capacity_exceeded' };
		}

		let inventory: PackedInventory;
		try {
			inventory = PackedInventory.fromSortedBytes(bytes);
		} catch {
			this.#discard(pending);
			return { ok: false, code: 'inventory_invalid' };
		}
		this.#discard(pending);
		this.#committedBytes += inventory.byteLength;
		this.#committedReservations.add(inventory);
		return { ok: true, inventory };
	}

	abort(connectionId: string, uploadId?: string): boolean {
		const pending = this.#pending.get(connectionId);
		if (pending === undefined || (uploadId !== undefined && uploadId !== pending.uploadId)) {
			return false;
		}
		this.#discard(pending);
		return true;
	}

	abortConnection(connectionId: string): void {
		this.abort(connectionId);
	}

	sweep(nowMs: number): readonly Readonly<{ connectionId: string; uploadId: string }>[] {
		const expired: Array<Readonly<{ connectionId: string; uploadId: string }>> = [];
		for (const pending of [...this.#pending.values()]) {
			if (nowMs < pending.deadlineMs) continue;
			expired.push({ connectionId: pending.connectionId, uploadId: pending.uploadId });
			this.#discard(pending);
		}
		for (const [identityId, timestamps] of this.#beginWindows) {
			const active = timestamps.filter((timestamp) => timestamp > nowMs - BEGIN_WINDOW_MS);
			if (active.length === 0) this.#beginWindows.delete(identityId);
			else this.#beginWindows.set(identityId, active);
		}
		return expired;
	}

	releaseCommitted(inventory: PackedInventory): void {
		if (!this.#committedReservations.delete(inventory)) return;
		this.#committedBytes -= inventory.byteLength;
	}

	abortAll(): void {
		for (const pending of [...this.#pending.values()]) this.#discard(pending);
	}

	#discard(pending: PendingUpload): void {
		if (this.#pending.get(pending.connectionId) !== pending) return;
		this.#pending.delete(pending.connectionId);
		this.#pendingReservedBytes -= pending.declaration.byteCount;
		pending.chunks.length = 0;
		pending.lastHash = undefined;
	}

	#allocateTransferId(): Uint8Array {
		for (let attempt = 0; attempt < 128; ++attempt) {
			const candidate = this.#newTransferId();
			if (!(candidate instanceof Uint8Array) || candidate.byteLength !== 16) {
				throw new Error('Inventory transfer IDs must contain exactly 16 bytes.');
			}
			const owned = candidate.slice();
			const encoded = Buffer.from(owned).toString('base64url');
			if (this.#issuedUploadIds.has(encoded)) continue;
			this.#issuedUploadIds.add(encoded);
			return owned;
		}
		throw new Error('Unable to allocate a unique inventory transfer ID.');
	}
}
