import { createHash } from 'node:crypto';

import { ArenaApplication } from '../src/application/arena-application.ts';
import type { Delivery } from '../src/application/delivery.ts';
import type { ArenaIdentity, VerifiedArenaTicket } from '../src/auth/identity.ts';
import type { TicketVerifier } from '../src/auth/ticket-verifier.ts';
import { InventoryUploadManager } from '../src/inventory/inventory-upload-manager.ts';
import { createOperationalMetrics } from '../src/observability/operational-metrics.ts';
import { encodeHashChunk } from '../src/protocol/binary.ts';
import type {
	ArenaFinalResult,
	ArenaTelemetry,
	CompetitionRoomSnapshot,
	ServerMessage
} from '../src/protocol/messages.ts';
import { BunPasswordHasher } from '../src/rooms/bun-password-hasher.ts';
import { createRoomDirectoryWithEntropy, type RoomDirectory } from '../src/rooms/room-directory.ts';

const ROOM_COUNT = 25;
const SEATS_PER_ROOM = 8;
const CLIENT_COUNT = ROOM_COUNT * SEATS_PER_ROOM;
const TELEMETRY_HZ = 5;
const LOGICAL_SECONDS = 30;
const TELEMETRY_TICKS = TELEMETRY_HZ * LOGICAL_SECONDS;
const TICK_MS = 1_000 / TELEMETRY_HZ;
const BASE = 8_000_000;
const COMMON_HASH_VALUE = 1;

type Seat = {
	identity: ArenaIdentity;
	connectionId: string;
	room: CompetitionRoomSnapshot;
	inventoryRevision: number;
};

type LoadRoom = {
	roomIndex: number;
	seats: Seat[];
	availabilityRevision: number;
	selectionRevision: number;
	round: Readonly<{ roundId: string; launchAttemptId: string }>;
	startAtServerMs: number;
};

type LoadContext = {
	readonly application: ArenaApplication;
	peakEncodedDeliveryBytes: number;
	deliveryCount: number;
};

class LoadTicketVerifier implements TicketVerifier {
	readonly #identities: ReadonlyMap<string, ArenaIdentity>;

	constructor(identities: readonly ArenaIdentity[]) {
		this.#identities = new Map(identities.map((identity) => [identity.userId, identity]));
	}

	async verify(ticket: string, now: Date): Promise<VerifiedArenaTicket> {
		const separator = ticket.indexOf('|');
		const userId = separator < 0 ? '' : ticket.slice(0, separator);
		const identity = this.#identities.get(userId);
		if (identity === undefined) throw new Error('Unknown Phase 4 load identity.');
		return {
			identity,
			emailVerified: true,
			jti: createHash('sha256').update(ticket).digest('base64url').slice(0, 43),
			issuedAt: new Date(now.getTime() - 1_000),
			expiresAt: new Date(now.getTime() + 120_000),
			protocolMajor: 1,
			protocolMinor: 2
		};
	}
}

function invariant(condition: unknown, label: string): asserts condition {
	if (!condition) throw new Error(`Phase 4 load assertion failed: ${label}.`);
}

function messagesFor(deliveries: readonly Delivery[], connectionId: string): ServerMessage[] {
	return deliveries.flatMap((delivery) =>
		(delivery.kind === 'send' || delivery.kind === 'send_ephemeral') &&
		delivery.connectionIds.includes(connectionId)
			? [delivery.message]
			: []
	);
}

function record(context: LoadContext, deliveries: readonly Delivery[]): readonly Delivery[] {
	let encodedBytes = 0;
	for (const delivery of deliveries) {
		if (delivery.kind === 'send' || delivery.kind === 'send_ephemeral') {
			encodedBytes += Buffer.byteLength(JSON.stringify(delivery.message), 'utf8');
		} else if (delivery.kind === 'send_binary') encodedBytes += delivery.bytes.byteLength;
	}
	context.peakEncodedDeliveryBytes = Math.max(context.peakEncodedDeliveryBytes, encodedBytes);
	context.deliveryCount += deliveries.length;
	return deliveries;
}

async function receive(
	context: LoadContext,
	connectionId: string,
	message: Parameters<ArenaApplication['receive']>[1],
	nowMs: number
): Promise<readonly Delivery[]> {
	return record(context, await context.application.receive(connectionId, message, nowMs));
}

function binding(seat: Seat) {
	return {
		roomId: seat.room.roomId,
		roomGeneration: seat.room.roomGeneration,
		connectionGeneration: seat.room.self.connectionGeneration
	};
}

function inventoryBytes(uniqueHashValue: number): Uint8Array {
	const bytes = new Uint8Array(64);
	new DataView(bytes.buffer).setUint32(28, COMMON_HASH_VALUE, false);
	new DataView(bytes.buffer).setUint32(60, uniqueHashValue, false);
	return bytes;
}

function selection() {
	return {
		sha256: COMMON_HASH_VALUE.toString(16).padStart(64, '0'),
		title: 'Phase 4 bounded load chart',
		subtitle: '',
		artist: 'Arena load',
		keyMode: 7 as const,
		randomSequence: [1, 2, 3],
		noteOrderP1: 'random' as const,
		noteOrderP2: 'mirror' as const,
		dpMode: 'off' as const,
		laneSeed: '0123456789abcdef',
		randomizationVersion: 1 as const
	};
}

function telemetry(sequence: number, seatIndex: number): ArenaTelemetry {
	const exScore = sequence * 2 + seatIndex * 2;
	return {
		sequence,
		exScore,
		progressPermille: Math.floor((sequence * 1_000) / TELEMETRY_TICKS),
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
		gauge: { type: 'normal', valueMilli: 50_000 + seatIndex },
		playStatus: 'playing'
	};
}

function finalResult(seatIndex: number): ArenaFinalResult {
	const exScore = 2_000 + (SEATS_PER_ROOM - seatIndex) * 2;
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
		finalGauge: { type: 'normal', valueMilli: 60_000 + seatIndex }
	};
}

async function authenticate(
	context: LoadContext,
	connectionId: string,
	identity: ArenaIdentity,
	nowMs: number,
	resume?: Readonly<{ roomId: string; seatToken: string }>
): Promise<readonly Delivery[]> {
	record(context, context.application.connect(connectionId));
	return receive(
		context,
		connectionId,
		{
			type: 'client_hello',
			data: {
				protocolMajor: 1,
				protocolMinor: 2,
				clientVersion: 'phase4-load',
				capabilities: ['rooms-v1', 'rounds-v1', 'competition-v1'],
				ticket: `${identity.userId}|${connectionId}`,
				...(resume === undefined ? {} : { resume })
			}
		},
		nowMs
	);
}

function roomSnapshot(
	deliveries: readonly Delivery[],
	connectionId: string
): CompetitionRoomSnapshot {
	const message = messagesFor(deliveries, connectionId).find(
		(candidate) => candidate.type === 'room_snapshot'
	);
	if (message?.type !== 'room_snapshot' || !('liveStandings' in message.data)) {
		throw new Error('Phase 4 load room snapshot missing.');
	}
	return message.data;
}

async function uploadInventory(
	context: LoadContext,
	seat: Seat,
	libraryGeneration: number,
	uniqueHashValue: number,
	nowMs: number
): Promise<readonly Delivery[]> {
	const bytes = inventoryBytes(uniqueHashValue);
	const declaration = {
		libraryGeneration,
		hashCount: 2,
		byteCount: bytes.byteLength,
		chunkCount: 1,
		vectorDigest: createHash('sha256').update(bytes).digest('hex')
	};
	const begun = await receive(
		context,
		seat.connectionId,
		{
			type: 'inventory_upload_begin',
			requestId: `begin-${seat.connectionId}`,
			data: { ...binding(seat), ...declaration }
		},
		nowMs
	);
	const ready = messagesFor(begun, seat.connectionId).find(
		(message) => message.type === 'inventory_upload_ready'
	);
	if (ready?.type !== 'inventory_upload_ready') throw new Error('Load inventory begin failed.');
	record(
		context,
		await context.application.receiveBinary(
			seat.connectionId,
			encodeHashChunk({
				kind: 1,
				transferId: Uint8Array.from(Buffer.from(ready.data.uploadId, 'base64url')),
				chunkIndex: 0,
				hashes: bytes
			}),
			nowMs + 1
		)
	);
	return receive(
		context,
		seat.connectionId,
		{
			type: 'inventory_upload_commit',
			requestId: `commit-${seat.connectionId}`,
			data: { ...binding(seat), uploadId: ready.data.uploadId, ...declaration }
		},
		nowMs + 2
	);
}

async function createLoadRoom(
	context: LoadContext,
	identities: readonly ArenaIdentity[],
	roomIndex: number,
	nowMs: number
): Promise<LoadRoom> {
	const roomIdentities = identities.slice(
		roomIndex * SEATS_PER_ROOM,
		(roomIndex + 1) * SEATS_PER_ROOM
	);
	const seats: Seat[] = [];
	for (let seatIndex = 0; seatIndex < roomIdentities.length; seatIndex += 1) {
		const identity = roomIdentities[seatIndex]!;
		const connectionId = `load-${roomIndex}-${seatIndex}`;
		await authenticate(context, connectionId, identity, nowMs);
		if (seatIndex === 0) {
			const created = await receive(
				context,
				connectionId,
				{
					type: 'room_create',
					requestId: `create-${roomIndex}`,
					data: { name: `Load room ${roomIndex + 1}` }
				},
				nowMs + 1
			);
			seats.push({
				identity,
				connectionId,
				room: roomSnapshot(created, connectionId),
				inventoryRevision: 0
			});
		} else {
			const joined = await receive(
				context,
				connectionId,
				{
					type: 'room_join',
					requestId: `join-${roomIndex}-${seatIndex}`,
					data: { roomId: seats[0]!.room.roomId }
				},
				nowMs + 1
			);
			seats.push({
				identity,
				connectionId,
				room: roomSnapshot(joined, connectionId),
				inventoryRevision: 0
			});
		}
	}

	let availabilityRevision = 0;
	for (let seatIndex = 0; seatIndex < seats.length; seatIndex += 1) {
		const seat = seats[seatIndex]!;
		const committed = await uploadInventory(
			context,
			seat,
			1,
			2 + roomIndex * SEATS_PER_ROOM + seatIndex,
			nowMs + 10 + seatIndex * 3
		);
		const confirmation = messagesFor(committed, seat.connectionId).find(
			(message) => message.type === 'inventory_committed'
		);
		if (confirmation?.type !== 'inventory_committed')
			throw new Error('Load inventory commit failed.');
		seat.inventoryRevision = confirmation.data.inventoryRevision;
		const common = messagesFor(committed, seats[0]!.connectionId).find(
			(message) => message.type === 'availability_transfer_begin'
		);
		if (common?.type === 'availability_transfer_begin') {
			availabilityRevision = common.data.targetRevision;
		}
	}
	invariant(availabilityRevision > 0, `room ${roomIndex} common inventory`);
	for (const seat of seats) {
		await receive(
			context,
			seat.connectionId,
			{
				type: 'availability_applied',
				requestId: `availability-${seat.connectionId}`,
				data: { ...binding(seat), availabilityRevision }
			},
			nowMs + 40
		);
	}
	const owner = seats[0]!;
	const selected = await receive(
		context,
		owner.connectionId,
		{
			type: 'selection_set',
			requestId: `selection-${roomIndex}`,
			data: {
				...binding(owner),
				availabilityRevision,
				inventoryRevision: owner.inventoryRevision,
				selection: selection()
			}
		},
		nowMs + 41
	);
	const selectionChanged = messagesFor(selected, owner.connectionId).find(
		(message) => message.type === 'selection_changed'
	);
	if (selectionChanged?.type !== 'selection_changed') throw new Error('Load selection failed.');
	const selectionRevision = selectionChanged.data.selectionRevision;
	await receive(
		context,
		owner.connectionId,
		{
			type: 'chat_send',
			requestId: `chat-${roomIndex}`,
			data: { ...binding(owner), text: `bounded load room ${roomIndex + 1}` }
		},
		nowMs + 42
	);

	let frozen: readonly Delivery[] = [];
	for (const seat of seats) {
		frozen = await receive(
			context,
			seat.connectionId,
			{
				type: 'ready_set',
				requestId: `ready-${seat.connectionId}`,
				data: {
					...binding(seat),
					ready: true,
					selectionRevision,
					availabilityRevision,
					inventoryRevision: seat.inventoryRevision
				}
			},
			nowMs + 50
		);
	}
	const loading = messagesFor(frozen, owner.connectionId).find(
		(message) => message.type === 'round_loading_started'
	);
	if (loading?.type !== 'round_loading_started') throw new Error('Load round freeze failed.');
	const round = loading.data.round;
	let loadRequests: readonly Delivery[] = [];
	for (const seat of seats) {
		const probe = messagesFor(frozen, seat.connectionId).find(
			(message) => message.type === 'round_probe_requested'
		);
		if (probe?.type !== 'round_probe_requested') throw new Error('Load probe missing.');
		loadRequests = await receive(
			context,
			seat.connectionId,
			{
				type: 'round_probe_result',
				requestId: `probe-${seat.connectionId}`,
				data: {
					...binding(seat),
					roundId: round.roundId,
					launchAttemptId: round.launchAttemptId,
					selectionRevision,
					availabilityRevision,
					inventoryRevision: seat.inventoryRevision,
					nonce: probe.data.nonce,
					ok: true,
					sha256: selection().sha256
				}
			},
			nowMs + 60
		);
	}
	invariant(
		messagesFor(loadRequests, owner.connectionId).some(
			(message) => message.type === 'round_load_requested'
		),
		`room ${roomIndex} load barrier`
	);

	let scheduledDeliveries: readonly Delivery[] = [];
	for (const seat of seats) {
		scheduledDeliveries = await receive(
			context,
			seat.connectionId,
			{
				type: 'round_load_result',
				requestId: `loaded-${seat.connectionId}`,
				data: {
					...binding(seat),
					roundId: round.roundId,
					launchAttemptId: round.launchAttemptId,
					selectionRevision,
					availabilityRevision,
					inventoryRevision: seat.inventoryRevision,
					ok: true,
					chartLengthMs: 120_000
				}
			},
			nowMs + 70
		);
	}
	const scheduled = messagesFor(scheduledDeliveries, owner.connectionId).find(
		(message) => message.type === 'round_start_scheduled'
	);
	if (scheduled?.type !== 'round_start_scheduled') throw new Error('Load schedule missing.');
	record(context, context.application.sweep(scheduled.data.startAtServerMs));
	return {
		roomIndex,
		seats,
		availabilityRevision,
		selectionRevision,
		round,
		startAtServerMs: scheduled.data.startAtServerMs
	};
}

async function reconnectOneSeat(
	context: LoadContext,
	room: LoadRoom,
	nowMs: number
): Promise<void> {
	const seat = room.seats[room.seats.length - 1]!;
	record(context, context.application.disconnect(seat.connectionId, nowMs));
	const resumedConnectionId = `${seat.connectionId}-resume`;
	const resumed = await authenticate(context, resumedConnectionId, seat.identity, nowMs + 1, {
		roomId: seat.room.roomId,
		seatToken: seat.room.self.resumeToken
	});
	const hello = messagesFor(resumed, resumedConnectionId).find(
		(message) => message.type === 'server_hello'
	);
	if (hello?.type !== 'server_hello' || hello.data.resume.status !== 'succeeded') {
		throw new Error('Load reconnect failed.');
	}
	seat.connectionId = resumedConnectionId;
	if (!('liveStandings' in hello.data.resume.room)) throw new Error('Competition resume missing.');
	seat.room = hello.data.resume.room;
}

async function finalizeAndDestroy(
	context: LoadContext,
	room: LoadRoom,
	nowMs: number
): Promise<boolean> {
	let finalized = false;
	for (let seatIndex = 0; seatIndex < room.seats.length; seatIndex += 1) {
		const seat = room.seats[seatIndex]!;
		const deliveries = await receive(
			context,
			seat.connectionId,
			{
				type: 'round_result_submit',
				requestId: `final-${seat.connectionId}`,
				data: {
					...binding(seat),
					roundId: room.round.roundId,
					launchAttemptId: room.round.launchAttemptId,
					result: finalResult(seatIndex)
				}
			},
			nowMs
		);
		if (
			messagesFor(deliveries, room.seats[0]!.connectionId).some(
				(message) => message.type === 'round_finalized'
			)
		) {
			finalized = true;
		}
	}
	for (const seat of room.seats) {
		await receive(
			context,
			seat.connectionId,
			{
				type: 'room_leave',
				requestId: `leave-${seat.connectionId}`,
				data: binding(seat)
			},
			nowMs + 1
		);
		record(context, context.application.disconnect(seat.connectionId, nowMs + 2));
	}
	return finalized;
}

async function runWebSocketChild(url: string, count: number): Promise<void> {
	if (!Number.isSafeInteger(count) || count < 1 || count > 5_000) {
		throw new Error('Invalid real WebSocket child count.');
	}
	await new Promise<void>((resolve, reject) => {
		let hellos = 0;
		let closes = 0;
		let closing = false;
		let settled = false;
		const sockets: WebSocket[] = [];
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new Error(`Real WebSocket child received ${hellos}/${count} hellos.`));
		}, 15_000);
		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(error);
		};
		for (let index = 0; index < count; index += 1) {
			const socket = new WebSocket(url);
			sockets.push(socket);
			let helloReceived = false;
			socket.addEventListener('open', () => {
				socket.send(
					JSON.stringify({
						type: 'client_hello',
						data: {
							protocolMajor: 1,
							protocolMinor: 0,
							clientVersion: 'phase4-load-websocket',
							capabilities: ['rooms-v1']
						}
					})
				);
			});
			socket.addEventListener('message', (event) => {
				if (settled || helloReceived || typeof event.data !== 'string') return;
				const message = JSON.parse(event.data) as { type?: string };
				if (message.type !== 'server_hello') return;
				helloReceived = true;
				hellos += 1;
				if (hellos === count) {
					closing = true;
					for (const openSocket of sockets) openSocket.close(1000, 'load_complete');
				}
			});
			socket.addEventListener('error', () => {
				fail(new Error(`Real WebSocket child client ${index} failed.`));
			});
			socket.addEventListener('close', () => {
				if (!helloReceived) fail(new Error(`Real WebSocket child client ${index} closed early.`));
				else if (closing) {
					closes += 1;
					if (closes === count && !settled) {
						settled = true;
						clearTimeout(timer);
						resolve();
					}
				}
			});
		}
	});
}

function metricValue(rendered: string, sample: string): number {
	const escaped = sample.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const match = rendered.match(new RegExp(`^${escaped} ([^\\r\\n]+)$`, 'm'));
	if (match?.[1] === undefined) throw new Error(`Missing load metric ${sample}.`);
	return Number(match[1]);
}

function percentile(values: readonly number[], quantile: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))]!;
}

async function run(): Promise<void> {
	const wallStarted = performance.now();
	const rssStart = process.memoryUsage().rss;
	let rssPeak = rssStart;
	let entropy = 1;
	const randomBytes = (length: number): Uint8Array => {
		const bytes = new Uint8Array(length);
		const view = new DataView(bytes.buffer);
		view.setUint32(Math.max(0, length - 4), entropy++, false);
		return bytes;
	};
	const identities = Array.from(
		{ length: CLIENT_COUNT },
		(_, index): ArenaIdentity => ({
			userId: `load-user-${index.toString().padStart(3, '0')}`,
			displayName: `Load User ${index + 1}`,
			avatarUrl: null
		})
	);
	const metrics = createOperationalMetrics();
	const inventoryUploads = new InventoryUploadManager({
		newTransferId: () => randomBytes(16),
		operationalMetrics: metrics
	});
	const roomDirectory: RoomDirectory = createRoomDirectoryWithEntropy(
		{
			roomCapacity: 16,
			reconnectGraceMs: 60_000,
			chatBacklog: 200,
			maxRooms: ROOM_COUNT
		},
		new BunPasswordHasher(),
		randomBytes,
		(inventory) => inventoryUploads.releaseCommitted(inventory)
	);
	const application = new ArenaApplication({
		ticketVerifier: new LoadTicketVerifier(identities),
		roomDirectory,
		now: () => BASE,
		newNonce: () => `load-nonce-${entropy++}`,
		newTransferId: () => randomBytes(16),
		inventoryUploadManager: inventoryUploads,
		operationalMetrics: metrics
	});
	const context: LoadContext = {
		application,
		peakEncodedDeliveryBytes: 0,
		deliveryCount: 0
	};
	const rooms: LoadRoom[] = [];
	let peakInventoryBytes = 0;
	for (let roomIndex = 0; roomIndex < ROOM_COUNT; roomIndex += 1) {
		rooms.push(await createLoadRoom(context, identities, roomIndex, BASE + roomIndex * 100));
		peakInventoryBytes = Math.max(peakInventoryBytes, inventoryUploads.committedBytes);
		rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
	}
	invariant(roomDirectory.list().rooms.length === ROOM_COUNT, 'all rooms created');
	process.stdout.write(
		`phase 1/5: ${CLIENT_COUNT} authenticated seats launched in ${ROOM_COUNT} rooms\n`
	);

	const eventLoopDelaysMs: number[] = [];
	for (let tick = 0; tick < TELEMETRY_TICKS; tick += 1) {
		const sequence = tick + 1;
		const telemetryTasks: Promise<readonly Delivery[]>[] = [];
		for (const room of rooms) {
			const nowMs = room.startAtServerMs + tick * TICK_MS;
			for (let seatIndex = 0; seatIndex < room.seats.length; seatIndex += 1) {
				const seat = room.seats[seatIndex]!;
				telemetryTasks.push(
					receive(
						context,
						seat.connectionId,
						{
							type: 'round_telemetry',
							data: {
								...binding(seat),
								roundId: room.round.roundId,
								launchAttemptId: room.round.launchAttemptId,
								telemetry: telemetry(sequence, seatIndex)
							}
						},
						nowMs
					)
				);
			}
		}
		await Promise.all(telemetryTasks);
		const beforeYield = performance.now();
		await Bun.sleep(0);
		eventLoopDelaysMs.push(performance.now() - beforeYield);
		rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
	}
	process.stdout.write(`phase 2/5: ${CLIENT_COUNT * TELEMETRY_TICKS} telemetry samples accepted\n`);

	let reconnects = 0;
	for (const room of rooms) {
		await reconnectOneSeat(context, room, room.startAtServerMs + LOGICAL_SECONDS * 1_000 + 1);
		reconnects += 1;
	}
	process.stdout.write(`phase 3/5: ${reconnects} seats disconnected and resumed\n`);

	let finalizedRooms = 0;
	for (const room of rooms) {
		if (
			await finalizeAndDestroy(context, room, room.startAtServerMs + LOGICAL_SECONDS * 1_000 + 100)
		) {
			finalizedRooms += 1;
		}
	}
	process.stdout.write(`phase 4/5: ${finalizedRooms} rooms finalized and destroyed\n`);
	invariant(finalizedRooms === ROOM_COUNT, 'all rooms finalized once');
	invariant(reconnects === ROOM_COUNT, 'one reconnect per room');
	invariant(roomDirectory.list().rooms.length === 0, 'rooms destroyed');
	invariant(inventoryUploads.pendingReservedBytes === 0, 'pending inventory released');
	invariant(inventoryUploads.committedBytes === 0, 'committed inventory released');

	application.finalizeShutdown();
	const realWebSocketConnections = 0;
	process.stdout.write(
		'phase 5/5: domain soak complete; external-container WebSocket fan-in is a separate gate\n'
	);
	const rendered = metrics.renderPrometheus();
	for (const sample of [
		'arena_connections_current',
		'arena_rooms_current',
		'arena_reserved_seats_current',
		'arena_rounds_active',
		'arena_inventory_committed_bytes'
	]) {
		invariant(metricValue(rendered, sample) === 0, `${sample} returned to zero`);
	}
	invariant(
		metricValue(rendered, 'arena_rounds_started_total') === ROOM_COUNT,
		'round start count'
	);
	invariant(
		metricValue(rendered, 'arena_rounds_finalized_total') === ROOM_COUNT,
		'round finalization count'
	);
	invariant(
		metricValue(rendered, 'arena_standings_dropped_total') === 0,
		'no in-process standings drops'
	);
	const rssEnd = process.memoryUsage().rss;
	process.stdout.write(
		`${JSON.stringify(
			{
				status: 'ok',
				mode: 'in-process-domain',
				clients: CLIENT_COUNT,
				rooms: ROOM_COUNT,
				seatsPerRoom: SEATS_PER_ROOM,
				logicalTelemetrySeconds: LOGICAL_SECONDS,
				telemetryHz: TELEMETRY_HZ,
				telemetrySamples: CLIENT_COUNT * TELEMETRY_TICKS,
				realWebSocketConnections,
				websocketGate: 'external-container-gate-required',
				reconnects,
				finalizedRooms,
				rssBytes: { start: rssStart, peak: rssPeak, end: rssEnd },
				eventLoopDelayMs: {
					p50: percentile(eventLoopDelaysMs, 0.5),
					p95: percentile(eventLoopDelaysMs, 0.95),
					max: Math.max(...eventLoopDelaysMs)
				},
				bufferedBytes: {
					current: 0,
					peakEncodedDeliveryBatch: context.peakEncodedDeliveryBytes
				},
				deliveryCount: context.deliveryCount,
				peakInventoryBytes,
				droppedEphemeralStandings: metricValue(rendered, 'arena_standings_dropped_total'),
				postCleanup: {
					connections: metricValue(rendered, 'arena_connections_current'),
					rooms: metricValue(rendered, 'arena_rooms_current'),
					reservedSeats: metricValue(rendered, 'arena_reserved_seats_current'),
					activeRounds: metricValue(rendered, 'arena_rounds_active'),
					inventoryBytes: metricValue(rendered, 'arena_inventory_committed_bytes')
				},
				wallDurationMs: performance.now() - wallStarted
			},
			null,
			2
		)}\n`
	);
}

const childIndex = process.argv.indexOf('--websocket-child');
if (childIndex >= 0) {
	try {
		const url = process.argv[childIndex + 1];
		const count = Number(process.argv[childIndex + 2]);
		if (url === undefined) throw new Error('Missing real WebSocket child URL.');
		await runWebSocketChild(url, count);
		process.exit(0);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : 'WebSocket child failed.'}\n`);
		process.exit(1);
	}
} else await run();
