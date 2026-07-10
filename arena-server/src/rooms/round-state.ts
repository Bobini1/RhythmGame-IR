import type {
	ArenaDnfReason,
	ArenaFinalResult,
	ArenaTelemetry,
	CompetitionFrozenRound,
	LaunchCancellationReason,
	PublicIdentity,
	SelectionSnapshot
} from '../protocol/messages.ts';
import type { CompetitionParticipant } from './standings.ts';
import { TelemetryLimiter } from './telemetry-limiter.ts';
import type { FrozenReplyBasis, LoadReport, ProbeReport } from './models.ts';

export const PROBE_TIMEOUT_MS = 15_000;
export const LOAD_TIMEOUT_MS = 60_000;
export const RTT_SAMPLE_MAX_AGE_MS = 60_000;
export const RTT_SAMPLE_WINDOW = 8;
export const STANDINGS_INTERVAL_MS = 200;
export const MAX_CHART_LENGTH_MS = 21_600_000;
export const MIN_PLAY_WINDOW_MS = 180_000;
export const MAX_PLAY_WINDOW_MS = 21_720_000;

export type RoundParticipantProgress = CompetitionParticipant &
	Readonly<{
		inventoryRevision: number;
		probeNonce: string;
		probeAnswer?: ProbeReport;
		loadAnswer?: LoadReport;
		limiter: TelemetryLimiter;
		terminalAttemptTimes: readonly number[];
	}>;

export type RoundLoadingState = Readonly<{
	round: CompetitionFrozenRound;
	participants: readonly RoundParticipantProgress[];
	probeDeadlineMs: number;
	loadDeadlineMs?: number;
	chartLengthMs?: number;
	startAtServerMs?: number;
	standingsRevision: number;
	nextStandingsFlushMs?: number;
	lastStandingsFlushMs?: number;
}>;

export type RoundReplyTransition =
	| Readonly<{ kind: 'rejected' }>
	| Readonly<{ kind: 'duplicate' }>
	| Readonly<{ kind: 'expired' }>
	| Readonly<{ kind: 'cancelled'; reason: LaunchCancellationReason }>
	| Readonly<{ kind: 'accepted'; state: RoundLoadingState; barrierComplete: boolean }>;

export type SelectionState = Readonly<{
	selection: SelectionSnapshot | null;
	selectionRevision: number;
	selectedByMemberId: string | null;
}>;

export function copySelectionSnapshot(selection: SelectionSnapshot): SelectionSnapshot {
	return {
		sha256: selection.sha256,
		...(selection.md5 === undefined ? {} : { md5: selection.md5 }),
		title: selection.title,
		subtitle: selection.subtitle,
		artist: selection.artist,
		keyMode: selection.keyMode,
		randomSequence: [...selection.randomSequence],
		noteOrderP1: selection.noteOrderP1,
		noteOrderP2: selection.noteOrderP2,
		dpMode: selection.dpMode,
		laneSeed: selection.laneSeed,
		randomizationVersion: selection.randomizationVersion
	};
}

export function replaceSelection(
	state: SelectionState,
	selection: SelectionSnapshot,
	selectedByMemberId: string
): Readonly<{
	selection: SelectionSnapshot;
	selectionRevision: number;
	selectedByMemberId: string;
}> {
	return {
		selection: copySelectionSnapshot(selection),
		selectionRevision: state.selectionRevision + 1,
		selectedByMemberId
	};
}

export function clearSelection(state: SelectionState): SelectionState {
	if (state.selection === null) return state;
	return {
		selection: null,
		selectionRevision: state.selectionRevision + 1,
		selectedByMemberId: null
	};
}

export function freezeRound(
	input: Readonly<{
		roundId: string;
		launchAttemptId: string;
		selection: SelectionSnapshot;
		selectionRevision: number;
		availabilityRevision: number;
		participants: readonly Readonly<{
			memberId: string;
			inventoryRevision: number;
			identity: PublicIdentity;
		}>[];
	}>
): CompetitionFrozenRound {
	return {
		roundId: input.roundId,
		launchAttemptId: input.launchAttemptId,
		selectionRevision: input.selectionRevision,
		availabilityRevision: input.availabilityRevision,
		selection: copySelectionSnapshot(input.selection),
		participants: input.participants.map((participant) => ({
			memberId: participant.memberId,
			inventoryRevision: participant.inventoryRevision,
			identity: { ...participant.identity }
		})),
		stage: 'probing'
	};
}

export function beginRoundLoading(
	round: CompetitionFrozenRound,
	participants: readonly Readonly<{
		memberId: string;
		inventoryRevision: number;
		probeNonce: string;
		connectionStatus: 'connected' | 'reserved';
	}>[],
	nowMs: number
): RoundLoadingState {
	return {
		round: copyFrozenRound(round, 'probing'),
		participants: participants.map((participant, frozenIndex) => {
			const frozen = round.participants[frozenIndex];
			if (frozen === undefined || frozen.memberId !== participant.memberId) {
				throw new Error('Arena runtime participants must match frozen roster order.');
			}
			return {
				...participant,
				frozenIndex,
				identity: { ...frozen.identity },
				limiter: new TelemetryLimiter(),
				terminalAttemptTimes: []
			};
		}),
		probeDeadlineMs: nowMs + PROBE_TIMEOUT_MS,
		standingsRevision: 0
	};
}

export function recordProbeReply(
	state: RoundLoadingState,
	memberId: string,
	report: ProbeReport,
	nowMs: number
): RoundReplyTransition {
	const index = state.participants.findIndex((participant) => participant.memberId === memberId);
	const participant = state.participants[index];
	if (
		participant === undefined ||
		!matchesFrozenBasis(state.round, participant.inventoryRevision, report) ||
		participant.probeNonce !== report.nonce
	) {
		return { kind: 'rejected' };
	}
	if (participant.probeAnswer !== undefined) {
		return sameProbeReply(participant.probeAnswer, report)
			? { kind: 'duplicate' }
			: { kind: 'rejected' };
	}
	if (state.round.stage !== 'probing') return { kind: 'rejected' };
	if (nowMs >= state.probeDeadlineMs) return { kind: 'expired' };
	if (!report.ok) return { kind: 'cancelled', reason: report.reason };
	if (report.sha256 !== state.round.selection.sha256) {
		return { kind: 'cancelled', reason: 'hash_mismatch' };
	}

	const participants = state.participants.map((candidate, candidateIndex) =>
		candidateIndex === index ? { ...candidate, probeAnswer: copyProbeReport(report) } : candidate
	);
	const barrierComplete = participants.every((candidate) => candidate.probeAnswer?.ok === true);
	return {
		kind: 'accepted',
		state: {
			...state,
			round: barrierComplete ? copyFrozenRound(state.round, 'loading') : state.round,
			participants,
			...(barrierComplete ? { loadDeadlineMs: nowMs + LOAD_TIMEOUT_MS } : {})
		},
		barrierComplete
	};
}

export function recordLoadReply(
	state: RoundLoadingState,
	memberId: string,
	report: LoadReport,
	nowMs: number
): RoundReplyTransition {
	const index = state.participants.findIndex((participant) => participant.memberId === memberId);
	const participant = state.participants[index];
	if (
		participant === undefined ||
		!matchesFrozenBasis(state.round, participant.inventoryRevision, report)
	) {
		return { kind: 'rejected' };
	}
	if (participant.loadAnswer !== undefined) {
		return sameLoadReply(participant.loadAnswer, report)
			? { kind: 'duplicate' }
			: { kind: 'rejected' };
	}
	if (state.round.stage !== 'loading' || state.loadDeadlineMs === undefined) {
		return { kind: 'rejected' };
	}
	if (nowMs >= state.loadDeadlineMs) return { kind: 'expired' };
	if (!report.ok) return { kind: 'cancelled', reason: report.reason };
	if (
		!Number.isSafeInteger(report.chartLengthMs) ||
		report.chartLengthMs < 0 ||
		report.chartLengthMs > MAX_CHART_LENGTH_MS
	) {
		return { kind: 'rejected' };
	}
	if (state.chartLengthMs !== undefined && report.chartLengthMs !== state.chartLengthMs) {
		return { kind: 'cancelled', reason: 'chart_length_mismatch' };
	}

	const participants = state.participants.map((candidate, candidateIndex) =>
		candidateIndex === index ? { ...candidate, loadAnswer: copyLoadReport(report) } : candidate
	);
	return {
		kind: 'accepted',
		state: {
			...state,
			participants,
			chartLengthMs: report.chartLengthMs
		},
		barrierComplete: participants.every((candidate) => candidate.loadAnswer?.ok === true)
	};
}

export function playWindowMs(chartLengthMs: number): number {
	return Math.max(MIN_PLAY_WINDOW_MS, Math.min(MAX_PLAY_WINDOW_MS, chartLengthMs + 120_000));
}

export function saturatingIncrementUint32(value: number): number {
	return Math.min(0xffff_ffff, value + 1);
}

export function scheduleRound(
	state: RoundLoadingState,
	startAtServerMs: number
): RoundLoadingState {
	if (state.chartLengthMs === undefined) {
		throw new Error('Arena round cannot be scheduled without an agreed chart length.');
	}
	const playDeadlineAtServerMs = startAtServerMs + playWindowMs(state.chartLengthMs);
	return {
		...state,
		round: copyFrozenRound(state.round, 'scheduled', playDeadlineAtServerMs),
		startAtServerMs
	};
}

export function startRound(state: RoundLoadingState): RoundLoadingState {
	if (state.round.stage !== 'scheduled') {
		throw new Error('Only a scheduled Arena round can start.');
	}
	return {
		...state,
		round: copyFrozenRound(state.round, 'playing', state.round.playDeadlineAtServerMs),
		standingsRevision: 1,
		nextStandingsFlushMs: state.startAtServerMs
	};
}

export function copyTelemetry(telemetry: ArenaTelemetry): ArenaTelemetry {
	return {
		...telemetry,
		judgements: { ...telemetry.judgements },
		gauge: { ...telemetry.gauge }
	};
}

export function copyFinalResult(result: ArenaFinalResult): ArenaFinalResult {
	return {
		...result,
		judgements: { ...result.judgements },
		finalGauge: { ...result.finalGauge }
	};
}

export function copyTerminal(
	terminal: CompetitionParticipant['terminal']
): CompetitionParticipant['terminal'] {
	if (terminal === undefined) return undefined;
	return terminal.kind === 'finished'
		? { kind: 'finished', result: copyFinalResult(terminal.result) }
		: { kind: 'dnf', reason: terminal.reason };
}

export function terminalEquals(
	left: CompetitionParticipant['terminal'],
	right:
		| Readonly<{ kind: 'finished'; result: ArenaFinalResult }>
		| Readonly<{ kind: 'dnf'; reason: ArenaDnfReason }>
): boolean {
	if (left === undefined || left.kind !== right.kind) return false;
	if (left.kind === 'dnf') return right.kind === 'dnf' && left.reason === right.reason;
	if (right.kind !== 'finished') return false;
	const a = left.result;
	const b = right.result;
	return (
		a.exScore === b.exScore &&
		a.maxCombo === b.maxCombo &&
		a.badPoorCount === b.badPoorCount &&
		a.clearType === b.clearType &&
		a.finalGauge.type === b.finalGauge.type &&
		a.finalGauge.valueMilli === b.finalGauge.valueMilli &&
		a.judgements.perfect === b.judgements.perfect &&
		a.judgements.great === b.judgements.great &&
		a.judgements.good === b.judgements.good &&
		a.judgements.bad === b.judgements.bad &&
		a.judgements.poor === b.judgements.poor &&
		a.judgements.emptyPoor === b.judgements.emptyPoor
	);
}

export function currentRttMs(
	samples: readonly Readonly<{ sampledAtMs: number; rttMs: number }>[],
	nowMs: number
): number | undefined {
	const recent = samples
		.filter((sample) => sample.sampledAtMs > nowMs - RTT_SAMPLE_MAX_AGE_MS)
		.slice(-RTT_SAMPLE_WINDOW);
	if (recent.length === 0) return undefined;
	return Math.min(...recent.map((sample) => sample.rttMs));
}

export function startLeadMs(rtts: readonly (number | undefined)[]): number {
	const maxRtt = Math.max(0, ...rtts.map((rtt) => rtt ?? 0));
	return Math.max(2_000, Math.min(5_000, 2_000 + maxRtt));
}

export function connectionStartAfterMs(
	startAtServerMs: number,
	sendNowMs: number,
	rttMs: number | undefined
): number {
	return Math.max(250, startAtServerMs - sendNowMs - Math.floor((rttMs ?? 0) / 2));
}

function matchesFrozenBasis(
	round: CompetitionFrozenRound,
	inventoryRevision: number,
	report: FrozenReplyBasis
): boolean {
	return (
		report.roundId === round.roundId &&
		report.launchAttemptId === round.launchAttemptId &&
		report.selectionRevision === round.selectionRevision &&
		report.availabilityRevision === round.availabilityRevision &&
		report.inventoryRevision === inventoryRevision
	);
}

function sameProbeReply(left: ProbeReport, right: ProbeReport): boolean {
	if (left.ok !== right.ok || left.nonce !== right.nonce) return false;
	return left.ok
		? right.ok && left.sha256 === right.sha256
		: !right.ok && left.reason === right.reason;
}

function sameLoadReply(left: LoadReport, right: LoadReport): boolean {
	if (left.ok !== right.ok) return false;
	return left.ok
		? right.ok && left.chartLengthMs === right.chartLengthMs
		: !right.ok && left.reason === right.reason;
}

function copyProbeReport(report: ProbeReport): ProbeReport {
	const basis = {
		roundId: report.roundId,
		launchAttemptId: report.launchAttemptId,
		selectionRevision: report.selectionRevision,
		availabilityRevision: report.availabilityRevision,
		inventoryRevision: report.inventoryRevision,
		nonce: report.nonce
	};
	return report.ok
		? { ...basis, ok: true, sha256: report.sha256 }
		: { ...basis, ok: false, reason: report.reason };
}

function copyLoadReport(report: LoadReport): LoadReport {
	const basis = {
		roundId: report.roundId,
		launchAttemptId: report.launchAttemptId,
		selectionRevision: report.selectionRevision,
		availabilityRevision: report.availabilityRevision,
		inventoryRevision: report.inventoryRevision
	};
	return report.ok
		? { ...basis, ok: true, chartLengthMs: report.chartLengthMs }
		: { ...basis, ok: false, reason: report.reason };
}

export function copyFrozenRound(
	round: CompetitionFrozenRound,
	stage: CompetitionFrozenRound['stage'] = round.stage,
	playDeadlineAtServerMs?: number
): CompetitionFrozenRound {
	const basis = {
		roundId: round.roundId,
		launchAttemptId: round.launchAttemptId,
		selectionRevision: round.selectionRevision,
		availabilityRevision: round.availabilityRevision,
		selection: copySelectionSnapshot(round.selection),
		participants: round.participants.map((participant) => ({
			memberId: participant.memberId,
			inventoryRevision: participant.inventoryRevision,
			identity: { ...participant.identity }
		}))
	};
	if (stage === 'scheduled' || stage === 'playing') {
		const deadline =
			playDeadlineAtServerMs ??
			(round.stage === 'scheduled' || round.stage === 'playing'
				? round.playDeadlineAtServerMs
				: undefined);
		if (deadline === undefined) {
			throw new Error('Scheduled and Playing Arena rounds require a play deadline.');
		}
		return { ...basis, stage, playDeadlineAtServerMs: deadline };
	}
	return { ...basis, stage };
}

export function sha256Bytes(sha256: string): Uint8Array {
	return Uint8Array.from(Buffer.from(sha256, 'hex'));
}
