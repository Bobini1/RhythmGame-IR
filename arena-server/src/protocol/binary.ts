import { ProtocolError } from './errors.ts';

export const BINARY_MAGIC = new Uint8Array([0x52, 0x47, 0x41, 0x31]);
export const BINARY_FORMAT_VERSION = 1 as const;
export const BINARY_HEADER_BYTES = 32;
export const MAX_HASHES_PER_CHUNK = 2_047;
export const MAX_BINARY_FRAME_BYTES = 65_536;

export type BinaryKind = 1 | 2 | 3 | 4;

export type DecodedHashChunk = Readonly<{
	kind: BinaryKind;
	transferId: Uint8Array;
	chunkIndex: number;
	hashes: Uint8Array;
}>;

type HashChunkInput = Readonly<{
	kind: BinaryKind;
	transferId: Uint8Array;
	chunkIndex: number;
	hashes: Uint8Array;
}>;

function malformed(): never {
	throw new ProtocolError('malformed_inventory');
}

function isBinaryKind(value: number): value is BinaryKind {
	return value === 1 || value === 2 || value === 3 || value === 4;
}

function validatePayload(hashes: Uint8Array): number {
	if (!(hashes instanceof Uint8Array) || hashes.byteLength % 32 !== 0) malformed();
	const count = hashes.byteLength / 32;
	if (count > MAX_HASHES_PER_CHUNK) malformed();
	return count;
}

export function encodeHashChunk(input: HashChunkInput): Uint8Array {
	if (!isBinaryKind(input.kind)) malformed();
	if (!(input.transferId instanceof Uint8Array) || input.transferId.byteLength !== 16) malformed();
	if (
		!Number.isSafeInteger(input.chunkIndex) ||
		input.chunkIndex < 0 ||
		input.chunkIndex > 0xffffffff
	) {
		malformed();
	}
	const hashCount = validatePayload(input.hashes);
	const frameBytes = BINARY_HEADER_BYTES + input.hashes.byteLength;
	if (frameBytes > MAX_BINARY_FRAME_BYTES) malformed();

	const encoded = new Uint8Array(frameBytes);
	encoded.set(BINARY_MAGIC, 0);
	encoded[4] = BINARY_FORMAT_VERSION;
	encoded[5] = input.kind;
	encoded.set(input.transferId, 8);
	const view = new DataView(encoded.buffer);
	view.setUint32(24, input.chunkIndex, false);
	view.setUint32(28, hashCount, false);
	encoded.set(input.hashes, BINARY_HEADER_BYTES);
	return encoded;
}

export function decodeHashChunk(frame: Uint8Array): DecodedHashChunk {
	if (
		!(frame instanceof Uint8Array) ||
		frame.byteLength < BINARY_HEADER_BYTES ||
		frame.byteLength > MAX_BINARY_FRAME_BYTES
	) {
		malformed();
	}
	for (let index = 0; index < BINARY_MAGIC.byteLength; ++index) {
		if (frame[index] !== BINARY_MAGIC[index]) malformed();
	}
	if (frame[4] !== BINARY_FORMAT_VERSION || frame[6] !== 0 || frame[7] !== 0) malformed();
	const kind = frame[5];
	if (kind === undefined || !isBinaryKind(kind)) malformed();

	const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
	const chunkIndex = view.getUint32(24, false);
	const hashCount = view.getUint32(28, false);
	if (hashCount > MAX_HASHES_PER_CHUNK) malformed();
	const expectedBytes = BINARY_HEADER_BYTES + hashCount * 32;
	if (frame.byteLength !== expectedBytes) malformed();

	return {
		kind,
		transferId: frame.slice(8, 24),
		chunkIndex,
		hashes: frame.slice(BINARY_HEADER_BYTES)
	};
}
