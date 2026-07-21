import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import { ArenaApplication } from '../../src/application/arena-application.ts';
import type { Delivery } from '../../src/application/delivery.ts';
import type { ArenaIdentity, VerifiedArenaTicket } from '../../src/auth/identity.ts';
import type { TicketVerifier } from '../../src/auth/ticket-verifier.ts';
import { encodeHashChunk } from '../../src/protocol/binary.ts';
import type { ClientMessage, RoomSnapshot, ServerMessage } from '../../src/protocol/messages.ts';
import { createRoomDirectoryWithEntropy } from '../../src/rooms/room-directory.ts';
import { FakePasswordHasher } from '../helpers/fake-password-hasher.ts';

const NOW = 2_000_000;

class RoundTicketVerifier implements TicketVerifier {
	async verify(ticket: string, now: Date): Promise<VerifiedArenaTicket> {
		const name = ticket.split('-')[0] ?? ticket;
		const identity: ArenaIdentity = {
			userId: name,
			displayName: name[0]!.toUpperCase() + name.slice(1),
			avatarUrl: null
		};
		return {
			identity,
			emailVerified: true,
			jti: `${ticket}-jti`,
			issuedAt: new Date(now.getTime() - 1_000),
			expiresAt: new Date(now.getTime() + 90_000),
			protocolMajor: 1,
			protocolMinor: 0
		};
	}
}

function createApplication(): ArenaApplication {
	let entropy = 1;
	let heartbeatNonce = 1;
	return new ArenaApplication({
		ticketVerifier: new RoundTicketVerifier(),
		roomDirectory: createRoomDirectoryWithEntropy(
			{ roomCapacity: 32, reconnectGraceMs: 60_000, chatBacklog: 200 },
			new FakePasswordHasher(),
			(length) => new Uint8Array(length).fill(entropy++)
		),
		now: () => NOW,
		newNonce: () => `heartbeat-${heartbeatNonce++}`
	});
}

async function authenticate(application: ArenaApplication, connectionId: string): Promise<void> {
	application.connect(connectionId);
	await application.receive(
		connectionId,
		{
			type: 'client_hello',
			data: {
				protocolMajor: 1,
				protocolMinor: 0,
				clientVersion: 'round-test',
				capabilities: ['rooms-v1', 'rounds-v1', 'competition-v1'],
				ticket: `${connectionId}-ticket`
			}
		},
		NOW
	);
}

function messagesFor(deliveries: readonly Delivery[], connectionId: string): ServerMessage[] {
	return deliveries.flatMap((delivery) =>
		(delivery.kind === 'send' || delivery.kind === 'send_ephemeral') &&
		delivery.connectionIds.includes(connectionId)
			? [delivery.message]
			: []
	);
}

function snapshotFrom(deliveries: readonly Delivery[]): RoomSnapshot {
	const message = deliveries.find(
		(delivery) => delivery.kind === 'send' && delivery.message.type === 'room_snapshot'
	);
	if (message?.kind !== 'send' || message.message.type !== 'room_snapshot') {
		throw new Error('room snapshot missing');
	}
	if (!('selection' in message.message.data)) throw new Error('Phase 2 snapshot missing');
	return message.message.data;
}

function inventoryBytes(values: readonly number[]): Uint8Array {
	const bytes = new Uint8Array(values.length * 32);
	for (let index = 0; index < values.length; ++index) {
		new DataView(bytes.buffer, index * 32, 32).setUint32(28, values[index]!, false);
	}
	return bytes;
}

async function upload(
	application: ArenaApplication,
	connectionId: string,
	room: RoomSnapshot,
	values: readonly number[],
	inventoryIndex: number
): Promise<readonly Delivery[]> {
	const bytes = inventoryBytes(values);
	const declaration = {
		libraryGeneration: 1,
		hashCount: bytes.byteLength / 32,
		byteCount: bytes.byteLength,
		chunkCount: 1,
		vectorDigest: createHash('sha256').update(bytes).digest('hex')
	};
	const binding = {
		roomId: room.roomId,
		roomGeneration: room.roomGeneration,
		connectionGeneration: room.self.connectionGeneration
	};
	const begun = await application.receive(
		connectionId,
		{
			type: 'inventory_upload_begin',
			requestId: `begin-${inventoryIndex}`,
			data: { ...binding, ...declaration }
		},
		NOW + inventoryIndex
	);
	const ready = messagesFor(begun, connectionId).find(
		(message) => message.type === 'inventory_upload_ready'
	);
	if (ready?.type !== 'inventory_upload_ready') throw new Error('upload not ready');
	await application.receiveBinary(
		connectionId,
		encodeHashChunk({
			kind: 1,
			transferId: Uint8Array.from(Buffer.from(ready.data.uploadId, 'base64url')),
			chunkIndex: 0,
			hashes: bytes
		}),
		NOW + inventoryIndex
	);
	return application.receive(
		connectionId,
		{
			type: 'inventory_upload_commit',
			requestId: `commit-${inventoryIndex}`,
			data: { ...binding, uploadId: ready.data.uploadId, ...declaration }
		},
		NOW + inventoryIndex
	);
}

function selection() {
	return {
		sha256: '2'.padStart(64, '0'),
		title: 'Common chart',
		subtitle: '',
		artist: 'Artist',
		keyMode: 7 as const,
		randomSequence: [1, 2],
		noteOrderP1: 's_random' as const,
		noteOrderP2: 'normal_or_mirror' as const,
		dpMode: 'off' as const,
		laneSeed: '0123456789abcdef',
		randomizationVersion: 1 as const
	};
}

describe('Arena round application integration', () => {
	test('drives two participants and one waiting join through the exact scheduled start', async () => {
		const application = createApplication();
		await authenticate(application, 'alice');
		await authenticate(application, 'bob');
		const created = await application.receive(
			'alice',
			{ type: 'room_create', requestId: 'create', data: { name: 'Round' } },
			NOW
		);
		const aliceRoom = snapshotFrom(created);
		const joined = await application.receive(
			'bob',
			{ type: 'room_join', requestId: 'join', data: { roomId: aliceRoom.roomId } },
			NOW
		);
		const bobRoom = snapshotFrom(joined);
		await upload(application, 'alice', aliceRoom, [1, 2, 3], 1);
		const commonDelivery = await upload(application, 'bob', bobRoom, [2, 3, 4], 2);
		const availability = messagesFor(commonDelivery, 'alice').find(
			(message) => message.type === 'availability_transfer_begin'
		);
		if (availability?.type !== 'availability_transfer_begin') throw new Error('common missing');
		const availabilityRevision = availability.data.targetRevision;
		for (const [connectionId, room] of [
			['alice', aliceRoom],
			['bob', bobRoom]
		] as const) {
			await application.receive(
				connectionId,
				{
					type: 'availability_applied',
					requestId: `ack-${connectionId}`,
					data: {
						roomId: room.roomId,
						roomGeneration: room.roomGeneration,
						connectionGeneration: room.self.connectionGeneration,
						availabilityRevision
					}
				},
				NOW + 3
			);
		}

		const selected = await application.receive(
			'alice',
			{
				type: 'selection_set',
				requestId: 'select',
				data: {
					roomId: aliceRoom.roomId,
					roomGeneration: aliceRoom.roomGeneration,
					connectionGeneration: aliceRoom.self.connectionGeneration,
					availabilityRevision,
					inventoryRevision: 1,
					selection: selection()
				}
			},
			NOW + 4
		);
		const selectionChanged = messagesFor(selected, 'alice').find(
			(message) => message.type === 'selection_changed'
		);
		if (selectionChanged?.type !== 'selection_changed') throw new Error('selection missing');
		const selectionRevision = selectionChanged.data.selectionRevision;
		const ready = async (connectionId: string, room: RoomSnapshot, inventoryRevision: number) =>
			application.receive(
				connectionId,
				{
					type: 'ready_set',
					requestId: `ready-${connectionId}`,
					data: {
						roomId: room.roomId,
						roomGeneration: room.roomGeneration,
						connectionGeneration: room.self.connectionGeneration,
						ready: true,
						selectionRevision,
						availabilityRevision,
						inventoryRevision
					}
				},
				NOW + 5
			);
		await ready('alice', aliceRoom, 1);
		const frozen = await ready('bob', bobRoom, 2);
		const roundStarted = messagesFor(frozen, 'alice').find(
			(message) => message.type === 'round_loading_started'
		);
		if (roundStarted?.type !== 'round_loading_started') throw new Error('round missing');
		const round = roundStarted.data.round;

		await authenticate(application, 'carol');
		const waitingJoin = await application.receive(
			'carol',
			{ type: 'room_join', requestId: 'join-waiting', data: { roomId: aliceRoom.roomId } },
			NOW + 6
		);
		const waitingRoom = snapshotFrom(waitingJoin);
		expect(waitingRoom.phase).toBe('loading');
		expect(waitingRoom.members.at(-1)?.roundState).toBe('waiting');

		const probes = new Map(
			(['alice', 'bob'] as const).map((connectionId) => {
				const probe = messagesFor(frozen, connectionId).find(
					(message) => message.type === 'round_probe_requested'
				);
				if (probe?.type !== 'round_probe_requested') throw new Error('probe missing');
				return [connectionId, probe] as const;
			})
		);
		let loadDeliveries: readonly Delivery[] = [];
		for (const [index, connectionId] of (['alice', 'bob'] as const).entries()) {
			const room = connectionId === 'alice' ? aliceRoom : bobRoom;
			const probe = probes.get(connectionId)!;
			loadDeliveries = await application.receive(
				connectionId,
				{
					type: 'round_probe_result',
					requestId: `probe-${connectionId}`,
					data: {
						roomId: room.roomId,
						roomGeneration: room.roomGeneration,
						connectionGeneration: room.self.connectionGeneration,
						roundId: round.roundId,
						launchAttemptId: round.launchAttemptId,
						selectionRevision,
						availabilityRevision,
						inventoryRevision: index + 1,
						nonce: probe.data.nonce,
						ok: true,
						sha256: selection().sha256
					}
				},
				NOW + 10
			);
		}
		for (const connectionId of ['alice', 'bob']) {
			expect(
				messagesFor(loadDeliveries, connectionId).some(
					(message) => message.type === 'round_load_requested'
				)
			).toBe(true);
		}

		let scheduleDeliveries: readonly Delivery[] = [];
		for (const [index, connectionId] of (['alice', 'bob'] as const).entries()) {
			const room = connectionId === 'alice' ? aliceRoom : bobRoom;
			scheduleDeliveries = await application.receive(
				connectionId,
				{
					type: 'round_load_result',
					requestId: `load-${connectionId}`,
					data: {
						roomId: room.roomId,
						roomGeneration: room.roomGeneration,
						connectionGeneration: room.self.connectionGeneration,
						roundId: round.roundId,
						launchAttemptId: round.launchAttemptId,
						selectionRevision,
						availabilityRevision,
						inventoryRevision: index + 1,
						ok: true,
						chartLengthMs: 120_000
					}
				},
				NOW + 20
			);
		}
		for (const connectionId of ['alice', 'bob']) {
			const schedule = messagesFor(scheduleDeliveries, connectionId).find(
				(message) => message.type === 'round_start_scheduled'
			);
			if (schedule?.type !== 'round_start_scheduled') throw new Error('schedule missing');
			expect(schedule.data.startAtServerMs).toBe(NOW + 2_020);
			expect(schedule.data.startAfterMs).toBe(2_000);
		}
		expect(application.nextDeadlineMs()).toBe(NOW + 2_020);

		const playing = application.sweep(NOW + 2_020);
		for (const connectionId of ['alice', 'bob', 'carol']) {
			expect(
				messagesFor(playing, connectionId).some((message) => message.type === 'round_started')
			).toBe(true);
		}
		for (const connectionId of ['alice', 'bob', 'carol']) {
			expect(
				messagesFor(playing, connectionId).some((message) => message.type === 'round_standings')
			).toBe(true);
		}
		expect(application.nextDeadlineMs()).toBe(NOW + 20_000);

		const ignoredWaitingTelemetry = await application.receive(
			'carol',
			{
				type: 'round_telemetry',
				data: {
					roomId: waitingRoom.roomId,
					roomGeneration: waitingRoom.roomGeneration,
					connectionGeneration: waitingRoom.self.connectionGeneration,
					roundId: round.roundId,
					launchAttemptId: round.launchAttemptId,
					telemetry: {
						sequence: 1,
						exScore: 0,
						progressPermille: 0,
						maxCombo: 0,
						badPoorCount: 0,
						judgements: { perfect: 0, great: 0, good: 0, bad: 0, poor: 0, emptyPoor: 0 },
						gauge: { type: 'normal', valueMilli: 0 },
						playStatus: 'playing'
					}
				}
			},
			NOW + 2_021
		);
		expect(ignoredWaitingTelemetry).toEqual([]);
		const rejectedWaitingTerminal = await application.receive(
			'carol',
			{
				type: 'round_abandon',
				requestId: 'waiting-dnf',
				data: {
					roomId: waitingRoom.roomId,
					roomGeneration: waitingRoom.roomGeneration,
					connectionGeneration: waitingRoom.self.connectionGeneration,
					roundId: round.roundId,
					launchAttemptId: round.launchAttemptId,
					reason: 'aborted'
				}
			},
			NOW + 2_022
		);
		expect(messagesFor(rejectedWaitingTerminal, 'carol')[0]).toEqual(
			expect.objectContaining({
				type: 'command_error',
				requestId: 'waiting-dnf',
				data: expect.objectContaining({ code: 'round_stale' })
			})
		);

		const standings = await application.receive(
			'alice',
			{
				type: 'round_telemetry',
				data: {
					roomId: aliceRoom.roomId,
					roomGeneration: aliceRoom.roomGeneration,
					connectionGeneration: aliceRoom.self.connectionGeneration,
					roundId: round.roundId,
					launchAttemptId: round.launchAttemptId,
					telemetry: {
						sequence: 1,
						exScore: 0,
						progressPermille: 1,
						maxCombo: 0,
						badPoorCount: 0,
						judgements: { perfect: 0, great: 0, good: 0, bad: 0, poor: 0, emptyPoor: 0 },
						gauge: { type: 'normal', valueMilli: 1 },
						playStatus: 'playing'
					}
				}
			},
			NOW + 2_220
		);
		const live = messagesFor(standings, 'carol').find(
			(message) => message.type === 'round_standings'
		);
		expect(standings.some((delivery) => delivery.kind === 'send_ephemeral')).toBe(true);
		if (live?.type !== 'round_standings') throw new Error('standings missing');
		expect(live.data.entries[0]).toEqual(
			expect.objectContaining({ memberId: aliceRoom.self.memberId, rank: 1 })
		);

		const finalResult = {
			exScore: 200,
			maxCombo: 100,
			badPoorCount: 0,
			judgements: { perfect: 100, great: 0, good: 0, bad: 0, poor: 0, emptyPoor: 0 },
			clearType: 'normal' as const,
			finalGauge: { type: 'normal' as const, valueMilli: 60_000 }
		};
		const aliceTerminal = await application.receive(
			'alice',
			{
				type: 'round_result_submit',
				requestId: 'alice-final',
				data: {
					roomId: aliceRoom.roomId,
					roomGeneration: aliceRoom.roomGeneration,
					connectionGeneration: aliceRoom.self.connectionGeneration,
					roundId: round.roundId,
					launchAttemptId: round.launchAttemptId,
					result: finalResult
				}
			},
			NOW + 2_221
		);
		expect(messagesFor(aliceTerminal, 'alice')[0]?.type).toBe('round_terminal_accepted');
		const bobTerminal = await application.receive(
			'bob',
			{
				type: 'round_abandon',
				requestId: 'bob-dnf',
				data: {
					roomId: bobRoom.roomId,
					roomGeneration: bobRoom.roomGeneration,
					connectionGeneration: bobRoom.self.connectionGeneration,
					roundId: round.roundId,
					launchAttemptId: round.launchAttemptId,
					reason: 'result_unavailable'
				}
			},
			NOW + 2_222
		);
		const bobMessages = messagesFor(bobTerminal, 'bob');
		expect(bobMessages[0]?.type).toBe('round_terminal_accepted');
		const finalized = bobMessages.find((message) => message.type === 'round_finalized');
		if (finalized?.type !== 'round_finalized') throw new Error('finalization missing');
		const cleared = bobMessages.find((message) => message.type === 'selection_changed');
		if (cleared?.type !== 'selection_changed') throw new Error('selection clear missing');
		expect(cleared.data.selection).toBeNull();
		expect(cleared.data.selectionRevision).toBe(selectionRevision + 1);
		expect(
			bobTerminal.some(
				(delivery) => delivery.kind === 'send' && delivery.message.type === 'round_finalized'
			)
		).toBe(true);
		expect(finalized.data.result.winnerMemberIds).toEqual([aliceRoom.self.memberId]);
		expect(
			finalized.data.members.find((member) => member.memberId === aliceRoom.self.memberId)
				?.lobbyWins
		).toBe(1);
		expect(finalized.data.members.at(-1)?.roundState).toBe('eligible');

		application.disconnect('bob', NOW + 2_223);
		application.connect('bob-resumed');
		const resumed = await application.receive(
			'bob-resumed',
			{
				type: 'client_hello',
				data: {
					protocolMajor: 1,
					protocolMinor: 0,
					clientVersion: 'round-resume-test',
					capabilities: ['rooms-v1', 'rounds-v1', 'competition-v1'],
					ticket: 'bob-fresh-ticket',
					resume: { roomId: bobRoom.roomId, seatToken: bobRoom.self.resumeToken }
				}
			},
			NOW + 2_224
		);
		const resumedHello = messagesFor(resumed, 'bob-resumed')[0];
		if (resumedHello?.type !== 'server_hello' || resumedHello.data.resume.status !== 'succeeded') {
			throw new Error('result resume failed');
		}
		const resumedRoom = resumedHello.data.resume.room;
		if (!('lastRoundResult' in resumedRoom)) throw new Error('competition snapshot missing');
		expect(resumedRoom.lastRoundResult?.roundId).toBe(round.roundId);
		expect(resumedRoom.selection).toBeNull();
		expect(resumedRoom.selectionRevision).toBe(selectionRevision + 1);
		expect(resumedRoom.liveStandings).toBeNull();
	});

	test('maps a probe mismatch to one authoritative cancellation', async () => {
		const application = createApplication();
		await authenticate(application, 'alice');
		const created = await application.receive(
			'alice',
			{ type: 'room_create', requestId: 'create-failure', data: { name: 'Failure' } },
			NOW
		);
		const room = snapshotFrom(created);
		const committed = await upload(application, 'alice', room, [2], 1);
		const availability = messagesFor(committed, 'alice').find(
			(message) => message.type === 'availability_transfer_begin'
		);
		if (availability?.type !== 'availability_transfer_begin') throw new Error('common missing');
		await application.receive(
			'alice',
			{
				type: 'availability_applied',
				requestId: 'ack',
				data: {
					roomId: room.roomId,
					roomGeneration: room.roomGeneration,
					connectionGeneration: room.self.connectionGeneration,
					availabilityRevision: availability.data.targetRevision
				}
			},
			NOW
		);
		const selected = await application.receive(
			'alice',
			{
				type: 'selection_set',
				requestId: 'select',
				data: {
					roomId: room.roomId,
					roomGeneration: room.roomGeneration,
					connectionGeneration: room.self.connectionGeneration,
					availabilityRevision: availability.data.targetRevision,
					inventoryRevision: 1,
					selection: selection()
				}
			},
			NOW
		);
		const changed = messagesFor(selected, 'alice').find(
			(message) => message.type === 'selection_changed'
		);
		if (changed?.type !== 'selection_changed') throw new Error('selection missing');
		const frozen = await application.receive(
			'alice',
			{
				type: 'ready_set',
				requestId: 'ready',
				data: {
					roomId: room.roomId,
					roomGeneration: room.roomGeneration,
					connectionGeneration: room.self.connectionGeneration,
					ready: true,
					selectionRevision: changed.data.selectionRevision,
					availabilityRevision: availability.data.targetRevision,
					inventoryRevision: 1
				}
			},
			NOW
		);
		const probe = messagesFor(frozen, 'alice').find(
			(message) => message.type === 'round_probe_requested'
		);
		if (probe?.type !== 'round_probe_requested') throw new Error('probe missing');
		const cancelled = await application.receive(
			'alice',
			{
				type: 'round_probe_result',
				requestId: 'probe-failed',
				data: {
					roomId: room.roomId,
					roomGeneration: room.roomGeneration,
					connectionGeneration: room.self.connectionGeneration,
					roundId: probe.data.roundId,
					launchAttemptId: probe.data.launchAttemptId,
					selectionRevision: probe.data.selectionRevision,
					availabilityRevision: probe.data.availabilityRevision,
					inventoryRevision: 1,
					nonce: probe.data.nonce,
					ok: false,
					reason: 'hash_mismatch'
				}
			},
			NOW + 1
		);
		const cancellation = messagesFor(cancelled, 'alice').filter(
			(message) => message.type === 'round_launch_cancelled'
		);
		expect(cancellation).toHaveLength(1);
		expect(cancellation[0]).toEqual(
			expect.objectContaining({
				data: expect.objectContaining({ reason: 'hash_mismatch', selection: null })
			})
		);
	});
});
