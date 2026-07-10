import { describe, expect, test } from 'bun:test';

import type { ArenaIdentity } from '../../src/auth/identity.ts';
import { PackedInventory } from '../../src/inventory/packed-inventory.ts';
import type { FrozenRound, SelectionSnapshot } from '../../src/protocol/messages.ts';
import {
	createRoomDirectoryWithEntropy,
	type RoomDirectory
} from '../../src/rooms/room-directory.ts';
import type { RoomEffect, SeatAdmission } from '../../src/rooms/models.ts';
import { connectionStartAfterMs, currentRttMs, startLeadMs } from '../../src/rooms/round-state.ts';
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

function selection(value = 2): SelectionSnapshot {
	return {
		sha256: sha(value),
		title: `Chart ${value}`,
		subtitle: '',
		artist: 'Artist',
		keyMode: 7,
		randomSequence: [1, 2],
		noteOrderP1: 'random',
		noteOrderP2: 'mirror',
		dpMode: 'off',
		laneSeed: '0123456789abcdef',
		randomizationVersion: 1
	};
}

function createDirectory(): RoomDirectory {
	let entropy = 1;
	return createRoomDirectoryWithEntropy(
		{ roomCapacity: 16, reconnectGraceMs: 60_000, chatBacklog: 200 },
		new FakePasswordHasher(),
		(length) => new Uint8Array(length).fill(entropy++)
	);
}

function effectOf<T extends RoomEffect['type']>(effects: readonly RoomEffect[], type: T) {
	return effects.filter(
		(effect): effect is Extract<RoomEffect, { type: T }> => effect.type === type
	);
}

async function prepareRound(directory: RoomDirectory, includeBob = true) {
	const created = await directory.create({ connectionId: 'c1', identity: alice, name: 'Room' });
	if (!created.ok) throw new Error('create failed');
	const seats: SeatAdmission[] = [created.value];
	if (includeBob) {
		const joined = await directory.join({
			roomId: created.value.binding.roomId,
			connectionId: 'c2',
			identity: bob
		});
		if (!joined.ok) throw new Error('join failed');
		seats.push(joined.value);
	}
	for (const [index, seat] of seats.entries()) {
		if (!directory.markInventorySyncing(seat.binding, 1, NOW).ok) throw new Error('sync failed');
		if (
			!directory.replaceInventory(
				seat.binding,
				{ libraryGeneration: 1 },
				packed(index === 0 ? [1, 2, 3] : [2, 3, 4]),
				NOW
			).ok
		) {
			throw new Error('commit failed');
		}
	}
	const availability = directory.requestAvailabilityReset(seats[0]!.binding, NOW);
	if (!availability.ok) throw new Error('availability failed');
	for (const seat of seats) {
		if (!directory.ackAvailability(seat.binding, availability.value.revision, NOW).ok) {
			throw new Error('ack failed');
		}
	}
	const selected = directory.select(
		seats[0]!.binding,
		selection(),
		{ availabilityRevision: availability.value.revision, inventoryRevision: 1 },
		NOW
	);
	if (!selected.ok) throw new Error('selection failed');
	for (let index = 0; index < seats.length - 1; ++index) {
		const ready = directory.setReady(
			seats[index]!.binding,
			true,
			{
				selectionRevision: selected.value.selectionRevision,
				availabilityRevision: availability.value.revision,
				inventoryRevision: index + 1
			},
			NOW
		);
		if (!ready.ok) throw new Error('ready failed');
	}
	const frozen = directory.setReady(
		seats.at(-1)!.binding,
		true,
		{
			selectionRevision: selected.value.selectionRevision,
			availabilityRevision: availability.value.revision,
			inventoryRevision: seats.length
		},
		NOW
	);
	if (!frozen.ok || frozen.value.round === undefined) throw new Error('freeze failed');
	return {
		seats,
		round: frozen.value.round,
		effects: frozen.effects,
		selectionRevision: selected.value.selectionRevision,
		availabilityRevision: availability.value.revision
	};
}

function probeInput(
	round: FrozenRound,
	effect: Extract<RoomEffect, { type: 'round_probe_requested' }>,
	ok: true | false = true
) {
	const common = {
		roundId: round.roundId,
		launchAttemptId: round.launchAttemptId,
		selectionRevision: round.selectionRevision,
		availabilityRevision: round.availabilityRevision,
		inventoryRevision: effect.inventoryRevision,
		nonce: effect.nonce
	};
	return ok
		? ({ ...common, ok: true as const, sha256: round.selection.sha256 } as const)
		: ({ ...common, ok: false as const, reason: 'hash_mismatch' as const } as const);
}

function loadInput(round: FrozenRound, inventoryRevision: number, ok: true | false = true) {
	const common = {
		roundId: round.roundId,
		launchAttemptId: round.launchAttemptId,
		selectionRevision: round.selectionRevision,
		availabilityRevision: round.availabilityRevision,
		inventoryRevision
	};
	return ok
		? ({ ...common, ok: true as const } as const)
		: ({ ...common, ok: false as const, reason: 'resource_failed' as const } as const);
}

describe('Arena probe and loading barrier', () => {
	test('rejects stale frozen basis and nonce fields without consuming the valid reply', async () => {
		const directory = createDirectory();
		const prepared = await prepareRound(directory, false);
		const probe = effectOf(prepared.effects, 'round_probe_requested')[0]!;
		expect(
			directory.reportProbe(
				prepared.seats[0]!.binding,
				{ ...probeInput(prepared.round, probe), roundId: 'stale-round' },
				NOW + 1
			)
		).toEqual({ ok: false, rejection: { code: 'round_stale' } });
		expect(
			directory.reportProbe(
				prepared.seats[0]!.binding,
				{ ...probeInput(prepared.round, probe), nonce: 'stale-nonce' },
				NOW + 2
			)
		).toEqual({ ok: false, rejection: { code: 'launch_stage_stale' } });
		expect(
			directory.reportProbe(prepared.seats[0]!.binding, probeInput(prepared.round, probe), NOW + 3)
				.ok
		).toBe(true);
	});

	test('targets unique probe nonces and advances only after every idempotent success', async () => {
		const directory = createDirectory();
		const prepared = await prepareRound(directory);
		const probes = effectOf(prepared.effects, 'round_probe_requested');
		expect(probes).toHaveLength(2);
		expect(new Set(probes.map((effect) => effect.nonce)).size).toBe(2);
		expect(probes.map((effect) => effect.deadlineMs)).toEqual([NOW + 15_000, NOW + 15_000]);

		const first = directory.reportProbe(
			prepared.seats[0]!.binding,
			probeInput(prepared.round, probes[0]!),
			NOW + 1
		);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(effectOf(first.effects, 'round_load_requested')).toHaveLength(0);
		expect(
			directory.reportProbe(
				prepared.seats[0]!.binding,
				probeInput(prepared.round, probes[0]!),
				NOW + 2
			)
		).toEqual({ ok: true, value: undefined, effects: [] });
		const acceptedProbe = probeInput(prepared.round, probes[0]!);
		if (!acceptedProbe.ok) throw new Error('expected successful probe input');
		const conflicting = directory.reportProbe(
			prepared.seats[0]!.binding,
			{ ...acceptedProbe, sha256: sha(3) },
			NOW + 3
		);
		expect(conflicting).toEqual({ ok: false, rejection: { code: 'launch_stage_stale' } });

		const second = directory.reportProbe(
			prepared.seats[1]!.binding,
			probeInput(prepared.round, probes[1]!),
			NOW + 4
		);
		expect(second.ok).toBe(true);
		if (second.ok) {
			const loads = effectOf(second.effects, 'round_load_requested');
			expect(loads).toHaveLength(2);
			expect(loads.every((effect) => effect.round.stage === 'loading')).toBe(true);
		}
	});

	test('cancels at the exact probe boundary and clears a bad chart but retains a timeout chart', async () => {
		const badDirectory = createDirectory();
		const bad = await prepareRound(badDirectory, false);
		const badProbe = effectOf(bad.effects, 'round_probe_requested')[0]!;
		const failed = badDirectory.reportProbe(
			bad.seats[0]!.binding,
			probeInput(bad.round, badProbe, false),
			NOW + 1
		);
		expect(failed.ok).toBe(true);
		if (failed.ok) {
			expect(effectOf(failed.effects, 'round_launch_cancelled')[0]).toEqual(
				expect.objectContaining({ reason: 'hash_mismatch', selection: null })
			);
		}

		const timeoutDirectory = createDirectory();
		const timeout = await prepareRound(timeoutDirectory, false);
		expect(timeoutDirectory.nextDeadlineMs()).toBe(NOW + 15_000);
		const transitions = timeoutDirectory.sweep(NOW + 15_000);
		expect(transitions).toHaveLength(1);
		expect(effectOf(transitions[0]!.effects, 'round_launch_cancelled')[0]).toEqual(
			expect.objectContaining({ reason: 'probe_timeout', selection: selection() })
		);
	});

	test('uses a 60-second deterministic load barrier and schedules from recent minimum RTT', async () => {
		const directory = createDirectory();
		const prepared = await prepareRound(directory);
		const probes = effectOf(prepared.effects, 'round_probe_requested');
		for (const [index, seat] of prepared.seats.entries()) {
			const result = directory.reportProbe(
				seat.binding,
				probeInput(prepared.round, probes[index]!),
				NOW + 10
			);
			if (!result.ok) throw new Error('probe failed');
		}
		expect(directory.nextDeadlineMs()).toBe(NOW + 60_010);

		directory.recordRtt(prepared.seats[0]!.binding, 120, NOW + 11);
		directory.recordRtt(prepared.seats[0]!.binding, 80, NOW + 12);
		directory.recordRtt(prepared.seats[1]!.binding, 300, NOW + 12);
		const first = directory.reportLoaded(
			prepared.seats[0]!.binding,
			loadInput(prepared.round, 1),
			NOW + 20
		);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(effectOf(first.effects, 'round_start_scheduled')).toHaveLength(0);
		const second = directory.reportLoaded(
			prepared.seats[1]!.binding,
			loadInput(prepared.round, 2),
			NOW + 20
		);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		const schedules = effectOf(second.effects, 'round_start_scheduled');
		expect(schedules).toHaveLength(2);
		expect(schedules.map((effect) => effect.startAtServerMs)).toEqual([NOW + 2_320, NOW + 2_320]);
		expect(schedules.map((effect) => effect.startAfterMs)).toEqual([2_260, 2_150]);
		expect(directory.nextDeadlineMs()).toBe(NOW + 2_320);

		const started = directory.sweep(NOW + 2_320);
		expect(started).toHaveLength(1);
		expect(effectOf(started[0]!.effects, 'round_started')).toHaveLength(1);
		expect(started[0]!.directoryChange.upserts[0]?.phase).toBe('playing');
		expect(directory.nextDeadlineMs()).toBeUndefined();
	});

	test('cancels load failure and the exact load timeout', async () => {
		const failureDirectory = createDirectory();
		const failure = await prepareRound(failureDirectory, false);
		const probe = effectOf(failure.effects, 'round_probe_requested')[0]!;
		failureDirectory.reportProbe(
			failure.seats[0]!.binding,
			probeInput(failure.round, probe),
			NOW + 10
		);
		const loadFailure = failureDirectory.reportLoaded(
			failure.seats[0]!.binding,
			loadInput(failure.round, 1, false),
			NOW + 20
		);
		expect(loadFailure.ok).toBe(true);
		if (loadFailure.ok) {
			expect(effectOf(loadFailure.effects, 'round_launch_cancelled')[0]).toEqual(
				expect.objectContaining({ reason: 'resource_failed', selection: null })
			);
		}

		const timeoutDirectory = createDirectory();
		const timeout = await prepareRound(timeoutDirectory, false);
		const timeoutProbe = effectOf(timeout.effects, 'round_probe_requested')[0]!;
		timeoutDirectory.reportProbe(
			timeout.seats[0]!.binding,
			probeInput(timeout.round, timeoutProbe),
			NOW + 10
		);
		const transitions = timeoutDirectory.sweep(NOW + 60_010);
		expect(effectOf(transitions[0]!.effects, 'round_launch_cancelled')[0]).toEqual(
			expect.objectContaining({ reason: 'load_timeout', selection: selection() })
		);
	});

	test('a frozen participant leave cancels while a waiting member leave does not', async () => {
		const directory = createDirectory();
		const prepared = await prepareRound(directory, false);
		const joined = await directory.join({
			roomId: prepared.seats[0]!.binding.roomId,
			connectionId: 'c2',
			identity: bob
		});
		if (!joined.ok) throw new Error('waiting join failed');
		const waitingLeft = directory.leave(joined.value.binding, NOW + 1);
		expect(waitingLeft.ok).toBe(true);
		if (waitingLeft.ok) {
			expect(effectOf(waitingLeft.effects, 'round_launch_cancelled')).toHaveLength(0);
		}
		const participantLeft = directory.leave(prepared.seats[0]!.binding, NOW + 2);
		expect(participantLeft.ok).toBe(true);
		if (participantLeft.ok) {
			expect(effectOf(participantLeft.effects, 'round_launch_cancelled')).toHaveLength(1);
		}
	});

	test('resends the current stage on resume and cancels an explicit leave during the lead', async () => {
		const probeDirectory = createDirectory();
		const probing = await prepareRound(probeDirectory, false);
		const originalProbe = effectOf(probing.effects, 'round_probe_requested')[0]!;
		probeDirectory.disconnect(probing.seats[0]!.binding, NOW + 1);
		const resumed = probeDirectory.resume({
			roomId: probing.seats[0]!.binding.roomId,
			connectionId: 'c1-resumed',
			identity: alice,
			resumeToken: probing.seats[0]!.resumeToken,
			nowMs: NOW + 2
		});
		expect(resumed.ok).toBe(true);
		if (!resumed.ok) return;
		const resentProbe = effectOf(resumed.effects, 'round_probe_requested')[0];
		expect(resentProbe).toEqual(
			expect.objectContaining({
				targets: ['c1-resumed'],
				nonce: originalProbe.nonce,
				connectionGeneration: 2
			})
		);

		const leadDirectory = createDirectory();
		const lead = await prepareRound(leadDirectory, false);
		const leadProbe = effectOf(lead.effects, 'round_probe_requested')[0]!;
		leadDirectory.reportProbe(lead.seats[0]!.binding, probeInput(lead.round, leadProbe), NOW + 10);
		const loaded = leadDirectory.reportLoaded(
			lead.seats[0]!.binding,
			loadInput(lead.round, 1),
			NOW + 20
		);
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		expect(effectOf(loaded.effects, 'round_start_scheduled')).toHaveLength(1);
		const left = leadDirectory.leave(lead.seats[0]!.binding, NOW + 21);
		expect(left.ok).toBe(true);
		if (left.ok) {
			expect(effectOf(left.effects, 'round_launch_cancelled')[0]).toEqual(
				expect.objectContaining({ reason: 'participant_left' })
			);
		}
	});

	test('keeps the minimum of the latest eight fresh RTT samples and clamps scheduling bounds', () => {
		const samples = [
			{ sampledAtMs: NOW - 60_000, rttMs: 1 },
			{ sampledAtMs: NOW - 10, rttMs: 2 },
			{ sampledAtMs: NOW - 9, rttMs: 900 },
			{ sampledAtMs: NOW - 8, rttMs: 800 },
			{ sampledAtMs: NOW - 7, rttMs: 700 },
			{ sampledAtMs: NOW - 6, rttMs: 600 },
			{ sampledAtMs: NOW - 5, rttMs: 500 },
			{ sampledAtMs: NOW - 4, rttMs: 400 },
			{ sampledAtMs: NOW - 3, rttMs: 300 },
			{ sampledAtMs: NOW - 2, rttMs: 200 }
		];
		expect(currentRttMs(samples, NOW)).toBe(200);
		expect(startLeadMs([undefined])).toBe(2_000);
		expect(startLeadMs([4_000])).toBe(5_000);
		expect(connectionStartAfterMs(NOW + 2_000, NOW + 1_900, 1_000)).toBe(250);
	});

	test('cancels every active launch on server shutdown', async () => {
		const directory = createDirectory();
		await prepareRound(directory, false);
		const transitions = directory.cancelLaunches('server_shutdown');
		expect(transitions).toHaveLength(1);
		expect(effectOf(transitions[0]!.effects, 'round_launch_cancelled')[0]).toEqual(
			expect.objectContaining({ reason: 'server_shutdown' })
		);
		expect(directory.nextDeadlineMs()).toBeUndefined();
	});
});
