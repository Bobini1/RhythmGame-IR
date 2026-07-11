import {
	arenaTelemetrySchema,
	type ArenaDnfReason,
	type ArenaFinalResult,
	type ArenaJudgements,
	type ArenaTelemetry,
	type GaugeSnapshot,
	type LiveStandingEntry,
	type PublicIdentity
} from '../protocol/messages.ts';

export type CompetitionParticipant = Readonly<{
	frozenIndex: number;
	memberId: string;
	identity: PublicIdentity;
	connectionStatus: 'connected' | 'reserved';
	telemetry?: ArenaTelemetry;
	terminal?:
		| Readonly<{ kind: 'finished'; result: ArenaFinalResult }>
		| Readonly<{ kind: 'dnf'; reason: ArenaDnfReason }>;
}>;

type RankedTerminalEntryBase = Readonly<{
	memberId: string;
	identity: PublicIdentity;
}>;

export type RankedTerminalEntry = RankedTerminalEntryBase &
	(
		| Readonly<{
				competitionState: 'finished';
				rank: number;
				result: ArenaFinalResult;
		  }>
		| Readonly<{
				competitionState: 'dnf';
				rank: null;
				dnfReason: ArenaDnfReason;
		  }>
	);

type ScoredParticipant = Readonly<{
	participant: CompetitionParticipant;
	score: number;
}>;

const judgementKeys = [
	'perfect',
	'great',
	'good',
	'bad',
	'poor',
	'emptyPoor'
] as const satisfies readonly (keyof ArenaJudgements)[];

function copyJudgements(judgements: ArenaJudgements): ArenaJudgements {
	return Object.freeze({ ...judgements });
}

function copyGauge(gauge: GaugeSnapshot): GaugeSnapshot {
	return Object.freeze({ ...gauge });
}

function copyTelemetry(telemetry: ArenaTelemetry): ArenaTelemetry {
	return Object.freeze({
		...telemetry,
		judgements: copyJudgements(telemetry.judgements),
		gauge: copyGauge(telemetry.gauge)
	});
}

function copyFinalResult(result: ArenaFinalResult): ArenaFinalResult {
	return Object.freeze({
		...result,
		judgements: copyJudgements(result.judgements),
		finalGauge: copyGauge(result.finalGauge)
	});
}

function copyIdentity(identity: PublicIdentity): PublicIdentity {
	return Object.freeze({ ...identity });
}

function scoreOf(participant: CompetitionParticipant): number | undefined {
	if (participant.terminal?.kind === 'finished') return participant.terminal.result.exScore;
	if (participant.terminal?.kind === 'dnf') return undefined;
	return participant.telemetry?.exScore;
}

function rankFor(score: number, scored: readonly ScoredParticipant[]): number {
	return 1 + scored.filter((candidate) => candidate.score > score).length;
}

function byScoreThenFrozen(left: ScoredParticipant, right: ScoredParticipant): number {
	return right.score - left.score || left.participant.frozenIndex - right.participant.frozenIndex;
}

export function validateTelemetryProgression(
	previous: ArenaTelemetry | undefined,
	next: ArenaTelemetry
): boolean {
	if (!arenaTelemetrySchema.safeParse(next).success) return false;
	if (previous === undefined) return true;
	if (!arenaTelemetrySchema.safeParse(previous).success || next.sequence <= previous.sequence) {
		return false;
	}
	if (
		next.exScore < previous.exScore ||
		next.progressPermille < previous.progressPermille ||
		next.maxCombo < previous.maxCombo ||
		next.badPoorCount < previous.badPoorCount
	) {
		return false;
	}
	return judgementKeys.every((key) => next.judgements[key] >= previous.judgements[key]);
}

export function buildLiveStandings(
	participants: readonly CompetitionParticipant[]
): readonly LiveStandingEntry[] {
	const scored = participants
		.map((participant) => {
			const score = scoreOf(participant);
			return score === undefined ? undefined : { participant, score };
		})
		.filter((entry): entry is ScoredParticipant => entry !== undefined);
	const ranked = [...scored].sort(byScoreThenFrozen);
	const noData = participants
		.filter(
			(participant) => participant.terminal === undefined && participant.telemetry === undefined
		)
		.sort((left, right) => left.frozenIndex - right.frozenIndex);
	const dnf = participants
		.filter((participant) => participant.terminal?.kind === 'dnf')
		.sort((left, right) => left.frozenIndex - right.frozenIndex);

	const entries: LiveStandingEntry[] = [];
	for (const { participant, score } of ranked) {
		if (participant.terminal?.kind === 'finished') {
			entries.push(
				Object.freeze({
					memberId: participant.memberId,
					connectionStatus: participant.connectionStatus,
					competitionState: 'finished',
					rank: rankFor(score, scored),
					result: copyFinalResult(participant.terminal.result)
				})
			);
		} else if (participant.telemetry !== undefined) {
			entries.push(
				Object.freeze({
					memberId: participant.memberId,
					connectionStatus: participant.connectionStatus,
					competitionState: 'playing',
					rank: rankFor(score, scored),
					telemetry: copyTelemetry(participant.telemetry)
				})
			);
		}
	}
	for (const participant of noData) {
		entries.push(
			Object.freeze({
				memberId: participant.memberId,
				connectionStatus: participant.connectionStatus,
				competitionState: 'playing',
				rank: null,
				telemetry: null
			})
		);
	}
	for (const participant of dnf) {
		if (participant.terminal?.kind !== 'dnf') continue;
		entries.push(
			Object.freeze({
				memberId: participant.memberId,
				connectionStatus: participant.connectionStatus,
				competitionState: 'dnf',
				rank: null,
				dnfReason: participant.terminal.reason
			})
		);
	}
	return Object.freeze(entries);
}

export function buildFinalStandings(participants: readonly CompetitionParticipant[]): Readonly<{
	entries: readonly RankedTerminalEntry[];
	winnerMemberIds: readonly string[];
}> {
	if (participants.some((participant) => participant.terminal === undefined)) {
		throw new Error('Arena final standings require every frozen participant to be terminal.');
	}
	const finished = participants
		.filter(
			(
				participant
			): participant is CompetitionParticipant & {
				terminal: Readonly<{ kind: 'finished'; result: ArenaFinalResult }>;
			} => participant.terminal?.kind === 'finished'
		)
		.map((participant) => ({ participant, score: participant.terminal.result.exScore }))
		.sort(byScoreThenFrozen);
	const dnf = participants
		.filter(
			(
				participant
			): participant is CompetitionParticipant & {
				terminal: Readonly<{ kind: 'dnf'; reason: ArenaDnfReason }>;
			} => participant.terminal?.kind === 'dnf'
		)
		.sort((left, right) => left.frozenIndex - right.frozenIndex);

	const entries: RankedTerminalEntry[] = finished.map(({ participant, score }) =>
		Object.freeze({
			memberId: participant.memberId,
			identity: copyIdentity(participant.identity),
			competitionState: 'finished' as const,
			rank: rankFor(score, finished),
			result: copyFinalResult(participant.terminal.result)
		})
	);
	for (const participant of dnf) {
		entries.push(
			Object.freeze({
				memberId: participant.memberId,
				identity: copyIdentity(participant.identity),
				competitionState: 'dnf',
				rank: null,
				dnfReason: participant.terminal.reason
			})
		);
	}
	const winnerMemberIds = entries
		.filter((entry) => entry.competitionState === 'finished' && entry.rank === 1)
		.map((entry) => entry.memberId);
	return Object.freeze({
		entries: Object.freeze(entries),
		winnerMemberIds: Object.freeze(winnerMemberIds)
	});
}
