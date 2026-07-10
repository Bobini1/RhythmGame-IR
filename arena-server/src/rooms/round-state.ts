import type { FrozenRound, SelectionSnapshot } from '../protocol/messages.ts';

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

export function sha256Bytes(sha256: string): Uint8Array {
	return Uint8Array.from(Buffer.from(sha256, 'hex'));
}
