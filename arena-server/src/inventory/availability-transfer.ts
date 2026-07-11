import { createHash } from 'node:crypto';

import { encodeHashChunk, MAX_HASHES_PER_CHUNK, type BinaryKind } from '../protocol/binary.ts';
import type { ServerMessage } from '../protocol/messages.ts';
import { PackedInventory, SHA256_BYTES } from './packed-inventory.ts';

export type AvailabilityBasisEntry = Readonly<{
	memberId: string;
	inventoryRevision: number;
}>;

export type AvailabilityTransferPlan = Readonly<{
	begin: Extract<ServerMessage, { type: 'availability_transfer_begin' }>;
	frames: readonly Uint8Array[];
	commit: Extract<ServerMessage, { type: 'availability_transfer_commit' }>;
}>;

type PlanInput = Readonly<{
	roomId: string;
	roomGeneration: number;
	transferId: Uint8Array;
	baseRevision?: number;
	targetRevision: number;
	basis: readonly AvailabilityBasisEntry[];
	previous?: PackedInventory;
	next: PackedInventory;
	forceReset: boolean;
}>;

function digest(inventory: PackedInventory): string {
	return createHash('sha256').update(inventory.copyBytes()).digest('hex');
}

function framesFor(
	inventory: PackedInventory,
	kind: BinaryKind,
	transferId: Uint8Array
): Uint8Array[] {
	const bytes = inventory.copyBytes();
	const hashesPerFrameBytes = MAX_HASHES_PER_CHUNK * SHA256_BYTES;
	const frames: Uint8Array[] = [];
	for (let offset = 0, chunkIndex = 0; offset < bytes.byteLength; offset += hashesPerFrameBytes) {
		frames.push(
			encodeHashChunk({
				kind,
				transferId,
				chunkIndex: chunkIndex++,
				hashes: bytes.subarray(offset, Math.min(offset + hashesPerFrameBytes, bytes.byteLength))
			})
		);
	}
	return frames;
}

export function planAvailabilityTransfer(input: PlanInput): AvailabilityTransferPlan {
	if (!(input.transferId instanceof Uint8Array) || input.transferId.byteLength !== 16) {
		throw new Error('Availability transfer IDs must contain exactly 16 bytes.');
	}
	const transferId = Buffer.from(input.transferId).toString('base64url');
	const delta = input.previous?.deltaTo(input.next);
	const useDelta =
		!input.forceReset &&
		input.baseRevision !== undefined &&
		input.baseRevision > 0 &&
		delta !== undefined &&
		delta.added.count + delta.removed.count < input.next.count;

	let begin: Extract<ServerMessage, { type: 'availability_transfer_begin' }>;
	let frames: Uint8Array[];
	if (useDelta && delta !== undefined && input.baseRevision !== undefined) {
		const removedFrames = framesFor(delta.removed, 4, input.transferId);
		const addedFrames = framesFor(delta.added, 3, input.transferId);
		begin = {
			type: 'availability_transfer_begin',
			data: {
				roomId: input.roomId,
				roomGeneration: input.roomGeneration,
				transferId,
				mode: 'delta',
				baseRevision: input.baseRevision,
				targetRevision: input.targetRevision,
				basis: input.basis.map((entry) => ({ ...entry })),
				addedCount: delta.added.count,
				addedChunkCount: addedFrames.length,
				addedDigest: digest(delta.added),
				removedCount: delta.removed.count,
				removedChunkCount: removedFrames.length,
				removedDigest: digest(delta.removed)
			}
		};
		frames = [...removedFrames, ...addedFrames];
	} else {
		frames = framesFor(input.next, 2, input.transferId);
		begin = {
			type: 'availability_transfer_begin',
			data: {
				roomId: input.roomId,
				roomGeneration: input.roomGeneration,
				transferId,
				mode: 'reset',
				targetRevision: input.targetRevision,
				basis: input.basis.map((entry) => ({ ...entry })),
				resetCount: input.next.count,
				resetChunkCount: frames.length,
				resetDigest: digest(input.next)
			}
		};
	}

	return {
		begin,
		frames,
		commit: {
			type: 'availability_transfer_commit',
			data: {
				roomId: input.roomId,
				roomGeneration: input.roomGeneration,
				transferId,
				targetRevision: input.targetRevision
			}
		}
	};
}
