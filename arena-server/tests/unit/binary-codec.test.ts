import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { ProtocolError } from '../../src/protocol/errors.ts';
import {
	BINARY_FORMAT_VERSION,
	BINARY_HEADER_BYTES,
	BINARY_MAGIC,
	MAX_BINARY_FRAME_BYTES,
	MAX_HASHES_PER_CHUNK,
	decodeHashChunk,
	encodeHashChunk,
	type BinaryKind
} from '../../src/protocol/binary.ts';

const transferId = Uint8Array.from({ length: 16 }, (_, index) => index);

function packedHashes(count: number, start = 0): Uint8Array {
	const bytes = new Uint8Array(count * 32);
	for (let index = 0; index < count; ++index) {
		const view = new DataView(bytes.buffer, index * 32, 32);
		view.setUint32(28, start + index, false);
	}
	return bytes;
}

function expectMalformed(bytes: Uint8Array): void {
	try {
		decodeHashChunk(bytes);
		expect.unreachable('expected malformed_inventory');
	} catch (error) {
		expect(error).toBeInstanceOf(ProtocolError);
		expect((error as ProtocolError).code).toBe('malformed_inventory');
		expect(String(error)).not.toContain(Buffer.from(bytes).toString('hex'));
	}
}

describe('Arena binary hash chunk codec', () => {
	test('matches the cross-language binary golden corpus byte for byte', () => {
		const fixture = JSON.parse(
			readFileSync(`${import.meta.dir}/../fixtures/phase2-binary-goldens.json`, 'utf8')
		) as {
			fixtureSchema: number;
			formatVersion: number;
			cases: Array<{
				name: string;
				kind: BinaryKind;
				transferIdHex: string;
				chunkIndex: number;
				hashesHex: string;
				frameHex: string;
			}>;
			invalidFrameHex: string[];
		};
		expect([fixture.fixtureSchema, fixture.formatVersion]).toEqual([1, 1]);
		for (const golden of fixture.cases) {
			const encoded = encodeHashChunk({
				kind: golden.kind,
				transferId: Uint8Array.from(Buffer.from(golden.transferIdHex, 'hex')),
				chunkIndex: golden.chunkIndex,
				hashes: Uint8Array.from(Buffer.from(golden.hashesHex, 'hex'))
			});
			expect(Buffer.from(encoded).toString('hex')).toBe(golden.frameHex);
			expect(decodeHashChunk(Uint8Array.from(Buffer.from(golden.frameHex, 'hex')))).toEqual({
				kind: golden.kind,
				transferId: Uint8Array.from(Buffer.from(golden.transferIdHex, 'hex')),
				chunkIndex: golden.chunkIndex,
				hashes: Uint8Array.from(Buffer.from(golden.hashesHex, 'hex'))
			});
		}
		for (const invalid of fixture.invalidFrameHex) {
			expectMalformed(Uint8Array.from(Buffer.from(invalid, 'hex')));
		}
	});

	test('encodes the exact big-endian 32-byte RGA1 header for all four kinds', () => {
		for (const kind of [1, 2, 3, 4] as const satisfies readonly BinaryKind[]) {
			const encoded = encodeHashChunk({
				kind,
				transferId,
				chunkIndex: 0x01020304,
				hashes: new Uint8Array()
			});
			expect(encoded.byteLength).toBe(BINARY_HEADER_BYTES);
			expect([...encoded.subarray(0, 4)]).toEqual([...BINARY_MAGIC]);
			expect(encoded[4]).toBe(BINARY_FORMAT_VERSION);
			expect(encoded[5]).toBe(kind);
			expect([...encoded.subarray(6, 8)]).toEqual([0, 0]);
			expect([...encoded.subarray(8, 24)]).toEqual([...transferId]);
			expect(new DataView(encoded.buffer).getUint32(24, false)).toBe(0x01020304);
			expect(new DataView(encoded.buffer).getUint32(28, false)).toBe(0);
			expect(decodeHashChunk(encoded)).toEqual({
				kind,
				transferId,
				chunkIndex: 0x01020304,
				hashes: new Uint8Array()
			});
		}
	});

	test('round-trips copied 1 and 2,047 hash payloads at the exact frame boundary', () => {
		for (const count of [1, MAX_HASHES_PER_CHUNK]) {
			const hashes = packedHashes(count);
			const encoded = encodeHashChunk({ kind: 1, transferId, chunkIndex: 9, hashes });
			expect(encoded.byteLength).toBe(BINARY_HEADER_BYTES + count * 32);
			if (count === MAX_HASHES_PER_CHUNK) {
				expect(encoded.byteLength).toBe(MAX_BINARY_FRAME_BYTES);
			}
			const decoded = decodeHashChunk(encoded);
			expect(decoded.hashes).toEqual(hashes);
			encoded.fill(0);
			expect(decoded.hashes).toEqual(hashes);
		}
	});

	test('rejects every malformed structural boundary without retaining bytes', () => {
		const valid = encodeHashChunk({ kind: 1, transferId, chunkIndex: 0, hashes: packedHashes(1) });
		const invalid: Uint8Array[] = [
			valid.subarray(0, BINARY_HEADER_BYTES - 1),
			Uint8Array.from(valid, (value, index) => (index === 0 ? value ^ 0xff : value)),
			Uint8Array.from(valid, (value, index) => (index === 4 ? 2 : value)),
			Uint8Array.from(valid, (value, index) => (index === 5 ? 0 : value)),
			Uint8Array.from(valid, (value, index) => (index === 6 ? 1 : value)),
			valid.subarray(0, valid.byteLength - 1),
			new Uint8Array(MAX_BINARY_FRAME_BYTES + 1)
		];
		const impossibleCount = valid.slice();
		new DataView(impossibleCount.buffer).setUint32(28, MAX_HASHES_PER_CHUNK + 1, false);
		invalid.push(impossibleCount);
		for (const bytes of invalid) expectMalformed(bytes);
	});

	test('rejects invalid encoder inputs before allocation', () => {
		for (const input of [
			{ kind: 0, transferId, chunkIndex: 0, hashes: new Uint8Array() },
			{ kind: 1, transferId: new Uint8Array(15), chunkIndex: 0, hashes: new Uint8Array() },
			{ kind: 1, transferId, chunkIndex: -1, hashes: new Uint8Array() },
			{ kind: 1, transferId, chunkIndex: 0, hashes: new Uint8Array(31) },
			{ kind: 1, transferId, chunkIndex: 0, hashes: packedHashes(MAX_HASHES_PER_CHUNK + 1) }
		]) {
			expect(() => encodeHashChunk(input as never)).toThrow(ProtocolError);
		}
	});
});
