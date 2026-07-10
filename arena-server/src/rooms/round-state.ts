import type {
	FrozenRound,
	LaunchCancellationReason,
	SelectionSnapshot
} from '../protocol/messages.ts';
import type { FrozenReplyBasis, LoadReport, ProbeReport } from './models.ts';

export const PROBE_TIMEOUT_MS = 15_000;
export const LOAD_TIMEOUT_MS = 60_000;
export const RTT_SAMPLE_MAX_AGE_MS = 60_000;
export const RTT_SAMPLE_WINDOW = 8;

export type RoundParticipantProgress = Readonly<{
	memberId: string;
	inventoryRevision: number;
	probeNonce: string;
	probeAnswer?: ProbeReport;
	loadAnswer?: LoadReport;
}>;

export type RoundLoadingState = Readonly<{
	round: FrozenRound;
	participants: readonly RoundParticipantProgress[];
	probeDeadlineMs: number;
	loadDeadlineMs?: number;
	startAtServerMs?: number;
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
		participants: readonly Readonly<{ memberId: string; inventoryRevision: number }>[];
	}>
): FrozenRound {
	return {
		roundId: input.roundId,
		launchAttemptId: input.launchAttemptId,
		selectionRevision: input.selectionRevision,
		availabilityRevision: input.availabilityRevision,
		selection: copySelectionSnapshot(input.selection),
		participants: input.participants.map((participant) => ({ ...participant })),
		stage: 'probing'
	};
}

export function beginRoundLoading(
	round: FrozenRound,
	participants: readonly Readonly<{
		memberId: string;
		inventoryRevision: number;
		probeNonce: string;
	}>[],
	nowMs: number
): RoundLoadingState {
	return {
		round: copyFrozenRound(round, 'probing'),
		participants: participants.map((participant) => ({ ...participant })),
		probeDeadlineMs: nowMs + PROBE_TIMEOUT_MS
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

	const participants = state.participants.map((candidate, candidateIndex) =>
		candidateIndex === index ? { ...candidate, loadAnswer: copyLoadReport(report) } : candidate
	);
	return {
		kind: 'accepted',
		state: { ...state, participants },
		barrierComplete: participants.every((candidate) => candidate.loadAnswer?.ok === true)
	};
}

export function scheduleRound(
	state: RoundLoadingState,
	startAtServerMs: number
): RoundLoadingState {
	return {
		...state,
		round: copyFrozenRound(state.round, 'scheduled'),
		startAtServerMs
	};
}

export function startRound(state: RoundLoadingState): RoundLoadingState {
	return { ...state, round: copyFrozenRound(state.round, 'playing') };
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
	round: FrozenRound,
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
	return left.ok ? right.ok : !right.ok && left.reason === right.reason;
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
	return report.ok ? { ...basis, ok: true } : { ...basis, ok: false, reason: report.reason };
}

export function copyFrozenRound(
	round: FrozenRound,
	stage: FrozenRound['stage'] = round.stage
): FrozenRound {
	return {
		...round,
		selection: copySelectionSnapshot(round.selection),
		participants: round.participants.map((participant) => ({ ...participant })),
		stage
	};
}

export function sha256Bytes(sha256: string): Uint8Array {
	return Uint8Array.from(Buffer.from(sha256, 'hex'));
}
