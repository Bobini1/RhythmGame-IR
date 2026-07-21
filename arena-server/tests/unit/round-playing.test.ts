import { describe, expect, test } from 'bun:test';

import type { ArenaIdentity } from '../../src/auth/identity.ts';
import { PackedInventory } from '../../src/inventory/packed-inventory.ts';
import type {
	ArenaFinalResult,
	ArenaTelemetry,
	CompetitionFrozenRound,
	SelectionSnapshot
} from '../../src/protocol/messages.ts';
import {
	createRoomDirectoryWithEntropy,
	type RoomDirectory
} from '../../src/rooms/room-directory.ts';
import type { RoomEffect, SeatAdmission } from '../../src/rooms/models.ts';
import { saturatingIncrementUint32 } from '../../src/rooms/round-state.ts';
import { FakePasswordHasher } from '../helpers/fake-password-hasher.ts';

const NOW = 1_000_000;
const alice: ArenaIdentity = { userId: 'alice', displayName: 'Alice', avatarUrl: null };
const bob: ArenaIdentity = { userId: 'bob', displayName: 'Bob', avatarUrl: null };

function sha(value: number): string {
	return value.toString(16).padStart(64, '0');
}

function packed(values: readonly number[]): PackedInventory {
	const bytes = new Uint8Array(values.length * 32);
	for (let index = 0; index < values.length; ++index) {
		new DataView(bytes.buffer, index * 32, 32).setUint32(28, values[index]!, false);
	}
	return PackedInventory.fromSortedBytes(bytes);
}

function selection(): SelectionSnapshot {
	return {
		sha256: sha(2),
		title: 'Chart',
		subtitle: '',
		artist: 'Artist',
		keyMode: 7,
		randomSequence: [1, 2],
		noteOrderP1: 'random',
		noteOrderP2: 'normal_or_mirror',
		dpMode: 'off',
		laneSeed: '0123456789abcdef',
		randomizationVersion: 1
	};
}

function createDirectory(): RoomDirectory {
	let entropy = 1;
	return createRoomDirectoryWithEntropy(
		{ roomCapacity: 32, reconnectGraceMs: 60_000, chatBacklog: 200 },
		new FakePasswordHasher(),
		(length) => new Uint8Array(length).fill(entropy++)
	);
}

function effectOf<T extends RoomEffect['type']>(effects: readonly RoomEffect[], type: T) {
	return effects.filter(
		(effect): effect is Extract<RoomEffect, { type: T }> => effect.type === type
	);
}

function telemetry(sequence: number, perfect: number, progressPermille = 500): ArenaTelemetry {
	return {
		sequence,
		exScore: perfect * 2,
		progressPermille,
		maxCombo: perfect,
		badPoorCount: 0,
		judgements: { perfect, great: 0, good: 0, bad: 0, poor: 0, emptyPoor: 0 },
		gauge: { type: 'normal', valueMilli: 50_000 },
		playStatus: 'playing'
	};
}

function finalResult(perfect: number): ArenaFinalResult {
	return {
		exScore: perfect * 2,
		maxCombo: perfect,
		badPoorCount: 0,
		judgements: { perfect, great: 0, good: 0, bad: 0, poor: 0, emptyPoor: 0 },
		clearType: 'normal',
		finalGauge: { type: 'normal', valueMilli: 60_000 }
	};
}

async function preparePlaying(directory: RoomDirectory, identities = [alice, bob]) {
	const created = await directory.create({
		connectionId: 'c1',
		identity: identities[0]!,
		name: 'Room'
	});
	if (!created.ok) throw new Error('create failed');
	const seats: SeatAdmission[] = [created.value];
	for (let index = 1; index < identities.length; ++index) {
		const joined = await directory.join({
			roomId: created.value.binding.roomId,
			connectionId: `c${index + 1}`,
			identity: identities[index]!
		});
		if (!joined.ok) throw new Error('join failed');
		seats.push(joined.value);
	}
	for (const [index, seat] of seats.entries()) {
		directory.markInventorySyncing(seat.binding, 1, NOW);
		const committed = directory.replaceInventory(
			seat.binding,
			{ libraryGeneration: 1 },
			packed(index === 0 ? [1, 2, 3] : [2, 3, 4]),
			NOW
		);
		if (!committed.ok) throw new Error('inventory failed');
	}
	const availability = directory.requestAvailabilityReset(seats[0]!.binding, NOW);
	if (!availability.ok) throw new Error('availability failed');
	for (const seat of seats)
		directory.ackAvailability(seat.binding, availability.value.revision, NOW);
	const selected = directory.select(
		seats[0]!.binding,
		selection(),
		{ availabilityRevision: availability.value.revision, inventoryRevision: 1 },
		NOW
	);
	if (!selected.ok) throw new Error('selection failed');
	let frozen: ReturnType<RoomDirectory['setReady']> | undefined;
	for (const [index, seat] of seats.entries()) {
		frozen = directory.setReady(
			seat.binding,
			true,
			{
				selectionRevision: selected.value.selectionRevision,
				availabilityRevision: availability.value.revision,
				inventoryRevision: index + 1
			},
			NOW
		);
	}
	if (frozen === undefined || !frozen.ok || frozen.value.round === undefined) {
		throw new Error('freeze failed');
	}
	const round = frozen.value.round;
	const probes = effectOf(frozen.effects, 'round_probe_requested');
	for (const [index, seat] of seats.entries()) {
		const probe = probes[index]!;
		directory.reportProbe(
			seat.binding,
			{
				roundId: round.roundId,
				launchAttemptId: round.launchAttemptId,
				selectionRevision: round.selectionRevision,
				availabilityRevision: round.availabilityRevision,
				inventoryRevision: index + 1,
				nonce: probe.nonce,
				ok: true,
				sha256: round.selection.sha256
			},
			NOW + 10
		);
	}
	let loaded: ReturnType<RoomDirectory['reportLoaded']> | undefined;
	for (const [index, seat] of seats.entries()) {
		loaded = directory.reportLoaded(
			seat.binding,
			{
				roundId: round.roundId,
				launchAttemptId: round.launchAttemptId,
				selectionRevision: round.selectionRevision,
				availabilityRevision: round.availabilityRevision,
				inventoryRevision: index + 1,
				ok: true,
				chartLengthMs: 120_000
			},
			NOW + 20
		);
	}
	if (loaded === undefined || !loaded.ok) throw new Error('load failed');
	const scheduled = effectOf(loaded.effects, 'round_start_scheduled')[0]!;
	directory.sweep(scheduled.startAtServerMs);
	return {
		seats,
		round: round as CompetitionFrozenRound,
		startAtMs: scheduled.startAtServerMs,
		deadlineMs: scheduled.playDeadlineAtServerMs
	};
}

describe('Arena Playing domain', () => {
	test('saturates room-lifetime wins at uint32 max', () => {
		expect(saturatingIncrementUint32(0)).toBe(1);
		expect(saturatingIncrementUint32(0xffff_ffff)).toBe(0xffff_ffff);
	});

	test('coalesces authoritative standings while preserving zero and no-data rows', async () => {
		const directory = createDirectory();
		const playing = await preparePlaying(directory);
		const initial = directory.flushDueStandings(playing.startAtMs);
		expect(initial).toHaveLength(1);
		const initialSnapshot = effectOf(initial[0]!.effects, 'round_standings')[0]!.snapshot;
		expect(initialSnapshot.standingsRevision).toBe(1);
		expect(initialSnapshot.entries.every((entry) => entry.rank === null)).toBe(true);

		const accepted = directory.reportTelemetry(
			playing.seats[0]!.binding,
			{
				roundId: playing.round.roundId,
				launchAttemptId: playing.round.launchAttemptId,
				telemetry: telemetry(1, 0)
			},
			playing.startAtMs + 1
		);
		expect(accepted).toEqual(
			expect.objectContaining({
				ok: true,
				value: expect.objectContaining({ status: 'accepted', standingsRevision: 2 })
			})
		);
		expect(directory.flushDueStandings(playing.startAtMs + 199)).toHaveLength(0);
		const flushed = directory.flushDueStandings(playing.startAtMs + 200);
		expect(flushed).toHaveLength(1);
		const snapshot = effectOf(flushed[0]!.effects, 'round_standings')[0]!.snapshot;
		expect(snapshot.entries[0]).toEqual(
			expect.objectContaining({ memberId: playing.seats[0]!.binding.seatId, rank: 1 })
		);
		expect(snapshot.entries[1]).toEqual(
			expect.objectContaining({ memberId: playing.seats[1]!.binding.seatId, rank: null })
		);
	});

	test('accepts one immutable terminal per participant and finalizes tied winners atomically', async () => {
		const directory = createDirectory();
		const playing = await preparePlaying(directory);
		const input = {
			roundId: playing.round.roundId,
			launchAttemptId: playing.round.launchAttemptId,
			result: finalResult(100)
		};
		const first = directory.submitRoundResult(
			playing.seats[0]!.binding,
			input,
			playing.startAtMs + 1
		);
		expect(first).toEqual(
			expect.objectContaining({ ok: true, value: expect.objectContaining({ status: 'accepted' }) })
		);
		const retry = directory.submitRoundResult(
			playing.seats[0]!.binding,
			input,
			playing.startAtMs + 2
		);
		expect(retry).toEqual(
			expect.objectContaining({
				ok: true,
				value: expect.objectContaining({ status: 'identical_retry' })
			})
		);
		const conflict = directory.abandonRound(
			playing.seats[0]!.binding,
			{ ...input, reason: 'aborted' },
			playing.startAtMs + 3
		);
		expect(conflict).toEqual({ ok: false, rejection: { code: 'round_already_terminal' } });

		const second = directory.submitRoundResult(
			playing.seats[1]!.binding,
			input,
			playing.startAtMs + 4
		);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.value.finalized?.winnerMemberIds).toEqual([
			playing.seats[0]!.binding.seatId,
			playing.seats[1]!.binding.seatId
		]);
		expect(second.value.finalized?.entries.map((entry) => entry.lobbyWinsAfter)).toEqual([1, 1]);
		const finalized = effectOf(second.effects, 'round_finalized')[0]!;
		const cleared = effectOf(second.effects, 'selection_changed');
		expect(cleared).toHaveLength(1);
		expect(cleared[0]).toEqual(
			expect.objectContaining({
				selection: null,
				selectionRevision: playing.round.selectionRevision + 1
			})
		);
		expect(
			finalized.members.map((member) => [member.lobbyWins, member.ready, member.roundState])
		).toEqual([
			[1, false, 'eligible'],
			[1, false, 'eligible']
		]);
		expect(directory.flushDueStandings(playing.startAtMs + 10_000)).toHaveLength(0);
	});

	test('rejects regressing finals and makes the exact play deadline win', async () => {
		const directory = createDirectory();
		const playing = await preparePlaying(directory);
		directory.reportTelemetry(
			playing.seats[0]!.binding,
			{
				roundId: playing.round.roundId,
				launchAttemptId: playing.round.launchAttemptId,
				telemetry: telemetry(1, 10)
			},
			playing.startAtMs + 1
		);
		const invalid = directory.submitRoundResult(
			playing.seats[0]!.binding,
			{
				roundId: playing.round.roundId,
				launchAttemptId: playing.round.launchAttemptId,
				result: finalResult(9)
			},
			playing.startAtMs + 2
		);
		expect(invalid).toEqual({ ok: false, rejection: { code: 'result_invalid' } });

		const tooLate = directory.submitRoundResult(
			playing.seats[0]!.binding,
			{
				roundId: playing.round.roundId,
				launchAttemptId: playing.round.launchAttemptId,
				result: finalResult(10)
			},
			playing.deadlineMs
		);
		expect(tooLate.ok).toBe(false);
		if (tooLate.ok) return;
		expect(tooLate.rejection.code).toBe('round_already_terminal');
		expect(effectOf(tooLate.effects ?? [], 'round_finalized')[0]!.result.entries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ competitionState: 'dnf', dnfReason: 'play_deadline' })
			])
		);
		expect(directory.sweep(playing.deadlineMs)).toHaveLength(0);
	});

	test('preserves limiter and frozen identity through disconnect and resume', async () => {
		const directory = createDirectory();
		const playing = await preparePlaying(directory);
		directory.flushDueStandings(playing.startAtMs);
		for (let sequence = 1; sequence <= 10; ++sequence) {
			const accepted = directory.reportTelemetry(
				playing.seats[0]!.binding,
				{
					roundId: playing.round.roundId,
					launchAttemptId: playing.round.launchAttemptId,
					telemetry: telemetry(sequence, sequence)
				},
				playing.startAtMs + 1
			);
			expect(accepted.ok && accepted.value.status).toBe('accepted');
		}
		const dropped = directory.reportTelemetry(
			playing.seats[0]!.binding,
			{
				roundId: playing.round.roundId,
				launchAttemptId: playing.round.launchAttemptId,
				telemetry: telemetry(11, 11)
			},
			playing.startAtMs + 1
		);
		expect(dropped.ok && dropped.value.status).toBe('dropped');

		directory.disconnect(playing.seats[0]!.binding, playing.startAtMs + 2);
		const resumed = directory.resume({
			roomId: playing.seats[0]!.binding.roomId,
			connectionId: 'c1-resumed',
			identity: { ...alice, displayName: 'Changed ticket name' },
			resumeToken: playing.seats[0]!.resumeToken,
			nowMs: playing.startAtMs + 3
		});
		expect(resumed.ok).toBe(true);
		if (!resumed.ok) return;
		expect(resumed.value.snapshot.liveStandings?.entries[0]).toEqual(
			expect.objectContaining({ connectionStatus: 'connected' })
		);
		const stillLimited = directory.reportTelemetry(
			resumed.value.binding,
			{
				roundId: playing.round.roundId,
				launchAttemptId: playing.round.launchAttemptId,
				telemetry: telemetry(11, 11)
			},
			playing.startAtMs + 3
		);
		expect(stillLimited.ok && stillLimited.value.status).toBe('dropped');

		directory.submitRoundResult(
			resumed.value.binding,
			{
				roundId: playing.round.roundId,
				launchAttemptId: playing.round.launchAttemptId,
				result: finalResult(10)
			},
			playing.startAtMs + 210
		);
		const finalized = directory.abandonRound(
			playing.seats[1]!.binding,
			{
				roundId: playing.round.roundId,
				launchAttemptId: playing.round.launchAttemptId,
				reason: 'aborted'
			},
			playing.startAtMs + 211
		);
		expect(finalized.ok).toBe(true);
		if (!finalized.ok) return;
		expect(finalized.value.finalized?.entries[0]?.identity.displayName).toBe('Alice');
	});

	test('retains a departed finished winner with null wins and resets waiting seats', async () => {
		const directory = createDirectory();
		const playing = await preparePlaying(directory);
		const waiting = await directory.join({
			roomId: playing.seats[0]!.binding.roomId,
			connectionId: 'c3',
			identity: { userId: 'carol', displayName: 'Carol', avatarUrl: null }
		});
		if (!waiting.ok) throw new Error('waiting join failed');
		directory.submitRoundResult(
			playing.seats[0]!.binding,
			{
				roundId: playing.round.roundId,
				launchAttemptId: playing.round.launchAttemptId,
				result: finalResult(100)
			},
			playing.startAtMs + 1
		);
		const left = directory.leave(playing.seats[0]!.binding, playing.startAtMs + 2);
		expect(left.ok).toBe(true);
		const final = directory.abandonRound(
			playing.seats[1]!.binding,
			{
				roundId: playing.round.roundId,
				launchAttemptId: playing.round.launchAttemptId,
				reason: 'result_unavailable'
			},
			playing.startAtMs + 3
		);
		expect(final.ok).toBe(true);
		if (!final.ok) return;
		const result = final.value.finalized!;
		expect(result.winnerMemberIds).toEqual([playing.seats[0]!.binding.seatId]);
		expect(result.entries[0]?.lobbyWinsAfter).toBeNull();
		const event = effectOf(final.effects, 'round_finalized')[0]!;
		expect(event.members.map((member) => [member.identity.displayName, member.roundState])).toEqual(
			[
				['Bob', 'eligible'],
				['Carol', 'eligible']
			]
		);
		expect(effectOf(final.effects, 'selection_changed')).toHaveLength(1);
	});

	test('uses a bounded terminal-attempt window and grace-expiry DNF', async () => {
		const directory = createDirectory();
		const playing = await preparePlaying(directory);
		directory.reportTelemetry(
			playing.seats[0]!.binding,
			{
				roundId: playing.round.roundId,
				launchAttemptId: playing.round.launchAttemptId,
				telemetry: telemetry(1, 10)
			},
			playing.startAtMs + 1
		);
		for (let attempt = 0; attempt < 8; ++attempt) {
			expect(
				directory.submitRoundResult(
					playing.seats[0]!.binding,
					{
						roundId: playing.round.roundId,
						launchAttemptId: playing.round.launchAttemptId,
						result: finalResult(9)
					},
					playing.startAtMs + 2
				)
			).toEqual({ ok: false, rejection: { code: 'result_invalid' } });
		}
		expect(
			directory.submitRoundResult(
				playing.seats[0]!.binding,
				{
					roundId: playing.round.roundId,
					launchAttemptId: playing.round.launchAttemptId,
					result: finalResult(10)
				},
				playing.startAtMs + 3
			)
		).toEqual({ ok: false, rejection: { code: 'rate_limited' } });

		directory.disconnect(playing.seats[1]!.binding, playing.startAtMs + 4);
		directory.submitRoundResult(
			playing.seats[0]!.binding,
			{
				roundId: playing.round.roundId,
				launchAttemptId: playing.round.launchAttemptId,
				result: finalResult(10)
			},
			playing.startAtMs + 60_002
		);
		const expired = directory.sweep(playing.startAtMs + 60_004);
		expect(expired).toHaveLength(1);
		const result = effectOf(expired[0]!.effects, 'round_finalized')[0]!.result;
		expect(result.entries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ competitionState: 'dnf', dnfReason: 'grace_expired' })
			])
		);
	});
});
