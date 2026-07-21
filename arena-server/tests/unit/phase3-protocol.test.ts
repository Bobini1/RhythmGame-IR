import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { decodeClientMessage, encodeServerMessage } from '../../src/protocol/codec.ts';
import { ProtocolError } from '../../src/protocol/errors.ts';
import {
	COMPETITION_CAPABILITY,
	competitionRoomSnapshotSchema,
	MAX_FINALIZATION_MESSAGE_BYTES,
	MAX_RESULT_SNAPSHOT_BYTES,
	MAX_STANDINGS_MESSAGE_BYTES,
	PROTOCOL_MINOR,
	ROOMS_CAPABILITY,
	ROUNDS_CAPABILITY,
	type ArenaFinalResult,
	type ArenaTelemetry,
	type ClientMessage,
	type Member,
	type RoundResultSnapshot,
	type SelectionSnapshot,
	type ServerMessage
} from '../../src/protocol/messages.ts';

const binding = {
	roomId: 'room-phase3',
	roomGeneration: 2,
	connectionGeneration: 3
} as const;
const identity = {
	userId: 'user-phase3',
	displayName: 'Phase 3 Player',
	avatarUrl: null
} as const;
const selection: SelectionSnapshot = {
	sha256: '11'.repeat(32),
	title: 'Competition chart',
	subtitle: '',
	artist: 'Composer',
	keyMode: 7,
	randomSequence: [1, 2, 3],
	noteOrderP1: 'random',
	noteOrderP2: 'normal_or_mirror',
	dpMode: 'off',
	laneSeed: '0123456789abcdef',
	randomizationVersion: 1
};
const judgements = {
	perfect: 40,
	great: 20,
	good: 4,
	bad: 1,
	poor: 2,
	emptyPoor: 3
} as const;
const telemetry: ArenaTelemetry = {
	sequence: 1,
	exScore: 100,
	progressPermille: 500,
	maxCombo: 64,
	badPoorCount: 6,
	judgements,
	gauge: { type: 'normal', valueMilli: 55_000 },
	playStatus: 'playing'
};
const result: ArenaFinalResult = {
	exScore: 100,
	maxCombo: 64,
	badPoorCount: 6,
	judgements,
	clearType: 'normal',
	finalGauge: { type: 'normal', valueMilli: 75_000 }
};
const member: Member = {
	memberId: 'member-phase3',
	identity,
	status: 'connected',
	lobbyWins: 1,
	ready: false,
	inventoryState: 'ready',
	inventoryRevision: 1,
	availabilityAppliedRevision: 1,
	roundState: 'playing'
};
const finalResult: RoundResultSnapshot = {
	resultRevision: 1,
	roundId: 'round-phase3',
	selectionRevision: 1,
	finalizedAtServerMs: 50_000,
	participantCount: 1,
	selection,
	winnerMemberIds: ['member-phase3'],
	entries: [
		{
			memberId: 'member-phase3',
			identity,
			lobbyWinsAfter: 1,
			competitionState: 'finished',
			rank: 1,
			result
		}
	]
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

describe('Arena protocol 1.0 competition negotiation', () => {
	test('accepts capability levels at exact 1.0 and enforces dependencies', () => {
		expect(PROTOCOL_MINOR).toBe(0);
		for (const capabilities of [
			[ROOMS_CAPABILITY],
			[ROOMS_CAPABILITY, ROUNDS_CAPABILITY],
			[ROOMS_CAPABILITY, ROUNDS_CAPABILITY, COMPETITION_CAPABILITY]
		] as const) {
			expect(
				decode({
					type: 'client_hello',
					data: {
						protocolMajor: 1,
						protocolMinor: 0,
						clientVersion: 'phase3-test',
						capabilities
					}
				})
			).toEqual(expect.objectContaining({ data: expect.objectContaining({ protocolMinor: 0 }) }));
		}
		expectMalformed({
			type: 'client_hello',
			data: {
				protocolMajor: 1,
				protocolMinor: 0,
				clientVersion: 'phase3-test',
				capabilities: [ROOMS_CAPABILITY, COMPETITION_CAPABILITY]
			}
		});
		expect(() =>
			decode({
				type: 'client_hello',
				data: {
					protocolMajor: 1,
					protocolMinor: 3,
					clientVersion: 'phase3-test',
					capabilities: [ROOMS_CAPABILITY, ROUNDS_CAPABILITY, COMPETITION_CAPABILITY]
				}
			})
		).toThrow(ProtocolError);
	});
});

describe('Arena Phase 3 client contract', () => {
	const messages = [
		{
			type: 'round_telemetry',
			data: {
				...binding,
				roundId: 'round-phase3',
				launchAttemptId: 'attempt-phase3',
				telemetry
			}
		},
		{
			type: 'round_result_submit',
			requestId: 'result-phase3',
			data: {
				...binding,
				roundId: 'round-phase3',
				launchAttemptId: 'attempt-phase3',
				result
			}
		},
		{
			type: 'round_abandon',
			requestId: 'abandon-phase3',
			data: {
				...binding,
				roundId: 'round-phase3',
				launchAttemptId: 'attempt-phase3',
				reason: 'aborted'
			}
		},
		{
			type: 'round_load_result',
			requestId: 'load-phase3',
			data: {
				...binding,
				roundId: 'round-phase3',
				launchAttemptId: 'attempt-phase3',
				selectionRevision: 1,
				availabilityRevision: 1,
				inventoryRevision: 1,
				ok: true,
				chartLengthMs: 21_600_000
			}
		}
	] as const;

	test('accepts strict nested competition values', () => {
		for (const message of messages) expect(decode(message)).toEqual(message);
		for (const message of messages) {
			expectMalformed({ ...message, data: { ...message.data, unexpected: true } });
		}
	});

	test('enforces EX, BP, integer, enum, and chart-length bounds', () => {
		const base = messages[0];
		for (const invalidTelemetry of [
			{ ...telemetry, exScore: 99 },
			{ ...telemetry, badPoorCount: 5 },
			{ ...telemetry, sequence: 0 },
			{ ...telemetry, exScore: 100_000_001 },
			{ ...telemetry, progressPermille: 1_001 },
			{ ...telemetry, gauge: { ...telemetry.gauge, valueMilli: 100_001 } },
			{ ...telemetry, playStatus: 'paused' },
			{ ...telemetry, judgements: { ...telemetry.judgements, unexpected: 1 } }
		]) {
			expectMalformed({ ...base, data: { ...base.data, telemetry: invalidTelemetry } });
		}
		for (const chartLengthMs of [-1, 21_600_001, 0.5]) {
			expectMalformed({
				...messages[3],
				data: { ...messages[3].data, chartLengthMs }
			});
		}
	});
});

describe('Arena Phase 3 server contract', () => {
	const standings: ServerMessage = {
		type: 'round_standings',
		data: {
			roomId: binding.roomId,
			roomGeneration: binding.roomGeneration,
			roundId: 'round-phase3',
			launchAttemptId: 'attempt-phase3',
			standingsRevision: 1,
			entries: [
				{
					memberId: member.memberId,
					connectionStatus: 'connected',
					competitionState: 'playing',
					rank: 1,
					telemetry
				}
			]
		}
	};
	const finalized: ServerMessage = {
		type: 'round_finalized',
		data: {
			roomId: binding.roomId,
			roomGeneration: binding.roomGeneration,
			roundId: 'round-phase3',
			launchAttemptId: 'attempt-phase3',
			result: finalResult,
			members: [member]
		}
	};
	const messages: readonly ServerMessage[] = [
		standings,
		{
			type: 'round_terminal_accepted',
			requestId: 'result-phase3',
			data: {
				roomId: binding.roomId,
				roomGeneration: binding.roomGeneration,
				roundId: 'round-phase3',
				launchAttemptId: 'attempt-phase3',
				terminal: 'finished'
			}
		},
		finalized,
		{
			type: 'round_start_scheduled',
			data: {
				...binding,
				roundId: 'round-phase3',
				launchAttemptId: 'attempt-phase3',
				startAtServerMs: 100_000,
				startAfterMs: 2_000,
				playDeadlineAtServerMs: 280_000
			}
		},
		{
			type: 'round_started',
			data: {
				roomId: binding.roomId,
				roomGeneration: binding.roomGeneration,
				roundId: 'round-phase3',
				launchAttemptId: 'attempt-phase3',
				playDeadlineAtServerMs: 280_000
			}
		}
	];

	test('encodes every strict competition event', () => {
		for (const message of messages) {
			expect(JSON.parse(encodeServerMessage(message))).toEqual(message);
			expect(() =>
				encodeServerMessage({
					...message,
					data: { ...message.data, unexpected: true }
				} as unknown as ServerMessage)
			).toThrow(ProtocolError);
		}
		expect(() =>
			encodeServerMessage({
				...standings,
				data: {
					...standings.data,
					entries: [{ ...standings.data.entries[0]!, telemetry: null, rank: 1 }]
				}
			} as ServerMessage)
		).toThrow(ProtocolError);
	});

	test('publishes exact per-variant encoded caps', () => {
		expect(MAX_STANDINGS_MESSAGE_BYTES).toBe(65_536);
		expect(MAX_RESULT_SNAPSHOT_BYTES).toBe(262_144);
		expect(MAX_FINALIZATION_MESSAGE_BYTES).toBe(524_288);
		expect(new TextEncoder().encode(encodeServerMessage(standings)).byteLength).toBeLessThanOrEqual(
			MAX_STANDINGS_MESSAGE_BYTES
		);
		expect(new TextEncoder().encode(JSON.stringify(finalResult)).byteLength).toBeLessThanOrEqual(
			MAX_RESULT_SNAPSHOT_BYTES
		);
		expect(new TextEncoder().encode(encodeServerMessage(finalized)).byteLength).toBeLessThanOrEqual(
			MAX_FINALIZATION_MESSAGE_BYTES
		);
	});

	test('fits every legal maximum-shape competition value under its dedicated cap', () => {
		const maximumSelection: SelectionSnapshot = {
			...selection,
			title: 'T'.repeat(200),
			subtitle: 'S'.repeat(200),
			artist: 'A'.repeat(200),
			randomSequence: Array.from({ length: 4_096 }, (_, index) => index + 1)
		};
		const identities = Array.from({ length: 32 }, (_, index) => ({
			userId: `maximum-user-${index}`,
			displayName: `${index}`.padStart(2, '0') + 'N'.repeat(78),
			avatarUrl: `https://example.test/${'a'.repeat(1_900)}-${index}`
		}));
		const entries = identities.map((entryIdentity, index) => ({
			memberId: `maximum-member-${index}`,
			identity: entryIdentity,
			lobbyWinsAfter: 0xffff_ffff,
			competitionState: 'finished' as const,
			rank: 1,
			result
		}));
		const maximumResult: RoundResultSnapshot = {
			...finalResult,
			participantCount: 32,
			selection: maximumSelection,
			winnerMemberIds: entries.map((entry) => entry.memberId),
			entries
		};
		const maximumStandings: ServerMessage = {
			type: 'round_standings',
			data: {
				...standings.data,
				entries: entries.map((entry) => ({
					memberId: entry.memberId,
					connectionStatus: 'connected' as const,
					competitionState: 'finished' as const,
					rank: 1,
					result
				}))
			}
		};
		const maximumMembers: Member[] = entries.map((entry) => ({
			...member,
			memberId: entry.memberId,
			identity: entry.identity,
			lobbyWins: 0xffff_ffff
		}));
		const maximumFinalization: ServerMessage = {
			type: 'round_finalized',
			data: { ...finalized.data, result: maximumResult, members: maximumMembers }
		};

		expect(
			new TextEncoder().encode(encodeServerMessage(maximumStandings)).byteLength
		).toBeLessThanOrEqual(MAX_STANDINGS_MESSAGE_BYTES);
		expect(new TextEncoder().encode(JSON.stringify(maximumResult)).byteLength).toBeLessThanOrEqual(
			MAX_RESULT_SNAPSHOT_BYTES
		);
		expect(
			new TextEncoder().encode(encodeServerMessage(maximumFinalization)).byteLength
		).toBeLessThanOrEqual(MAX_FINALIZATION_MESSAGE_BYTES);
	});

	test('requires nullable competition state keys on a competition-capable room snapshot', () => {
		const room = {
			roomId: binding.roomId,
			roomGeneration: binding.roomGeneration,
			name: 'Room',
			phase: 'selecting',
			hasPassword: false,
			maxCount: 32,
			ownerMemberId: member.memberId,
			self: {
				memberId: member.memberId,
				connectionGeneration: binding.connectionGeneration,
				resumeToken: 'resume-token'
			},
			members: [member],
			chat: [],
			selection,
			selectionRevision: 1,
			availabilityRevision: 1,
			liveStandings: null,
			lastRoundResult: finalResult
		};
		expect(competitionRoomSnapshotSchema.safeParse(room).success).toBe(true);
		const { liveStandings: _liveStandings, ...roomWithoutLiveStandings } = room;
		expect(competitionRoomSnapshotSchema.safeParse(roomWithoutLiveStandings).success).toBe(false);
	});
});

describe('Arena Phase 3 canonical text fixture', () => {
	test('covers every new or extended discriminator with strict-invalid derivatives', () => {
		const fixture = JSON.parse(
			readFileSync(`${import.meta.dir}/../fixtures/phase3-text-goldens.json`, 'utf8')
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
			1, 1, 0
		]);
		expect(fixture.clientMessages.map((entry) => String(entry.message.type)).sort()).toEqual(
			[...fixture.strictInvalidClientTypes].sort()
		);
		expect(fixture.serverMessages.map((entry) => String(entry.message.type)).sort()).toEqual(
			[...fixture.strictInvalidServerTypes].sort()
		);
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
