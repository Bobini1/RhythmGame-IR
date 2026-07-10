import { describe, expect, test } from 'bun:test';

import type {
	ArenaFinalResult,
	ArenaTelemetry,
	PublicIdentity
} from '../../src/protocol/messages.ts';
import {
	buildFinalStandings,
	buildLiveStandings,
	validateTelemetryProgression,
	type CompetitionParticipant
} from '../../src/rooms/standings.ts';

const identity = (memberId: string): PublicIdentity => ({
	userId: `user-${memberId}`,
	displayName: memberId,
	avatarUrl: null
});

function telemetry(exScore: number, sequence = 1): ArenaTelemetry {
	const perfect = Math.floor(exScore / 2);
	const great = exScore - perfect * 2;
	return {
		sequence,
		exScore,
		progressPermille: 500,
		maxCombo: 50,
		badPoorCount: 6,
		judgements: { perfect, great, good: 4, bad: 1, poor: 2, emptyPoor: 3 },
		gauge: { type: 'normal', valueMilli: 50_000 },
		playStatus: 'playing'
	};
}

function finalResult(exScore: number): ArenaFinalResult {
	const sample = telemetry(exScore);
	return {
		exScore,
		maxCombo: sample.maxCombo,
		badPoorCount: sample.badPoorCount,
		judgements: sample.judgements,
		clearType: 'normal',
		finalGauge: sample.gauge
	};
}

function participant(
	memberId: string,
	frozenIndex: number,
	overrides: Partial<CompetitionParticipant> = {}
): CompetitionParticipant {
	return {
		frozenIndex,
		memberId,
		identity: identity(memberId),
		connectionStatus: 'connected',
		...overrides
	};
}

describe('Arena telemetry progression', () => {
	test('accepts a first sample, nondecreasing counters, and arbitrary gauge changes', () => {
		const first = telemetry(100, 1);
		expect(validateTelemetryProgression(undefined, first)).toBe(true);
		expect(
			validateTelemetryProgression(first, {
				...first,
				sequence: 2,
				exScore: 103,
				progressPermille: 501,
				maxCombo: 51,
				badPoorCount: 7,
				judgements: {
					perfect: 51,
					great: 1,
					good: 5,
					bad: 2,
					poor: 2,
					emptyPoor: 3
				},
				gauge: { type: 'hard', valueMilli: 1 }
			})
		).toBe(true);
	});

	test('rejects duplicate sequence, every counter regression, and EX/BP inconsistency', () => {
		const previous = telemetry(100, 10);
		const validNext = { ...previous, sequence: 11 };
		for (const next of [
			{ ...validNext, sequence: 10 },
			{ ...validNext, exScore: 99 },
			{ ...validNext, progressPermille: 499 },
			{ ...validNext, maxCombo: 49 },
			{ ...validNext, badPoorCount: 5 },
			{ ...validNext, judgements: { ...validNext.judgements, perfect: 49 } },
			{ ...validNext, judgements: { ...validNext.judgements, great: -1 } },
			{ ...validNext, judgements: { ...validNext.judgements, good: 3 } },
			{ ...validNext, judgements: { ...validNext.judgements, bad: 0 } },
			{ ...validNext, judgements: { ...validNext.judgements, poor: 1 } },
			{ ...validNext, judgements: { ...validNext.judgements, emptyPoor: 2 } },
			{ ...validNext, exScore: 101 },
			{ ...validNext, badPoorCount: 7 }
		]) {
			expect(validateTelemetryProgression(previous, next as ArenaTelemetry)).toBe(false);
		}
	});
});

describe('Arena live standings', () => {
	test('distinguishes no data from zero and produces 1,1,3 with frozen-order ties', () => {
		const standings = buildLiveStandings([
			participant('no-data', 0),
			participant('a', 1, { telemetry: telemetry(100) }),
			participant('b', 2, { telemetry: telemetry(100) }),
			participant('c', 3, { telemetry: telemetry(90) }),
			participant('zero', 4, { telemetry: telemetry(0) }),
			participant('dnf', 5, { terminal: { kind: 'dnf', reason: 'aborted' } })
		]);

		expect(standings.map((entry) => entry.memberId)).toEqual([
			'a',
			'b',
			'c',
			'zero',
			'no-data',
			'dnf'
		]);
		expect(standings.map((entry) => entry.rank)).toEqual([1, 1, 3, 4, null, null]);
		const noData = standings.find((entry) => entry.memberId === 'no-data');
		expect(noData).toEqual(
			expect.objectContaining({ competitionState: 'playing', telemetry: null, rank: null })
		);
		const zero = standings.find((entry) => entry.memberId === 'zero');
		expect(zero).toEqual(expect.objectContaining({ competitionState: 'playing', rank: 4 }));
	});

	test('uses immutable finals before telemetry and retains reserved connection status', () => {
		const standings = buildLiveStandings([
			participant('finished', 0, {
				connectionStatus: 'reserved',
				telemetry: telemetry(999),
				terminal: { kind: 'finished', result: finalResult(50) }
			}),
			participant('playing', 1, { telemetry: telemetry(60) })
		]);
		expect(standings.map((entry) => [entry.memberId, entry.rank])).toEqual([
			['playing', 1],
			['finished', 2]
		]);
		expect(standings[1]).toEqual(
			expect.objectContaining({
				competitionState: 'finished',
				connectionStatus: 'reserved',
				result: expect.objectContaining({ exScore: 50 })
			})
		);
		expect(Object.isFrozen(standings)).toBe(true);
		expect(Object.isFrozen(standings[1])).toBe(true);
		if (standings[1]?.competitionState === 'finished') {
			expect(Object.isFrozen(standings[1].result)).toBe(true);
			expect(Object.isFrozen(standings[1].result.judgements)).toBe(true);
		}
	});
});

describe('Arena final standings', () => {
	test('sorts finished scores, assigns competition ranks, and returns every joint winner', () => {
		const built = buildFinalStandings([
			participant('dnf', 0, { terminal: { kind: 'dnf', reason: 'play_deadline' } }),
			participant('a', 1, { terminal: { kind: 'finished', result: finalResult(100) } }),
			participant('b', 2, { terminal: { kind: 'finished', result: finalResult(100) } }),
			participant('c', 3, { terminal: { kind: 'finished', result: finalResult(90) } })
		]);
		expect(built.entries.map((entry) => [entry.memberId, entry.rank])).toEqual([
			['a', 1],
			['b', 1],
			['c', 3],
			['dnf', null]
		]);
		expect(built.winnerMemberIds).toEqual(['a', 'b']);
	});

	test('accepts a zero-score winner and produces no winner when all participants DNF', () => {
		expect(
			buildFinalStandings([
				participant('zero', 0, { terminal: { kind: 'finished', result: finalResult(0) } }),
				participant('dnf', 1, { terminal: { kind: 'dnf', reason: 'left' } })
			]).winnerMemberIds
		).toEqual(['zero']);
		expect(
			buildFinalStandings([
				participant('a', 0, { terminal: { kind: 'dnf', reason: 'kicked' } }),
				participant('b', 1, { terminal: { kind: 'dnf', reason: 'grace_expired' } })
			]).winnerMemberIds
		).toEqual([]);
	});

	test('rejects finalization while any frozen participant is nonterminal', () => {
		expect(() => buildFinalStandings([participant('active', 0)])).toThrow();
	});
});
