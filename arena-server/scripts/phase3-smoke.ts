import { createHash } from 'node:crypto';

import { ArenaApplication } from '../src/application/arena-application.ts';
import type { Delivery } from '../src/application/delivery.ts';
import type { ArenaIdentity, VerifiedArenaTicket } from '../src/auth/identity.ts';
import type { TicketVerifier } from '../src/auth/ticket-verifier.ts';
import { encodeHashChunk } from '../src/protocol/binary.ts';
import type {
	ArenaFinalResult,
	ArenaTelemetry,
	CompetitionRoomSnapshot,
	RoomSnapshot,
	ServerMessage
} from '../src/protocol/messages.ts';
import { createRoomDirectoryWithEntropy, type RoomDirectory } from '../src/rooms/room-directory.ts';
import { BunPasswordHasher } from '../src/rooms/bun-password-hasher.ts';

const BASE = 4_000_000;
const identities = {
	alice: { userId: 'phase3-alice', displayName: 'Alice', avatarUrl: null },
	bob: { userId: 'phase3-bob', displayName: 'Bob', avatarUrl: null },
	carol: { userId: 'phase3-carol', displayName: 'Carol', avatarUrl: null }
} as const satisfies Record<string, ArenaIdentity>;

class SmokeTicketVerifier implements TicketVerifier {
	readonly tickets: string[] = [];

	async verify(ticket: string, now: Date): Promise<VerifiedArenaTicket> {
		this.tickets.push(ticket);
		const identity = Object.values(identities).find((candidate) =>
			ticket.startsWith(candidate.userId)
		);
		if (identity === undefined) throw new Error('Unknown Phase 3 smoke identity.');
		return {
			identity,
			emailVerified: true,
			jti: `${ticket}-jti`,
			issuedAt: new Date(now.getTime() - 1_000),
			expiresAt: new Date(now.getTime() + 120_000),
			protocolMajor: 1,
			protocolMinor: 0
		};
	}
}

function invariant(condition: unknown, label: string): asserts condition {
	if (!condition) throw new Error(`Phase 3 smoke assertion failed: ${label}.`);
}

function phase(index: number, label: string): void {
	process.stdout.write(`phase ${index}/10: ${label}\n`);
}

function messagesFor(deliveries: readonly Delivery[], connectionId: string): ServerMessage[] {
	return deliveries.flatMap((delivery) =>
		(delivery.kind === 'send' || delivery.kind === 'send_ephemeral') &&
		delivery.connectionIds.includes(connectionId)
			? [delivery.message]
			: []
	);
}

function competitionSnapshot(deliveries: readonly Delivery[], connectionId: string) {
	const message = messagesFor(deliveries, connectionId).find(
		(candidate) => candidate.type === 'room_snapshot'
	);
	if (message?.type !== 'room_snapshot' || !('lastRoundResult' in message.data)) {
		throw new Error('Phase 3 room snapshot missing.');
	}
	return message.data;
}

function binding(room: RoomSnapshot | CompetitionRoomSnapshot) {
	return {
		roomId: room.roomId,
		roomGeneration: room.roomGeneration,
		connectionGeneration: room.self.connectionGeneration
	};
}

function inventoryBytes(values: readonly number[]): Uint8Array {
	const bytes = new Uint8Array(values.length * 32);
	for (let index = 0; index < values.length; ++index) {
		new DataView(bytes.buffer, index * 32, 32).setUint32(28, values[index]!, false);
	}
	return bytes;
}

function selection() {
	return {
		sha256: '2'.padStart(64, '0'),
		title: 'Phase 3 common chart',
		subtitle: '',
		artist: 'Smoke',
		keyMode: 7 as const,
		randomSequence: [1, 2, 3],
		noteOrderP1: 'random' as const,
		noteOrderP2: 'mirror' as const,
		dpMode: 'off' as const,
		laneSeed: '0123456789abcdef',
		randomizationVersion: 1 as const
	};
}

function telemetry(sequence: number, exScore: number, progressPermille: number): ArenaTelemetry {
	return {
		sequence,
		exScore,
		progressPermille,
		maxCombo: exScore / 2,
		badPoorCount: 0,
		judgements: {
			perfect: exScore / 2,
			great: 0,
			good: 0,
			bad: 0,
			poor: 0,
			emptyPoor: 0
		},
		gauge: { type: 'normal', valueMilli: 50_000 },
		playStatus: 'playing'
	};
}

function finalResult(exScore: number): ArenaFinalResult {
	return {
		exScore,
		maxCombo: exScore / 2,
		badPoorCount: 0,
		judgements: {
			perfect: exScore / 2,
			great: 0,
			good: 0,
			bad: 0,
			poor: 0,
			emptyPoor: 0
		},
		clearType: 'normal',
		finalGauge: { type: 'normal', valueMilli: 60_000 }
	};
}

async function authenticate(
	application: ArenaApplication,
	connectionId: string,
	identity: ArenaIdentity,
	nowMs: number,
	resume?: Readonly<{ roomId: string; seatToken: string }>
): Promise<readonly Delivery[]> {
	application.connect(connectionId);
	return application.receive(
		connectionId,
		{
			type: 'client_hello',
			data: {
				protocolMajor: 1,
				protocolMinor: 0,
				clientVersion: 'phase3-smoke',
				capabilities: ['rooms-v1', 'rounds-v1', 'competition-v1'],
				ticket: `${identity.userId}-${connectionId}`,
				...(resume === undefined ? {} : { resume })
			}
		},
		nowMs
	);
}

async function upload(
	application: ArenaApplication,
	connectionId: string,
	room: CompetitionRoomSnapshot,
	values: readonly number[],
	index: number,
	nowMs: number
): Promise<readonly Delivery[]> {
	const bytes = inventoryBytes(values);
	const declaration = {
		libraryGeneration: 1,
		hashCount: values.length,
		byteCount: bytes.byteLength,
		chunkCount: 1,
		vectorDigest: createHash('sha256').update(bytes).digest('hex')
	};
	const begun = await application.receive(
		connectionId,
		{
			type: 'inventory_upload_begin',
			requestId: `begin-${connectionId}`,
			data: { ...binding(room), ...declaration }
		},
		nowMs
	);
	const ready = messagesFor(begun, connectionId).find(
		(message) => message.type === 'inventory_upload_ready'
	);
	if (ready?.type !== 'inventory_upload_ready') throw new Error('Inventory upload not ready.');
	await application.receiveBinary(
		connectionId,
		encodeHashChunk({
			kind: 1,
			transferId: Uint8Array.from(Buffer.from(ready.data.uploadId, 'base64url')),
			chunkIndex: 0,
			hashes: bytes
		}),
		nowMs
	);
	return application.receive(
		connectionId,
		{
			type: 'inventory_upload_commit',
			requestId: `commit-${connectionId}`,
			data: { ...binding(room), uploadId: ready.data.uploadId, ...declaration }
		},
		nowMs + index
	);
}

type Seats = Readonly<{
	alice: CompetitionRoomSnapshot;
	bob: CompetitionRoomSnapshot;
	carol: CompetitionRoomSnapshot;
}>;

async function launchRound(
	application: ArenaApplication,
	seats: Seats,
	selectionRevision: number,
	availabilityRevision: number,
	nowMs: number,
	connections: Readonly<Record<keyof Seats, string>> = {
		alice: 'alice',
		bob: 'bob',
		carol: 'carol'
	}
) {
	let frozenDeliveries: readonly Delivery[] = [];
	for (const [index, role] of (['alice', 'bob', 'carol'] as const).entries()) {
		const connectionId = connections[role];
		frozenDeliveries = await application.receive(
			connectionId,
			{
				type: 'ready_set',
				requestId: `ready-${connectionId}-${nowMs}`,
				data: {
					...binding(seats[role]),
					ready: true,
					selectionRevision,
					availabilityRevision,
					inventoryRevision: index + 1
				}
			},
			nowMs
		);
	}
	const loading = messagesFor(frozenDeliveries, connections.alice).find(
		(message) => message.type === 'round_loading_started'
	);
	if (loading?.type !== 'round_loading_started') throw new Error('Round did not freeze.');
	const round = loading.data.round;
	let loadDeliveries: readonly Delivery[] = [];
	for (const [index, role] of (['alice', 'bob', 'carol'] as const).entries()) {
		const connectionId = connections[role];
		const probe = messagesFor(frozenDeliveries, connectionId).find(
			(message) => message.type === 'round_probe_requested'
		);
		if (probe?.type !== 'round_probe_requested') throw new Error('Probe missing.');
		loadDeliveries = await application.receive(
			connectionId,
			{
				type: 'round_probe_result',
				requestId: `probe-${connectionId}-${nowMs}`,
				data: {
					...binding(seats[role]),
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
			nowMs + 10
		);
	}
	for (const connectionId of Object.values(connections)) {
		invariant(
			messagesFor(loadDeliveries, connectionId).some(
				(message) => message.type === 'round_load_requested'
			),
			`${connectionId} load request`
		);
	}
	let scheduleDeliveries: readonly Delivery[] = [];
	for (const [index, role] of (['alice', 'bob', 'carol'] as const).entries()) {
		const connectionId = connections[role];
		scheduleDeliveries = await application.receive(
			connectionId,
			{
				type: 'round_load_result',
				requestId: `load-${connectionId}-${nowMs}`,
				data: {
					...binding(seats[role]),
					roundId: round.roundId,
					launchAttemptId: round.launchAttemptId,
					selectionRevision,
					availabilityRevision,
					inventoryRevision: index + 1,
					ok: true,
					chartLengthMs: 120_000
				}
			},
			nowMs + 20
		);
	}
	const scheduled = messagesFor(scheduleDeliveries, connections.alice).find(
		(message) => message.type === 'round_start_scheduled'
	);
	if (scheduled?.type !== 'round_start_scheduled') throw new Error('Round schedule missing.');
	if (!('playDeadlineAtServerMs' in scheduled.data)) throw new Error('Phase 3 deadline missing.');
	const started = application.sweep(scheduled.data.startAtServerMs);
	invariant(
		messagesFor(started, connections.alice).some((message) => message.type === 'round_started'),
		'round start event'
	);
	return { round, scheduled: scheduled.data, started };
}

async function run(): Promise<void> {
	if (process.argv.includes('--docker-image')) {
		throw new Error(
			'Docker Phase 3 smoke requires the Docker/Linux integration host and is not run by the in-process mode.'
		);
	}

	let entropy = 1;
	const verifier = new SmokeTicketVerifier();
	const roomDirectory: RoomDirectory = createRoomDirectoryWithEntropy(
		{ roomCapacity: 32, reconnectGraceMs: 10_000, chatBacklog: 200, maxRooms: 10 },
		new BunPasswordHasher(),
		(length) => new Uint8Array(length).fill(entropy++)
	);
	const application = new ArenaApplication({
		ticketVerifier: verifier,
		roomDirectory,
		now: () => BASE,
		newNonce: () => `heartbeat-${entropy++}`,
		newTransferId: () => new Uint8Array(16).fill(entropy++)
	});

	for (const [capabilities, connectionId] of [
		[['rooms-v1'] as const, 'rooms-only'],
		[['rooms-v1', 'rounds-v1'] as const, 'rounds-only']
	] as const) {
		application.connect(connectionId);
		await application.receive(
			connectionId,
			{
				type: 'client_hello',
				data: {
					protocolMajor: 1,
					protocolMinor: 0,
					clientVersion: 'legacy-smoke',
					capabilities: [...capabilities],
					ticket: `phase3-alice-${connectionId}`
				}
			},
			BASE
		);
		const rejected = await application.receive(
			connectionId,
			{
				type: 'room_create',
				requestId: `limited-create-${connectionId}`,
				data: { name: 'Limited' }
			},
			BASE
		);
		const error = messagesFor(rejected, connectionId)[0];
		invariant(
			error?.type === 'command_error' && error.data.code === 'competition_capability_required',
			`capability-limited ${connectionId} admission gate`
		);
	}
	phase(1, 'protocol 1.0 capability levels gate competition admission');

	await authenticate(application, 'alice', identities.alice, BASE);
	await authenticate(application, 'bob', identities.bob, BASE);
	await authenticate(application, 'carol', identities.carol, BASE);
	const created = await application.receive(
		'alice',
		{ type: 'room_create', requestId: 'create', data: { name: 'Phase 3 smoke' } },
		BASE
	);
	const alice = competitionSnapshot(created, 'alice');
	const bobJoined = await application.receive(
		'bob',
		{ type: 'room_join', requestId: 'join-bob', data: { roomId: alice.roomId } },
		BASE
	);
	const bob = competitionSnapshot(bobJoined, 'bob');
	const carolJoined = await application.receive(
		'carol',
		{ type: 'room_join', requestId: 'join-carol', data: { roomId: alice.roomId } },
		BASE
	);
	const carol = competitionSnapshot(carolJoined, 'carol');
	let common: readonly Delivery[] = [];
	for (const [index, connectionId] of (['alice', 'bob', 'carol'] as const).entries()) {
		common = await upload(
			application,
			connectionId,
			{ alice, bob, carol }[connectionId],
			[2],
			index + 1,
			BASE + 10
		);
	}
	const commonBegin = messagesFor(common, 'alice').find(
		(message) => message.type === 'availability_transfer_begin'
	);
	if (commonBegin?.type !== 'availability_transfer_begin') throw new Error('Common chart missing.');
	const availabilityRevision = commonBegin.data.targetRevision;
	for (const connectionId of ['alice', 'bob', 'carol'] as const) {
		await application.receive(
			connectionId,
			{
				type: 'availability_applied',
				requestId: `ack-${connectionId}`,
				data: { ...binding({ alice, bob, carol }[connectionId]), availabilityRevision }
			},
			BASE + 20
		);
	}
	const selected = await application.receive(
		'alice',
		{
			type: 'selection_set',
			requestId: 'select',
			data: {
				...binding(alice),
				availabilityRevision,
				inventoryRevision: 1,
				selection: selection()
			}
		},
		BASE + 21
	);
	const selectionChanged = messagesFor(selected, 'alice').find(
		(message) => message.type === 'selection_changed'
	);
	if (selectionChanged?.type !== 'selection_changed') throw new Error('Selection missing.');
	const selectionRevision = selectionChanged.data.selectionRevision;
	const seats = { alice, bob, carol };
	const first = await launchRound(
		application,
		seats,
		selectionRevision,
		availabilityRevision,
		BASE + 30
	);
	phase(2, 'three minor-2 seats agree on chart length and start');

	const initial = messagesFor(first.started, 'alice').find(
		(message) => message.type === 'round_standings'
	);
	if (initial?.type !== 'round_standings') throw new Error('Initial standings missing.');
	invariant(
		initial.data.entries.every((entry) => entry.rank === null),
		'initial no-data rows'
	);
	await application.receive(
		'alice',
		{
			type: 'round_telemetry',
			data: {
				...binding(alice),
				roundId: first.round.roundId,
				launchAttemptId: first.round.launchAttemptId,
				telemetry: telemetry(1, 0, 1)
			}
		},
		first.scheduled.startAtServerMs + 1
	);
	const zero = application.sweep(first.scheduled.startAtServerMs + 200);
	const zeroStandings = messagesFor(zero, 'bob').find(
		(message) => message.type === 'round_standings'
	);
	if (zeroStandings?.type !== 'round_standings') throw new Error('Zero standings missing.');
	invariant(zeroStandings.data.entries[0]?.rank === 1, 'zero score ranks');
	invariant(zeroStandings.data.entries[1]?.rank === null, 'no data is not zero');
	phase(3, 'zero score and no-data remain distinct');

	for (const [connectionId, score, sequence] of [
		['alice', 100, 2],
		['bob', 100, 1],
		['carol', 90, 1]
	] as const) {
		await application.receive(
			connectionId,
			{
				type: 'round_telemetry',
				data: {
					...binding(seats[connectionId]),
					roundId: first.round.roundId,
					launchAttemptId: first.round.launchAttemptId,
					telemetry: telemetry(sequence, score, 500)
				}
			},
			first.scheduled.startAtServerMs + 201
		);
	}
	const ranked = application.sweep(first.scheduled.startAtServerMs + 400);
	const rankedStandings = messagesFor(ranked, 'alice').find(
		(message) => message.type === 'round_standings'
	);
	if (rankedStandings?.type !== 'round_standings') throw new Error('Ranked standings missing.');
	invariant(
		JSON.stringify(rankedStandings.data.entries.map((entry) => entry.rank)) === '[1,1,3]',
		'live 1,1,3 ranks'
	);
	phase(4, 'telemetry 100/100/90 produces live ranks 1,1,3');

	await application.receive(
		'alice',
		{
			type: 'round_telemetry',
			data: {
				...binding(alice),
				roundId: first.round.roundId,
				launchAttemptId: first.round.launchAttemptId,
				telemetry: telemetry(3, 100, 600)
			}
		},
		first.scheduled.startAtServerMs + 401
	);
	const repair = application.sweep(first.scheduled.startAtServerMs + 600);
	const repaired = messagesFor(repair, 'bob').find((message) => message.type === 'round_standings');
	invariant(
		repaired?.type === 'round_standings' && repaired.data.entries.length === 3,
		'full repair'
	);
	phase(5, 'a later complete snapshot repairs a dropped ephemeral event');

	let finalized: readonly Delivery[] = [];
	for (const [connectionId, score] of [
		['alice', 100],
		['bob', 100],
		['carol', 90]
	] as const) {
		finalized = await application.receive(
			connectionId,
			{
				type: 'round_result_submit',
				requestId: `final-${connectionId}`,
				data: {
					...binding(seats[connectionId]),
					roundId: first.round.roundId,
					launchAttemptId: first.round.launchAttemptId,
					result: finalResult(score)
				}
			},
			first.scheduled.startAtServerMs + 610
		);
	}
	const firstFinal = messagesFor(finalized, 'alice').find(
		(message) => message.type === 'round_finalized'
	);
	if (firstFinal?.type !== 'round_finalized') throw new Error('First finalization missing.');
	invariant(
		JSON.stringify(firstFinal.data.result.entries.map((entry) => entry.rank)) === '[1,1,3]',
		'final 1,1,3 ranks'
	);
	invariant(
		firstFinal.data.members.slice(0, 2).every((member) => member.lobbyWins === 1),
		'joint winner wins'
	);
	phase(6, 'finals 100/100/90 finalize and award both winners');
	invariant(roomDirectory.list().rooms[0]?.phase === 'selecting', 'room returns Selecting');
	phase(7, 'room returns Selecting and retains one last result');

	application.disconnect('alice', BASE + 10_000);
	const resumed = await authenticate(application, 'alice-2', identities.alice, BASE + 10_001, {
		roomId: alice.roomId,
		seatToken: alice.self.resumeToken
	});
	const resumedHello = messagesFor(resumed, 'alice-2')[0];
	if (resumedHello?.type !== 'server_hello' || resumedHello.data.resume.status !== 'succeeded') {
		throw new Error('Alice resume failed.');
	}
	const alice2 = resumedHello.data.resume.room;
	if (!('lastRoundResult' in alice2)) throw new Error('Competition resume missing.');
	invariant(alice2.lastRoundResult?.roundId === first.round.roundId, 'last result retained');
	const secondSeats = { alice: alice2, bob, carol };
	const second = await launchRound(
		application,
		secondSeats,
		selectionRevision,
		availabilityRevision,
		BASE + 10_010,
		{ alice: 'alice-2', bob: 'bob', carol: 'carol' }
	);
	phase(8, 'second round reconnects Alice and starts');

	await application.receive(
		'bob',
		{
			type: 'round_abandon',
			requestId: 'second-bob-dnf',
			data: {
				...binding(bob),
				roundId: second.round.roundId,
				launchAttemptId: second.round.launchAttemptId,
				reason: 'aborted'
			}
		},
		second.scheduled.startAtServerMs + 1
	);
	await application.receive(
		'alice-2',
		{
			type: 'round_result_submit',
			requestId: 'second-alice-final',
			data: {
				...binding(alice2),
				roundId: second.round.roundId,
				launchAttemptId: second.round.launchAttemptId,
				result: finalResult(100)
			}
		},
		second.scheduled.startAtServerMs + 2
	);
	const deadline = application.sweep(second.scheduled.playDeadlineAtServerMs);
	const secondFinal = messagesFor(deadline, 'alice-2').find(
		(message) => message.type === 'round_finalized'
	);
	if (secondFinal?.type !== 'round_finalized') throw new Error('Deadline finalization missing.');
	invariant(
		secondFinal.data.result.entries.some(
			(entry) => entry.competitionState === 'dnf' && entry.dnfReason === 'play_deadline'
		),
		'Carol deadline DNF'
	);
	phase(9, 'valid finisher survives abandon and deadline DNF');

	for (const [connectionId, room] of [
		['alice-2', alice2],
		['bob', bob],
		['carol', carol]
	] as const) {
		await application.receive(
			connectionId,
			{
				type: 'room_leave',
				requestId: `leave-${connectionId}`,
				data: binding(room)
			},
			second.scheduled.playDeadlineAtServerMs + 1
		);
	}
	invariant(roomDirectory.list().rooms.length === 0, 'room destruction');
	phase(10, 'room destruction releases result, telemetry, identities, and wins');
	invariant(verifier.tickets.length === 6, 'only identity tickets reached verifier');
	process.stdout.write('Phase 3 Arena smoke passed.\n');
}

await run();
