import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { decodeClientMessage, encodeServerMessage } from '../../src/protocol/codec.ts';
import { ProtocolError } from '../../src/protocol/errors.ts';
import {
	PROTOCOL_MAJOR,
	PROTOCOL_MINOR,
	ROOMS_CAPABILITY,
	ROUNDS_CAPABILITY,
	type ClientMessage,
	type SelectionSnapshot,
	type ServerMessage
} from '../../src/protocol/messages.ts';

const binding = {
	roomId: 'room-1',
	roomGeneration: 2,
	connectionGeneration: 3
} as const;

const selection: SelectionSnapshot = {
	sha256: '11'.repeat(32),
	md5: '22'.repeat(16),
	title: 'Phase 2 chart',
	subtitle: 'Another',
	artist: 'Composer',
	keyMode: 14,
	randomSequence: [1, 2, 3],
	noteOrderP1: 's_random_plus',
	noteOrderP2: 'lr2_random_ex',
	dpMode: 'lr2_flip',
	laneSeed: '0123456789abcdef',
	randomizationVersion: 1
};

const frozenRound = {
	roundId: 'round-1',
	launchAttemptId: 'attempt-1',
	selectionRevision: 4,
	availabilityRevision: 5,
	selection,
	participants: [{ memberId: 'member-1', inventoryRevision: 6 }],
	stage: 'probing' as const
};

function decode(value: unknown) {
	return decodeClientMessage(JSON.stringify(value));
}

function expectMalformed(value: unknown): void {
	try {
		decode(value);
		expect.unreachable('expected malformed_message');
	} catch (error) {
		expect(error).toBeInstanceOf(ProtocolError);
		expect((error as ProtocolError).code).toBe('malformed_message');
	}
}

describe('Arena protocol 1.1 negotiation', () => {
	test('accepts 1.0 browse and 1.1 rounds hellos', () => {
		for (const [protocolMinor, capabilities] of [
			[0, [ROOMS_CAPABILITY]],
			[1, [ROOMS_CAPABILITY, ROUNDS_CAPABILITY]]
		] as const) {
			expect(
				decode({
					type: 'client_hello',
					data: {
						protocolMajor: PROTOCOL_MAJOR,
						protocolMinor,
						clientVersion: 'phase2-test',
						capabilities
					}
				})
			).toEqual(
				expect.objectContaining({ data: expect.objectContaining({ protocolMinor, capabilities }) })
			);
		}
		expect(PROTOCOL_MINOR).toBe(1);
	});

	test('rejects unsupported versions and duplicate capabilities', () => {
		for (const data of [
			{
				protocolMajor: 2,
				protocolMinor: 1,
				clientVersion: 'test',
				capabilities: [ROOMS_CAPABILITY, ROUNDS_CAPABILITY]
			},
			{
				protocolMajor: 1,
				protocolMinor: 2,
				clientVersion: 'test',
				capabilities: [ROOMS_CAPABILITY, ROUNDS_CAPABILITY]
			}
		]) {
			expect(() => decode({ type: 'client_hello', data })).toThrow(ProtocolError);
		}
		expectMalformed({
			type: 'client_hello',
			data: {
				protocolMajor: 1,
				protocolMinor: 1,
				clientVersion: 'test',
				capabilities: [ROOMS_CAPABILITY, ROUNDS_CAPABILITY, ROUNDS_CAPABILITY]
			}
		});
	});
});

describe('Arena Phase 2 client text contract', () => {
	const messages: readonly unknown[] = [
		{
			type: 'inventory_upload_begin',
			requestId: 'inventory-begin-1',
			data: {
				...binding,
				libraryGeneration: 7,
				hashCount: 2,
				byteCount: 64,
				chunkCount: 1,
				vectorDigest: '33'.repeat(32)
			}
		},
		{
			type: 'inventory_upload_commit',
			requestId: 'inventory-commit-1',
			data: {
				...binding,
				uploadId: 'AAAAAAAAAAAAAAAAAAAAAA',
				libraryGeneration: 7,
				hashCount: 2,
				byteCount: 64,
				chunkCount: 1,
				vectorDigest: '33'.repeat(32)
			}
		},
		{
			type: 'inventory_upload_abort',
			requestId: 'inventory-abort-1',
			data: { ...binding, uploadId: 'AAAAAAAAAAAAAAAAAAAAAA', libraryGeneration: 7 }
		},
		{
			type: 'availability_applied',
			requestId: 'availability-applied-1',
			data: { ...binding, availabilityRevision: 5 }
		},
		{
			type: 'availability_resync',
			requestId: 'availability-resync-1',
			data: { ...binding, currentRevision: 4 }
		},
		{
			type: 'selection_set',
			requestId: 'selection-1',
			data: { ...binding, availabilityRevision: 5, inventoryRevision: 6, selection }
		},
		{
			type: 'ready_set',
			requestId: 'ready-1',
			data: {
				...binding,
				ready: true,
				selectionRevision: 4,
				availabilityRevision: 5,
				inventoryRevision: 6
			}
		},
		{
			type: 'round_probe_result',
			requestId: 'probe-1',
			data: {
				...binding,
				roundId: 'round-1',
				launchAttemptId: 'attempt-1',
				selectionRevision: 4,
				availabilityRevision: 5,
				inventoryRevision: 6,
				nonce: 'probe-nonce-1',
				ok: true,
				sha256: selection.sha256
			}
		},
		{
			type: 'round_load_result',
			requestId: 'load-1',
			data: {
				...binding,
				roundId: 'round-1',
				launchAttemptId: 'attempt-1',
				selectionRevision: 4,
				availabilityRevision: 5,
				inventoryRevision: 6,
				ok: false,
				reason: 'resource_failed'
			}
		}
	];

	test('accepts every new command and rejects an extra nested field', () => {
		for (const message of messages) {
			expect(decode(message)).toEqual(message as ClientMessage);
			const record = message as { data: Record<string, unknown> };
			expectMalformed({ ...record, data: { ...record.data, unexpected: true } });
		}
	});

	test('accepts every note order and DP mode but no unknown transform', () => {
		const noteOrders = [
			'normal',
			'mirror',
			'random',
			's_random',
			'r_random',
			'random_plus',
			's_random_plus',
			'beatoraja_random',
			'beatoraja_random_ex',
			'lr2_random',
			'lr2_random_ex'
		] as const;
		for (const noteOrder of noteOrders) {
			expect(
				decode({
					type: 'selection_set',
					requestId: `note-${noteOrder}`,
					data: {
						...binding,
						availabilityRevision: 5,
						inventoryRevision: 6,
						selection: { ...selection, noteOrderP1: noteOrder, noteOrderP2: noteOrder }
					}
				})
			).toBeDefined();
		}
		for (const dpMode of ['off', 'flip', 'lr2_flip', 'battle'] as const) {
			expect(
				decode({
					type: 'selection_set',
					requestId: `dp-${dpMode}`,
					data: {
						...binding,
						availabilityRevision: 5,
						inventoryRevision: 6,
						selection: { ...selection, dpMode }
					}
				})
			).toBeDefined();
		}
		expectMalformed({
			type: 'selection_set',
			requestId: 'bad-transform',
			data: {
				...binding,
				availabilityRevision: 5,
				inventoryRevision: 6,
				selection: { ...selection, noteOrderP1: 'future_random' }
			}
		});
	});
});

describe('Arena Phase 2 server text contract', () => {
	const messages: readonly ServerMessage[] = [
		{
			type: 'inventory_upload_ready',
			requestId: 'inventory-begin-1',
			data: {
				...binding,
				uploadId: 'AAAAAAAAAAAAAAAAAAAAAA',
				libraryGeneration: 7,
				hashCount: 2,
				byteCount: 64,
				chunkCount: 1,
				vectorDigest: '33'.repeat(32),
				deadlineMs: 60_000
			}
		},
		{
			type: 'inventory_committed',
			requestId: 'inventory-commit-1',
			data: {
				...binding,
				libraryGeneration: 7,
				inventoryRevision: 6,
				inventoryState: 'ready'
			}
		},
		{
			type: 'availability_transfer_begin',
			data: {
				roomId: binding.roomId,
				roomGeneration: binding.roomGeneration,
				transferId: 'BBBBBBBBBBBBBBBBBBBBBB',
				mode: 'reset',
				targetRevision: 5,
				basis: [{ memberId: 'member-1', inventoryRevision: 6 }],
				resetCount: 2,
				resetChunkCount: 1,
				resetDigest: '44'.repeat(32)
			}
		},
		{
			type: 'availability_transfer_commit',
			data: {
				roomId: binding.roomId,
				roomGeneration: binding.roomGeneration,
				transferId: 'BBBBBBBBBBBBBBBBBBBBBB',
				targetRevision: 5
			}
		},
		{
			type: 'selection_changed',
			data: {
				roomId: binding.roomId,
				roomGeneration: binding.roomGeneration,
				selectionRevision: 4,
				availabilityRevision: 5,
				selection,
				selectedByMemberId: 'member-1'
			}
		},
		{
			type: 'selection_rejected',
			requestId: 'selection-1',
			data: {
				reason: 'not_common',
				missingMemberIds: ['member-2']
			}
		},
		{
			type: 'round_loading_started',
			data: { roomId: binding.roomId, roomGeneration: binding.roomGeneration, round: frozenRound }
		},
		{
			type: 'round_probe_requested',
			data: {
				...binding,
				roundId: 'round-1',
				launchAttemptId: 'attempt-1',
				selectionRevision: 4,
				availabilityRevision: 5,
				inventoryRevision: 6,
				nonce: 'probe-nonce-1',
				sha256: selection.sha256,
				deadlineMs: 15_000
			}
		},
		{
			type: 'round_load_requested',
			data: { ...binding, round: { ...frozenRound, stage: 'loading' } }
		},
		{
			type: 'round_start_scheduled',
			data: {
				...binding,
				roundId: 'round-1',
				launchAttemptId: 'attempt-1',
				startAtServerMs: 100_000,
				startAfterMs: 2_000
			}
		},
		{
			type: 'round_started',
			data: {
				roomId: binding.roomId,
				roomGeneration: binding.roomGeneration,
				roundId: 'round-1',
				launchAttemptId: 'attempt-1'
			}
		},
		{
			type: 'round_launch_cancelled',
			data: {
				roomId: binding.roomId,
				roomGeneration: binding.roomGeneration,
				roundId: 'round-1',
				launchAttemptId: 'attempt-1',
				reason: 'hash_mismatch',
				selection: null,
				selectionRevision: 5,
				availabilityRevision: 5
			}
		}
	];

	test('encodes every new event and rejects an extra nested field', () => {
		for (const message of messages) {
			expect(JSON.parse(encodeServerMessage(message))).toEqual(message);
			expect(() =>
				encodeServerMessage({ ...message, data: { ...message.data, unexpected: true } } as never)
			).toThrow(ProtocolError);
		}
	});
});

describe('Arena Phase 2 canonical text fixture', () => {
	test('covers every new discriminator with one strict-invalid derivative', () => {
		const fixture = JSON.parse(
			readFileSync(`${import.meta.dir}/../fixtures/phase2-text-goldens.json`, 'utf8')
		) as {
			fixtureSchema: number;
			protocolMajor: number;
			protocolMinor: number;
			clientMessages: Array<{ name: string; message: Record<string, unknown> }>;
			serverMessages: Array<{ name: string; message: Record<string, unknown> }>;
			strictInvalidClientTypes: string[];
			strictInvalidServerTypes: string[];
		};
		expect([fixture.fixtureSchema, fixture.protocolMajor, fixture.protocolMinor]).toEqual([
			1, 1, 1
		]);

		const clientByType = new Map(
			fixture.clientMessages.map((entry) => [String(entry.message.type), entry.message])
		);
		const serverByType = new Map(
			fixture.serverMessages.map((entry) => [String(entry.message.type), entry.message])
		);
		expect([...clientByType.keys()].sort()).toEqual([...fixture.strictInvalidClientTypes].sort());
		expect([...serverByType.keys()].sort()).toEqual([...fixture.strictInvalidServerTypes].sort());

		for (const { message } of fixture.clientMessages) {
			expect(decode(message)).toEqual(message as ClientMessage);
			const data = message.data as Record<string, unknown>;
			expectMalformed({ ...message, data: { ...data, unexpected: true } });
		}
		for (const { message } of fixture.serverMessages) {
			expect(JSON.parse(encodeServerMessage(message as ServerMessage))).toEqual(message);
			const data = message.data as Record<string, unknown>;
			expect(() =>
				encodeServerMessage({
					...message,
					data: { ...data, unexpected: true }
				} as unknown as ServerMessage)
			).toThrow(ProtocolError);
		}
	});
});
