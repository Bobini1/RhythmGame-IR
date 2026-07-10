import { createHash } from 'node:crypto';

import { ArenaApplication } from '../src/application/arena-application.ts';
import type { Delivery } from '../src/application/delivery.ts';
import type { ArenaIdentity, VerifiedArenaTicket } from '../src/auth/identity.ts';
import { JoseTicketVerifier } from '../src/auth/jose-ticket-verifier.ts';
import type { TicketVerifier } from '../src/auth/ticket-verifier.ts';
import { loadArenaConfig } from '../src/config.ts';
import { InventoryUploadManager } from '../src/inventory/inventory-upload-manager.ts';
import { decodeHashChunk, encodeHashChunk } from '../src/protocol/binary.ts';
import {
	serverMessageSchema,
	type ClientMessage,
	type RoomSnapshot,
	type SelectionSnapshot,
	type ServerMessage
} from '../src/protocol/messages.ts';
import { BunPasswordHasher } from '../src/rooms/bun-password-hasher.ts';
import {
	createRoomDirectory,
	createRoomDirectoryWithEntropy,
	type RoomDirectory
} from '../src/rooms/room-directory.ts';
import { startArenaServer, type ArenaServerHandle } from '../src/transport/start-server.ts';
import { SmokeClient, startLocalIssuer } from './phase1-smoke.ts';

const NOW = 2_000_000;
const ROOM_PASSWORD = 'phase2-smoke-password';
const identities = {
	alice: { userId: 'phase2-alice', displayName: 'Alice', avatarUrl: null },
	bob: { userId: 'phase2-bob', displayName: 'Bob', avatarUrl: null },
	carol: { userId: 'phase2-carol', displayName: 'Carol', avatarUrl: null }
} as const satisfies Record<string, ArenaIdentity>;
const forbiddenPhase3Types = new Set(['round_terminal_accepted', 'round_finalized']);

type SmokeContext = Readonly<{
	application: ArenaApplication;
	roomDirectory: RoomDirectory;
	deliveries: Delivery[];
}>;

class SmokeTicketVerifier implements TicketVerifier {
	async verify(ticket: string, now: Date): Promise<VerifiedArenaTicket> {
		const identity = identities[ticket as keyof typeof identities];
		if (identity === undefined) throw new Error('Unknown smoke identity.');
		return {
			identity,
			emailVerified: true,
			jti: `phase2-smoke-${ticket}`,
			issuedAt: new Date(now.getTime() - 1_000),
			expiresAt: new Date(now.getTime() + 90_000),
			protocolMajor: 1,
			protocolMinor: 2
		};
	}
}

function invariant(condition: unknown, label: string): asserts condition {
	if (!condition) throw new Error(`Phase 2 smoke assertion failed: ${label}.`);
}

function phase(number: number, label: string): void {
	process.stdout.write(`${number}. ${label}\n`);
}

function createContext(): SmokeContext {
	let entropy = 1;
	const inventoryUploads = new InventoryUploadManager();
	const roomDirectory = createRoomDirectoryWithEntropy(
		{ roomCapacity: 16, reconnectGraceMs: 60_000, chatBacklog: 200 },
		new BunPasswordHasher(),
		(length) => new Uint8Array(length).fill(entropy++),
		(inventory) => inventoryUploads.releaseCommitted(inventory)
	);
	return {
		application: new ArenaApplication({
			ticketVerifier: new SmokeTicketVerifier(),
			roomDirectory,
			now: () => NOW,
			newNonce: () => `heartbeat-${entropy++}`,
			newTransferId: () => new Uint8Array(16).fill(entropy++),
			inventoryUploadManager: inventoryUploads
		}),
		roomDirectory,
		deliveries: []
	};
}

function record(context: SmokeContext, deliveries: readonly Delivery[]): readonly Delivery[] {
	context.deliveries.push(...deliveries);
	return deliveries;
}

function messagesFor(deliveries: readonly Delivery[], connectionId: string): ServerMessage[] {
	return deliveries.flatMap((delivery) =>
		delivery.kind === 'send' && delivery.connectionIds.includes(connectionId)
			? [delivery.message]
			: []
	);
}

function messageFor<T extends ServerMessage['type']>(
	deliveries: readonly Delivery[],
	connectionId: string,
	type: T
): Extract<ServerMessage, { type: T }> {
	const message = messagesFor(deliveries, connectionId).find(
		(candidate) => candidate.type === type
	);
	invariant(message?.type === type, `${connectionId} receives ${type}`);
	return message as Extract<ServerMessage, { type: T }>;
}

function snapshotFor(deliveries: readonly Delivery[], connectionId: string): RoomSnapshot {
	const message = messageFor(deliveries, connectionId, 'room_snapshot');
	invariant('selection' in message.data, `${connectionId} receives a Phase 2 room snapshot`);
	return message.data;
}

function phase2RoomSnapshot(
	message: Extract<ServerMessage, { type: 'room_snapshot' }>
): RoomSnapshot {
	invariant('selection' in message.data, 'WebSocket room snapshot uses protocol 1.1');
	return message.data;
}

function binding(room: RoomSnapshot) {
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

function inventoryDeclaration(bytes: Uint8Array, libraryGeneration = 1) {
	return {
		libraryGeneration,
		hashCount: bytes.byteLength / 32,
		byteCount: bytes.byteLength,
		chunkCount: bytes.byteLength === 0 ? 0 : Math.ceil(bytes.byteLength / (2_047 * 32)),
		vectorDigest: createHash('sha256').update(bytes).digest('hex')
	};
}

async function receive(
	context: SmokeContext,
	connectionId: string,
	message: ClientMessage,
	nowMs: number
): Promise<readonly Delivery[]> {
	return record(context, await context.application.receive(connectionId, message, nowMs));
}

async function authenticate(
	context: SmokeContext,
	connectionId: keyof typeof identities
): Promise<void> {
	record(context, context.application.connect(connectionId));
	const deliveries = await receive(
		context,
		connectionId,
		{
			type: 'client_hello',
			data: {
				protocolMajor: 1,
				protocolMinor: 2,
				clientVersion: 'phase2-smoke',
				capabilities: ['rooms-v1', 'rounds-v1', 'competition-v1'],
				ticket: connectionId
			}
		},
		NOW
	);
	const hello = messageFor(deliveries, connectionId, 'server_hello');
	invariant(hello.data.protocolMinor === 2, `${connectionId} negotiates protocol 1.2`);
	invariant(
		hello.data.capabilities.includes('competition-v1'),
		`${connectionId} negotiates competition-v1`
	);
	invariant(
		hello.data.identity?.userId === identities[connectionId].userId,
		`${connectionId} identity`
	);
}

async function uploadInventory(
	context: SmokeContext,
	connectionId: 'alice' | 'bob',
	room: RoomSnapshot,
	values: readonly number[],
	inventoryIndex: number
): Promise<readonly Delivery[]> {
	const bytes = inventoryBytes(values);
	const declaration = inventoryDeclaration(bytes);
	const begun = await receive(
		context,
		connectionId,
		{
			type: 'inventory_upload_begin',
			requestId: `inventory-begin-${connectionId}`,
			data: { ...binding(room), ...declaration }
		},
		NOW + inventoryIndex
	);
	const ready = messageFor(begun, connectionId, 'inventory_upload_ready');
	const frame = encodeHashChunk({
		kind: 1,
		transferId: Uint8Array.from(Buffer.from(ready.data.uploadId, 'base64url')),
		chunkIndex: 0,
		hashes: bytes
	});
	record(
		context,
		await context.application.receiveBinary(connectionId, frame, NOW + inventoryIndex)
	);
	return receive(
		context,
		connectionId,
		{
			type: 'inventory_upload_commit',
			requestId: `inventory-commit-${connectionId}`,
			data: { ...binding(room), uploadId: ready.data.uploadId, ...declaration }
		},
		NOW + inventoryIndex
	);
}

function selection(hashValue: number, title: string, laneSeed: string): SelectionSnapshot {
	return {
		sha256: hashValue.toString(16).padStart(64, '0'),
		title,
		subtitle: '',
		artist: 'Arena smoke',
		keyMode: 14,
		randomSequence: [2, 1, 3],
		noteOrderP1: 's_random_plus',
		noteOrderP2: 'lr2_random_ex',
		dpMode: 'lr2_flip',
		laneSeed,
		randomizationVersion: 1
	};
}

function assertCommonReset(
	deliveries: readonly Delivery[],
	connectionId: 'alice' | 'bob',
	expectedValues: readonly number[]
): number {
	const begin = messageFor(deliveries, connectionId, 'availability_transfer_begin');
	invariant(begin.data.mode === 'reset', `${connectionId} receives common reset`);
	const frames = deliveries.filter(
		(delivery): delivery is Extract<Delivery, { kind: 'send_binary' }> =>
			delivery.kind === 'send_binary' && delivery.connectionIds.includes(connectionId)
	);
	invariant(frames.length === 1, `${connectionId} receives one common binary frame`);
	const decoded = decodeHashChunk(frames[0]!.bytes);
	invariant(decoded.kind === 2, `${connectionId} receives reset-kind binary`);
	invariant(
		Buffer.from(decoded.hashes).equals(Buffer.from(inventoryBytes(expectedValues))),
		`${connectionId} receives exact common hashes`
	);
	messageFor(deliveries, connectionId, 'availability_transfer_commit');
	return begin.data.targetRevision;
}

async function runSuccessfulRound(): Promise<void> {
	const context = createContext();

	record(context, context.application.connect('anonymous'));
	let deliveries = await receive(
		context,
		'anonymous',
		{
			type: 'client_hello',
			data: {
				protocolMajor: 1,
				protocolMinor: 0,
				clientVersion: 'phase2-smoke',
				capabilities: ['rooms-v1']
			}
		},
		NOW
	);
	invariant(
		messageFor(deliveries, 'anonymous', 'server_hello').data.protocolMinor === 0,
		'anonymous protocol minor'
	);
	deliveries = await receive(context, 'anonymous', { type: 'directory_subscribe', data: {} }, NOW);
	invariant(
		messageFor(deliveries, 'anonymous', 'directory_snapshot').data.rooms.length === 0,
		'empty anonymous directory'
	);
	phase(1, 'Anonymous protocol 1.0 browse');

	await authenticate(context, 'alice');
	await authenticate(context, 'bob');
	deliveries = await receive(
		context,
		'alice',
		{
			type: 'room_create',
			requestId: 'room-create',
			data: { name: 'Phase 2 password room', password: ROOM_PASSWORD }
		},
		NOW
	);
	const aliceRoom = snapshotFor(deliveries, 'alice');
	deliveries = await receive(
		context,
		'bob',
		{
			type: 'room_join',
			requestId: 'room-join',
			data: { roomId: aliceRoom.roomId, password: ROOM_PASSWORD }
		},
		NOW
	);
	const bobRoom = snapshotFor(deliveries, 'bob');
	invariant(bobRoom.hasPassword, 'password room admission');
	invariant(bobRoom.members.length === 2, 'two authenticated room seats');
	phase(2, 'Two authenticated seats join one password room');

	const aliceCommit = await uploadInventory(context, 'alice', aliceRoom, [1, 2, 3], 1);
	deliveries = await uploadInventory(context, 'bob', bobRoom, [2, 3, 4], 2);
	messageFor(aliceCommit, 'alice', 'inventory_committed');
	messageFor(deliveries, 'bob', 'inventory_committed');
	phase(3, 'Inventories {A,B,C} and {B,C,D} commit');

	const aliceAvailabilityRevision = assertCommonReset(deliveries, 'alice', [2, 3]);
	const bobAvailabilityRevision = assertCommonReset(deliveries, 'bob', [2, 3]);
	invariant(aliceAvailabilityRevision === bobAvailabilityRevision, 'shared availability revision');
	for (const [connectionId, room] of [
		['alice', aliceRoom],
		['bob', bobRoom]
	] as const) {
		await receive(
			context,
			connectionId,
			{
				type: 'availability_applied',
				requestId: `availability-${connectionId}`,
				data: {
					...binding(room),
					availabilityRevision: aliceAvailabilityRevision
				}
			},
			NOW + 3
		);
	}
	phase(4, 'Both clients apply and acknowledge common {B,C}');

	deliveries = await receive(
		context,
		'alice',
		{
			type: 'selection_set',
			requestId: 'selection-a',
			data: {
				...binding(aliceRoom),
				availabilityRevision: aliceAvailabilityRevision,
				inventoryRevision: 1,
				selection: selection(1, 'Chart A', '1111111111111111')
			}
		},
		NOW + 4
	);
	const rejected = messageFor(deliveries, 'alice', 'selection_rejected');
	invariant(rejected.data.reason === 'not_common', 'Chart A is rejected as non-common');
	if (rejected.data.reason === 'not_common') {
		invariant(
			rejected.data.missingMemberIds.includes(bobRoom.self.memberId),
			'Chart A identifies Bob as missing'
		);
	}
	invariant(
		!messagesFor(deliveries, 'alice').some((message) => message.type === 'selection_changed'),
		'rejected Chart A does not replace null selection'
	);
	phase(5, 'Non-common A is rejected and selection remains null');

	deliveries = await receive(
		context,
		'alice',
		{
			type: 'selection_set',
			requestId: 'selection-b',
			data: {
				...binding(aliceRoom),
				availabilityRevision: aliceAvailabilityRevision,
				inventoryRevision: 1,
				selection: selection(2, 'Chart B', '2222222222222222')
			}
		},
		NOW + 5
	);
	const selectedB = messageFor(deliveries, 'alice', 'selection_changed');
	invariant(selectedB.data.selection?.title === 'Chart B', 'Chart B accepted');
	deliveries = await receive(
		context,
		'bob',
		{
			type: 'selection_set',
			requestId: 'selection-c',
			data: {
				...binding(bobRoom),
				availabilityRevision: aliceAvailabilityRevision,
				inventoryRevision: 2,
				selection: selection(3, 'Chart C', '3333333333333333')
			}
		},
		NOW + 6
	);
	const selectedC = messageFor(deliveries, 'alice', 'selection_changed');
	invariant(selectedC.data.selection?.title === 'Chart C', 'Chart C is authoritative');
	invariant(
		selectedC.data.selectionRevision === selectedB.data.selectionRevision + 1,
		'selection acceptance order'
	);
	invariant(selectedC.data.selectedByMemberId === bobRoom.self.memberId, 'Bob selected Chart C');
	phase(6, 'Last accepted common selection is authoritative');

	const ready = async (
		connectionId: 'alice' | 'bob',
		room: RoomSnapshot,
		inventoryRevision: number
	) =>
		receive(
			context,
			connectionId,
			{
				type: 'ready_set',
				requestId: `ready-${connectionId}`,
				data: {
					...binding(room),
					ready: true,
					selectionRevision: selectedC.data.selectionRevision,
					availabilityRevision: aliceAvailabilityRevision,
					inventoryRevision
				}
			},
			NOW + 7
		);
	await ready('alice', aliceRoom, 1);
	deliveries = await ready('bob', bobRoom, 2);
	const frozen = messageFor(deliveries, 'alice', 'round_loading_started').data.round;
	invariant(frozen.selection.title === 'Chart C', 'frozen authoritative selection');
	invariant(frozen.participants.length === 2, 'two frozen participants');
	await authenticate(context, 'carol');
	const waitingDeliveries = await receive(
		context,
		'carol',
		{
			type: 'room_join',
			requestId: 'waiting-join',
			data: { roomId: aliceRoom.roomId, password: ROOM_PASSWORD }
		},
		NOW + 8
	);
	const waitingRoom = snapshotFor(waitingDeliveries, 'carol');
	invariant(waitingRoom.phase === 'loading', 'waiting join sees Loading');
	invariant(waitingRoom.members.at(-1)?.roundState === 'waiting', 'third seat is waiting');
	invariant(
		!frozen.participants.some((participant) => participant.memberId === waitingRoom.self.memberId),
		'waiting seat excluded from frozen roster'
	);
	phase(7, 'Ready freezes two players and excludes the loading-time join');

	const probes = new Map(
		(['alice', 'bob'] as const).map((connectionId) => [
			connectionId,
			messageFor(deliveries, connectionId, 'round_probe_requested')
		])
	);
	let loadDeliveries: readonly Delivery[] = [];
	for (const [index, connectionId] of (['alice', 'bob'] as const).entries()) {
		const room = connectionId === 'alice' ? aliceRoom : bobRoom;
		const probe = probes.get(connectionId)!;
		loadDeliveries = await receive(
			context,
			connectionId,
			{
				type: 'round_probe_result',
				requestId: `probe-${connectionId}`,
				data: {
					...binding(room),
					roundId: frozen.roundId,
					launchAttemptId: frozen.launchAttemptId,
					selectionRevision: frozen.selectionRevision,
					availabilityRevision: frozen.availabilityRevision,
					inventoryRevision: index + 1,
					nonce: probe.data.nonce,
					ok: true,
					sha256: frozen.selection.sha256
				}
			},
			NOW + 9
		);
	}
	for (const connectionId of ['alice', 'bob'] as const) {
		invariant(
			messagesFor(loadDeliveries, connectionId).some(
				(message) => message.type === 'round_load_requested'
			),
			`${connectionId} receives deterministic load request`
		);
	}
	phase(8, 'Exact probes and deterministic load barrier succeed');

	let scheduleDeliveries: readonly Delivery[] = [];
	for (const [index, connectionId] of (['alice', 'bob'] as const).entries()) {
		const room = connectionId === 'alice' ? aliceRoom : bobRoom;
		scheduleDeliveries = await receive(
			context,
			connectionId,
			{
				type: 'round_load_result',
				requestId: `load-${connectionId}`,
				data: {
					...binding(room),
					roundId: frozen.roundId,
					launchAttemptId: frozen.launchAttemptId,
					selectionRevision: frozen.selectionRevision,
					availabilityRevision: frozen.availabilityRevision,
					inventoryRevision: index + 1,
					ok: true,
					chartLengthMs: 120_000
				}
			},
			NOW + 10
		);
	}
	const schedules = (['alice', 'bob'] as const).map((connectionId) =>
		messageFor(scheduleDeliveries, connectionId, 'round_start_scheduled')
	);
	invariant(
		messagesFor(scheduleDeliveries, 'carol').every(
			(message) => message.type !== 'round_start_scheduled'
		),
		'waiting seat receives no schedule'
	);
	invariant(
		schedules[0]!.data.startAtServerMs === schedules[1]!.data.startAtServerMs,
		'participants share start deadline'
	);
	const playingDeliveries = record(
		context,
		context.application.sweep(schedules[0]!.data.startAtServerMs)
	);
	for (const connectionId of ['alice', 'bob', 'carol'] as const) {
		messageFor(playingDeliveries, connectionId, 'round_started');
	}
	invariant(context.roomDirectory.list().rooms[0]?.phase === 'playing', 'room enters Playing');
	invariant(
		context.application.sweep(schedules[0]!.data.startAtServerMs).length === 0,
		'playing transition occurs exactly once'
	);
	phase(9, 'Targeted schedules reach Playing');

	for (const delivery of context.deliveries) {
		if (delivery.kind !== 'send') continue;
		invariant(
			!forbiddenPhase3Types.has(delivery.message.type),
			'Phase 3 event absent from Phase 2 smoke'
		);
		serverMessageSchema.parse(delivery.message);
	}
}

async function runCancellationRound(): Promise<void> {
	const context = createContext();
	await authenticate(context, 'alice');
	let deliveries = await receive(
		context,
		'alice',
		{ type: 'room_create', requestId: 'cancel-room', data: { name: 'Cancel room' } },
		NOW
	);
	const room = snapshotFor(deliveries, 'alice');
	deliveries = await uploadInventory(context, 'alice', room, [2], 1);
	const availability = assertCommonReset(deliveries, 'alice', [2]);
	await receive(
		context,
		'alice',
		{
			type: 'availability_applied',
			requestId: 'cancel-availability',
			data: { ...binding(room), availabilityRevision: availability }
		},
		NOW + 2
	);
	deliveries = await receive(
		context,
		'alice',
		{
			type: 'selection_set',
			requestId: 'cancel-selection',
			data: {
				...binding(room),
				availabilityRevision: availability,
				inventoryRevision: 1,
				selection: selection(2, 'Cancellation chart', '4444444444444444')
			}
		},
		NOW + 3
	);
	const selected = messageFor(deliveries, 'alice', 'selection_changed');
	deliveries = await receive(
		context,
		'alice',
		{
			type: 'ready_set',
			requestId: 'cancel-ready',
			data: {
				...binding(room),
				ready: true,
				selectionRevision: selected.data.selectionRevision,
				availabilityRevision: availability,
				inventoryRevision: 1
			}
		},
		NOW + 4
	);
	const probe = messageFor(deliveries, 'alice', 'round_probe_requested');
	deliveries = await receive(
		context,
		'alice',
		{
			type: 'round_probe_result',
			requestId: 'cancel-probe',
			data: {
				...binding(room),
				roundId: probe.data.roundId,
				launchAttemptId: probe.data.launchAttemptId,
				selectionRevision: probe.data.selectionRevision,
				availabilityRevision: probe.data.availabilityRevision,
				inventoryRevision: probe.data.inventoryRevision,
				nonce: probe.data.nonce,
				ok: false,
				reason: 'hash_mismatch'
			}
		},
		NOW + 5
	);
	const cancelled = messageFor(deliveries, 'alice', 'round_launch_cancelled');
	invariant(cancelled.data.reason === 'hash_mismatch', 'hash mismatch cancellation reason');
	invariant(cancelled.data.selection === null, 'bad chart selection cleared');
	invariant(context.roomDirectory.list().rooms[0]?.phase === 'selecting', 'room returns Selecting');
	invariant(context.application.nextDeadlineMs() === undefined, 'cancelled launch has no deadline');
	phase(10, 'Hash mismatch cancels back to Selecting');
}

type WebSocketSmokeRuntime = Readonly<{
	application: ArenaApplication;
	roomDirectory: RoomDirectory;
	server: ArenaServerHandle;
	url: string;
}>;

function startWebSocketRuntime(jwksPort: number): WebSocketSmokeRuntime {
	const config = loadArenaConfig({
		HOST: '127.0.0.1',
		IR_JWKS_URL: `http://127.0.0.1:${jwksPort}/jwks`,
		IR_ISSUER: 'https://rhythmgame.eu',
		ARENA_AUDIENCE: 'https://arena.rhythmgame.eu',
		RECONNECT_GRACE_MS: '10000',
		ROOM_CAPACITY: '16',
		CHAT_BACKLOG: '200',
		INVENTORY_UPLOAD_TIMEOUT_MS: '60000',
		MAX_PENDING_INVENTORY_BYTES: '134217728',
		MAX_COMMITTED_INVENTORY_BYTES: '536870912'
	});
	const inventoryUploads = new InventoryUploadManager({
		uploadTimeoutMs: config.inventoryUploadTimeoutMs,
		maxPendingBytes: config.maxPendingInventoryBytes,
		maxCommittedBytes: config.maxCommittedInventoryBytes
	});
	const roomDirectory = createRoomDirectory(
		{
			roomCapacity: config.roomCapacity,
			reconnectGraceMs: config.reconnectGraceMs,
			chatBacklog: config.chatBacklog
		},
		new BunPasswordHasher(),
		(inventory) => inventoryUploads.releaseCommitted(inventory)
	);
	const application = new ArenaApplication({
		ticketVerifier: new JoseTicketVerifier(config),
		roomDirectory,
		now: Date.now,
		newNonce: () => crypto.randomUUID(),
		inventoryUploadManager: inventoryUploads
	});
	const server = startArenaServer({
		application,
		config,
		portOverride: 0,
		maintenanceIntervalMs: 25,
		logger: () => undefined
	});
	return {
		application,
		roomDirectory,
		server,
		url: `ws://127.0.0.1:${server.port}/ws`
	};
}

async function authenticatedWebSocketClient(
	clients: SmokeClient[],
	name: string,
	url: string,
	ticket: string
): Promise<SmokeClient> {
	const client = await SmokeClient.connect(name, url);
	clients.push(client);
	client.send({
		type: 'client_hello',
		data: {
			protocolMajor: 1,
			protocolMinor: 2,
			clientVersion: 'phase2-smoke',
			capabilities: ['rooms-v1', 'rounds-v1', 'competition-v1'],
			ticket
		}
	});
	const hello = await client.nextMessage('server_hello');
	invariant(hello.data.protocolMinor === 2, `${name} negotiates protocol 1.2`);
	invariant(
		hello.data.capabilities.includes('competition-v1'),
		`${name} negotiates competition-v1`
	);
	invariant(hello.data.identity !== undefined, `${name} receives authenticated identity`);
	return client;
}

async function uploadInventoryOverWebSocket(
	client: SmokeClient,
	room: RoomSnapshot,
	values: readonly number[],
	label: string
): Promise<number> {
	const bytes = inventoryBytes(values);
	const declaration = inventoryDeclaration(bytes);
	const beginRequestId = `ws-inventory-begin-${label}`;
	client.send({
		type: 'inventory_upload_begin',
		requestId: beginRequestId,
		data: { ...binding(room), ...declaration }
	});
	const ready = await client.nextMessage(
		'inventory_upload_ready',
		(message) => message.requestId === beginRequestId
	);
	invariant(ready.data.hashCount === declaration.hashCount, `${label} upload hash count`);
	invariant(ready.data.byteCount === declaration.byteCount, `${label} upload byte count`);
	invariant(ready.data.chunkCount === declaration.chunkCount, `${label} upload chunk count`);
	invariant(ready.data.vectorDigest === declaration.vectorDigest, `${label} upload digest`);
	invariant(ready.data.deadlineMs > Date.now(), `${label} upload deadline is future`);
	client.sendBinary(
		encodeHashChunk({
			kind: 1,
			transferId: Uint8Array.from(Buffer.from(ready.data.uploadId, 'base64url')),
			chunkIndex: 0,
			hashes: bytes
		})
	);
	const commitRequestId = `ws-inventory-commit-${label}`;
	client.send({
		type: 'inventory_upload_commit',
		requestId: commitRequestId,
		data: { ...binding(room), uploadId: ready.data.uploadId, ...declaration }
	});
	const committed = await client.nextMessage(
		'inventory_committed',
		(message) => message.requestId === commitRequestId
	);
	invariant(committed.data.libraryGeneration === 1, `${label} library generation`);
	invariant(committed.data.inventoryState === 'ready', `${label} inventory ready`);
	return committed.data.inventoryRevision;
}

async function receiveCommonResetOverWebSocket(
	client: SmokeClient,
	expectedValues: readonly number[],
	expectedBasis: readonly Readonly<{ memberId: string; inventoryRevision: number }>[],
	label: string
): Promise<number> {
	const begin = await client.nextMessage('availability_transfer_begin');
	invariant(begin.data.mode === 'reset', `${label} receives common reset`);
	if (begin.data.mode !== 'reset') throw new Error(`${label} did not receive a reset.`);
	const expectedBytes = inventoryBytes(expectedValues);
	invariant(begin.data.resetCount === expectedValues.length, `${label} reset count`);
	invariant(begin.data.resetChunkCount === 1, `${label} reset chunk count`);
	invariant(
		begin.data.resetDigest === createHash('sha256').update(expectedBytes).digest('hex'),
		`${label} reset digest`
	);
	invariant(
		JSON.stringify(begin.data.basis) === JSON.stringify(expectedBasis),
		`${label} exact availability basis`
	);
	const frame = decodeHashChunk(await client.nextBinary());
	invariant(frame.kind === 2, `${label} reset frame kind`);
	invariant(frame.chunkIndex === 0, `${label} reset frame chunk index`);
	invariant(
		Buffer.from(frame.transferId).equals(Buffer.from(begin.data.transferId, 'base64url')),
		`${label} reset transfer binding`
	);
	invariant(
		Buffer.from(frame.hashes).equals(Buffer.from(expectedBytes)),
		`${label} exact common vector`
	);
	const commit = await client.nextMessage(
		'availability_transfer_commit',
		(message) => message.data.transferId === begin.data.transferId
	);
	invariant(commit.data.targetRevision === begin.data.targetRevision, `${label} reset revision`);
	return begin.data.targetRevision;
}

function assertNoPhase3Messages(clients: readonly SmokeClient[]): void {
	for (const client of clients) {
		for (const message of client.observedMessages()) {
			invariant(
				!forbiddenPhase3Types.has(message.type),
				'Phase 3 event absent from WebSocket smoke'
			);
			serverMessageSchema.parse(message);
		}
	}
}

async function stopWebSocketRun(
	clients: readonly SmokeClient[],
	runtime: WebSocketSmokeRuntime | undefined
): Promise<void> {
	await Promise.all(clients.map((client) => client.stop()));
	if (runtime !== undefined) await runtime.server.shutdown({ drainMs: 0 });
}

async function runSuccessfulWebSocketRound(
	issuer: Awaited<ReturnType<typeof startLocalIssuer>>
): Promise<void> {
	const clients: SmokeClient[] = [];
	let runtime: WebSocketSmokeRuntime | undefined;
	try {
		const jwksPort = issuer.server.port;
		invariant(jwksPort !== undefined, 'local JWKS port');
		runtime = startWebSocketRuntime(jwksPort);

		const anonymous = await SmokeClient.connect('Phase 2 anonymous', runtime.url);
		clients.push(anonymous);
		anonymous.send({
			type: 'client_hello',
			data: {
				protocolMajor: 1,
				protocolMinor: 0,
				clientVersion: 'phase2-smoke',
				capabilities: ['rooms-v1']
			}
		});
		const anonymousHello = await anonymous.nextMessage('server_hello');
		invariant(anonymousHello.data.protocolMinor === 0, 'anonymous protocol 1.0 hello');
		invariant(anonymousHello.data.identity === undefined, 'anonymous identity absent');
		anonymous.send({ type: 'directory_subscribe', data: {} });
		const emptyDirectory = await anonymous.nextMessage('directory_snapshot');
		invariant(emptyDirectory.data.rooms.length === 0, 'anonymous empty directory');
		await anonymous.stop();
		phase(1, 'Anonymous protocol 1.0 browse');

		const [aliceTicket, bobTicket] = await Promise.all([
			issuer.issue(identities.alice),
			issuer.issue(identities.bob)
		]);
		const alice = await authenticatedWebSocketClient(
			clients,
			'Phase 2 Alice',
			runtime.url,
			aliceTicket
		);
		const bob = await authenticatedWebSocketClient(clients, 'Phase 2 Bob', runtime.url, bobTicket);
		alice.send({
			type: 'room_create',
			requestId: 'ws-room-create',
			data: { name: 'Phase 2 password room', password: ROOM_PASSWORD }
		});
		const aliceCreated = await alice.nextMessage(
			'room_snapshot',
			(message) => message.requestId === 'ws-room-create',
			10_000
		);
		const aliceRoom = phase2RoomSnapshot(aliceCreated);
		bob.send({
			type: 'room_join',
			requestId: 'ws-room-join',
			data: { roomId: aliceRoom.roomId, password: ROOM_PASSWORD }
		});
		const bobJoined = await bob.nextMessage(
			'room_snapshot',
			(message) => message.requestId === 'ws-room-join',
			10_000
		);
		const bobRoom = phase2RoomSnapshot(bobJoined);
		invariant(bobRoom.hasPassword, 'WebSocket password room');
		invariant(bobRoom.members.length === 2, 'WebSocket two-seat roster');
		phase(2, 'Two authenticated seats join one password room');

		const aliceInventoryRevision = await uploadInventoryOverWebSocket(
			alice,
			aliceRoom,
			[1, 2, 3],
			'alice'
		);
		const bobInventoryRevision = await uploadInventoryOverWebSocket(bob, bobRoom, [2, 3, 4], 'bob');
		invariant(aliceInventoryRevision === 1, 'Alice first inventory revision');
		invariant(bobInventoryRevision === 2, 'Bob second inventory revision');
		phase(3, 'Inventories {A,B,C} and {B,C,D} commit');

		const expectedParticipants = [
			{ memberId: aliceRoom.self.memberId, inventoryRevision: aliceInventoryRevision },
			{ memberId: bobRoom.self.memberId, inventoryRevision: bobInventoryRevision }
		];
		const expectedFrozenParticipants = [
			{ ...expectedParticipants[0]!, identity: identities.alice },
			{ ...expectedParticipants[1]!, identity: identities.bob }
		];
		const expectedBasis = [...expectedParticipants].sort((left, right) =>
			left.memberId.localeCompare(right.memberId)
		);
		const [aliceAvailabilityRevision, bobAvailabilityRevision] = await Promise.all([
			receiveCommonResetOverWebSocket(alice, [2, 3], expectedBasis, 'Alice'),
			receiveCommonResetOverWebSocket(bob, [2, 3], expectedBasis, 'Bob')
		]);
		invariant(
			aliceAvailabilityRevision === bobAvailabilityRevision,
			'WebSocket shared availability revision'
		);
		for (const [client, room, label] of [
			[alice, aliceRoom, 'alice'],
			[bob, bobRoom, 'bob']
		] as const) {
			client.send({
				type: 'availability_applied',
				requestId: `ws-availability-${label}`,
				data: { ...binding(room), availabilityRevision: aliceAvailabilityRevision }
			});
		}
		phase(4, 'Both clients apply and acknowledge common {B,C}');

		alice.send({
			type: 'selection_set',
			requestId: 'ws-selection-a',
			data: {
				...binding(aliceRoom),
				availabilityRevision: aliceAvailabilityRevision,
				inventoryRevision: aliceInventoryRevision,
				selection: selection(1, 'Chart A', '1111111111111111')
			}
		});
		const rejected = await alice.nextMessage(
			'selection_rejected',
			(message) => message.requestId === 'ws-selection-a'
		);
		invariant(rejected.data.reason === 'not_common', 'WebSocket Chart A rejection');
		if (rejected.data.reason === 'not_common') {
			invariant(
				rejected.data.missingMemberIds.includes(bobRoom.self.memberId),
				'Bob lacks Chart A'
			);
		}
		phase(5, 'Non-common A is rejected and selection remains null');

		alice.send({
			type: 'selection_set',
			requestId: 'ws-selection-b',
			data: {
				...binding(aliceRoom),
				availabilityRevision: aliceAvailabilityRevision,
				inventoryRevision: aliceInventoryRevision,
				selection: selection(2, 'Chart B', '2222222222222222')
			}
		});
		const [aliceSelectedB, bobSelectedB] = await Promise.all([
			alice.nextMessage(
				'selection_changed',
				(message) => message.data.selection?.title === 'Chart B'
			),
			bob.nextMessage('selection_changed', (message) => message.data.selection?.title === 'Chart B')
		]);
		invariant(aliceSelectedB.data.selectionRevision === 1, 'rejected A leaves revision zero');
		invariant(
			JSON.stringify(aliceSelectedB.data) === JSON.stringify(bobSelectedB.data),
			'Chart B broadcast equality'
		);
		bob.send({
			type: 'selection_set',
			requestId: 'ws-selection-c',
			data: {
				...binding(bobRoom),
				availabilityRevision: aliceAvailabilityRevision,
				inventoryRevision: bobInventoryRevision,
				selection: selection(3, 'Chart C', '3333333333333333')
			}
		});
		const [aliceSelectedC, bobSelectedC] = await Promise.all([
			alice.nextMessage(
				'selection_changed',
				(message) => message.data.selection?.title === 'Chart C'
			),
			bob.nextMessage('selection_changed', (message) => message.data.selection?.title === 'Chart C')
		]);
		invariant(aliceSelectedC.data.selectionRevision === 2, 'Chart C second accepted revision');
		invariant(
			aliceSelectedC.data.selectedByMemberId === bobRoom.self.memberId,
			'Bob selected authoritative Chart C'
		);
		invariant(
			JSON.stringify(aliceSelectedC.data) === JSON.stringify(bobSelectedC.data),
			'Chart C broadcast equality'
		);
		phase(6, 'Last accepted common selection is authoritative');

		alice.send({
			type: 'ready_set',
			requestId: 'ws-ready-alice',
			data: {
				...binding(aliceRoom),
				ready: true,
				selectionRevision: aliceSelectedC.data.selectionRevision,
				availabilityRevision: aliceAvailabilityRevision,
				inventoryRevision: aliceInventoryRevision
			}
		});
		bob.send({
			type: 'ready_set',
			requestId: 'ws-ready-bob',
			data: {
				...binding(bobRoom),
				ready: true,
				selectionRevision: aliceSelectedC.data.selectionRevision,
				availabilityRevision: aliceAvailabilityRevision,
				inventoryRevision: bobInventoryRevision
			}
		});
		const [aliceLoading, bobLoading, aliceProbe, bobProbe] = await Promise.all([
			alice.nextMessage('round_loading_started'),
			bob.nextMessage('round_loading_started'),
			alice.nextMessage('round_probe_requested'),
			bob.nextMessage('round_probe_requested')
		]);
		const frozen = aliceLoading.data.round;
		invariant(
			JSON.stringify(frozen) === JSON.stringify(bobLoading.data.round),
			'shared frozen round'
		);
		invariant(
			JSON.stringify(frozen.participants) === JSON.stringify(expectedFrozenParticipants),
			'exact frozen roster and inventory revisions'
		);
		invariant(aliceProbe.data.nonce !== bobProbe.data.nonce, 'unique per-seat probe nonces');
		for (const [probe, revision, memberId] of [
			[aliceProbe, aliceInventoryRevision, aliceRoom.self.memberId],
			[bobProbe, bobInventoryRevision, bobRoom.self.memberId]
		] as const) {
			invariant(probe.data.roundId === frozen.roundId, `${memberId} probe round binding`);
			invariant(probe.data.launchAttemptId === frozen.launchAttemptId, `${memberId} probe attempt`);
			invariant(probe.data.inventoryRevision === revision, `${memberId} probe inventory`);
			invariant(probe.data.sha256 === frozen.selection.sha256, `${memberId} probe hash`);
			invariant(probe.data.deadlineMs > Date.now() + 13_000, `${memberId} probe deadline`);
		}

		const carol = await authenticatedWebSocketClient(
			clients,
			'Phase 2 Carol',
			runtime.url,
			await issuer.issue(identities.carol)
		);
		carol.send({
			type: 'room_join',
			requestId: 'ws-waiting-join',
			data: { roomId: aliceRoom.roomId, password: ROOM_PASSWORD }
		});
		const waitingJoined = await carol.nextMessage(
			'room_snapshot',
			(message) => message.requestId === 'ws-waiting-join',
			10_000
		);
		const waitingRoom = phase2RoomSnapshot(waitingJoined);
		invariant(waitingRoom.phase === 'loading', 'waiting join sees Loading');
		invariant(waitingRoom.members.at(-1)?.roundState === 'waiting', 'third seat waits');
		invariant(
			!frozen.participants.some(
				(participant) => participant.memberId === waitingRoom.self.memberId
			),
			'waiting seat excluded from frozen roster'
		);
		phase(7, 'Ready freezes two players and excludes the loading-time join');

		for (const [client, room, probe, revision, label] of [
			[alice, aliceRoom, aliceProbe, aliceInventoryRevision, 'alice'],
			[bob, bobRoom, bobProbe, bobInventoryRevision, 'bob']
		] as const) {
			client.send({
				type: 'round_probe_result',
				requestId: `ws-probe-${label}`,
				data: {
					...binding(room),
					roundId: frozen.roundId,
					launchAttemptId: frozen.launchAttemptId,
					selectionRevision: frozen.selectionRevision,
					availabilityRevision: frozen.availabilityRevision,
					inventoryRevision: revision,
					nonce: probe.data.nonce,
					ok: true,
					sha256: frozen.selection.sha256
				}
			});
		}
		const [aliceLoad, bobLoad] = await Promise.all([
			alice.nextMessage('round_load_requested'),
			bob.nextMessage('round_load_requested')
		]);
		invariant(aliceLoad.data.round.stage === 'loading', 'Alice deterministic load stage');
		invariant(bobLoad.data.round.stage === 'loading', 'Bob deterministic load stage');
		invariant(
			JSON.stringify(aliceLoad.data.round) === JSON.stringify(bobLoad.data.round),
			'shared load basis'
		);
		phase(8, 'Exact probes and deterministic load barrier succeed');

		for (const [client, room, revision, label] of [
			[alice, aliceRoom, aliceInventoryRevision, 'alice'],
			[bob, bobRoom, bobInventoryRevision, 'bob']
		] as const) {
			client.send({
				type: 'round_load_result',
				requestId: `ws-load-${label}`,
				data: {
					...binding(room),
					roundId: frozen.roundId,
					launchAttemptId: frozen.launchAttemptId,
					selectionRevision: frozen.selectionRevision,
					availabilityRevision: frozen.availabilityRevision,
					inventoryRevision: revision,
					ok: true,
					chartLengthMs: 120_000
				}
			});
		}
		const [aliceSchedule, bobSchedule] = await Promise.all([
			alice.nextMessage('round_start_scheduled'),
			bob.nextMessage('round_start_scheduled')
		]);
		invariant(
			aliceSchedule.data.startAtServerMs === bobSchedule.data.startAtServerMs,
			'one common future start deadline'
		);
		for (const [schedule, label] of [
			[aliceSchedule, 'Alice'],
			[bobSchedule, 'Bob']
		] as const) {
			invariant(schedule.data.roundId === frozen.roundId, `${label} schedule round`);
			invariant(
				schedule.data.launchAttemptId === frozen.launchAttemptId,
				`${label} schedule attempt`
			);
			invariant(schedule.data.startAfterMs >= 1_900, `${label} compensated lead lower bound`);
			invariant(schedule.data.startAfterMs <= 5_000, `${label} compensated lead upper bound`);
			invariant(schedule.data.startAtServerMs > Date.now(), `${label} future start`);
		}
		invariant(
			!carol.observedMessages().some((message) => message.type === 'round_start_scheduled'),
			'waiting seat receives no schedule'
		);
		const [aliceStarted, bobStarted, carolStarted] = await Promise.all([
			alice.nextMessage('round_started', () => true, 6_000),
			bob.nextMessage('round_started', () => true, 6_000),
			carol.nextMessage('round_started', () => true, 6_000)
		]);
		for (const started of [aliceStarted, bobStarted, carolStarted]) {
			invariant(started.data.roundId === frozen.roundId, 'roomwide started round');
		}
		invariant(runtime.roomDirectory.list().rooms[0]?.phase === 'playing', 'room enters Playing');
		invariant(
			!carol.observedMessages().some((message) => message.type === 'round_load_requested'),
			'waiting seat receives no load request'
		);
		phase(9, 'Targeted schedules reach Playing');
		assertNoPhase3Messages(clients);
	} finally {
		await stopWebSocketRun(clients, runtime);
	}
}

async function runCancellationWebSocketRound(
	issuer: Awaited<ReturnType<typeof startLocalIssuer>>
): Promise<void> {
	const clients: SmokeClient[] = [];
	let runtime: WebSocketSmokeRuntime | undefined;
	try {
		const jwksPort = issuer.server.port;
		invariant(jwksPort !== undefined, 'local cancellation JWKS port');
		runtime = startWebSocketRuntime(jwksPort);
		const alice = await authenticatedWebSocketClient(
			clients,
			'Phase 2 cancellation Alice',
			runtime.url,
			await issuer.issue(identities.alice)
		);
		alice.send({
			type: 'room_create',
			requestId: 'ws-cancel-room',
			data: { name: 'Phase 2 cancellation room' }
		});
		const created = await alice.nextMessage(
			'room_snapshot',
			(message) => message.requestId === 'ws-cancel-room',
			10_000
		);
		const room = phase2RoomSnapshot(created);
		const inventoryRevision = await uploadInventoryOverWebSocket(alice, room, [2], 'cancel');
		const availabilityRevision = await receiveCommonResetOverWebSocket(
			alice,
			[2],
			[{ memberId: room.self.memberId, inventoryRevision }],
			'Cancellation Alice'
		);
		alice.send({
			type: 'availability_applied',
			requestId: 'ws-cancel-availability',
			data: { ...binding(room), availabilityRevision }
		});
		alice.send({
			type: 'selection_set',
			requestId: 'ws-cancel-selection',
			data: {
				...binding(room),
				availabilityRevision,
				inventoryRevision,
				selection: selection(2, 'Cancellation chart', '4444444444444444')
			}
		});
		const selected = await alice.nextMessage('selection_changed');
		alice.send({
			type: 'ready_set',
			requestId: 'ws-cancel-ready',
			data: {
				...binding(room),
				ready: true,
				selectionRevision: selected.data.selectionRevision,
				availabilityRevision,
				inventoryRevision
			}
		});
		await alice.nextMessage('round_loading_started');
		const probe = await alice.nextMessage('round_probe_requested');
		alice.send({
			type: 'round_probe_result',
			requestId: 'ws-cancel-probe',
			data: {
				...binding(room),
				roundId: probe.data.roundId,
				launchAttemptId: probe.data.launchAttemptId,
				selectionRevision: probe.data.selectionRevision,
				availabilityRevision: probe.data.availabilityRevision,
				inventoryRevision: probe.data.inventoryRevision,
				nonce: probe.data.nonce,
				ok: false,
				reason: 'hash_mismatch'
			}
		});
		const cancelled = await alice.nextMessage('round_launch_cancelled');
		invariant(cancelled.data.reason === 'hash_mismatch', 'WebSocket mismatch reason');
		invariant(cancelled.data.selection === null, 'WebSocket bad selection cleared');
		invariant(
			cancelled.data.selectionRevision === selected.data.selectionRevision + 1,
			'WebSocket cleared selection revision'
		);
		invariant(
			cancelled.data.availabilityRevision === availabilityRevision,
			'WebSocket availability survives cancellation'
		);
		invariant(
			runtime.roomDirectory.list().rooms[0]?.phase === 'selecting',
			'room returns Selecting'
		);
		invariant(runtime.application.nextDeadlineMs() === undefined, 'cancellation clears deadlines');
		invariant(
			alice.observedMessages().filter((message) => message.type === 'round_launch_cancelled')
				.length === 1,
			'one cancellation event'
		);
		phase(10, 'Hash mismatch cancels back to Selecting');
		assertNoPhase3Messages(clients);
	} finally {
		await stopWebSocketRun(clients, runtime);
	}
}

async function runLocalWebSocketSmoke(): Promise<void> {
	const issuer = await startLocalIssuer(2);
	try {
		await runSuccessfulWebSocketRound(issuer);
		await runCancellationWebSocketRound(issuer);
		process.stdout.write('Phase 2 Arena smoke passed through WebSocket/JOSE.\n');
	} finally {
		await issuer.server.stop(true);
	}
}

function validArenaUrl(raw: string): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error('Arena URL is invalid.');
	}
	const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);
	if (
		url.pathname !== '/ws' ||
		url.search !== '' ||
		url.hash !== '' ||
		url.username !== '' ||
		url.password !== '' ||
		(url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback.has(url.hostname)))
	) {
		throw new Error('Arena URL must use WSS or explicit loopback WS at the exact /ws path.');
	}
	return url;
}

async function runRemoteProtocolProbe(rawUrl: string): Promise<void> {
	const url = validArenaUrl(rawUrl);
	const socket = new WebSocket(url);
	const messages: ServerMessage[] = [];
	let resolveMessage!: () => void;
	let rejectMessage!: (error: Error) => void;
	const complete = new Promise<void>((resolve, reject) => {
		resolveMessage = resolve;
		rejectMessage = reject;
	});
	const timer = setTimeout(
		() => rejectMessage(new Error('Arena endpoint probe timed out.')),
		5_000
	);
	socket.addEventListener('open', () => {
		socket.send(
			JSON.stringify({
				type: 'client_hello',
				data: {
					protocolMajor: 1,
					protocolMinor: 0,
					clientVersion: 'phase2-smoke',
					capabilities: ['rooms-v1']
				}
			})
		);
	});
	socket.addEventListener('message', (event) => {
		if (typeof event.data !== 'string') return rejectMessage(new Error('Unexpected binary reply.'));
		let decoded: unknown;
		try {
			decoded = JSON.parse(event.data);
		} catch {
			return rejectMessage(new Error('Arena endpoint returned invalid JSON.'));
		}
		const parsed = serverMessageSchema.safeParse(decoded);
		if (!parsed.success) return rejectMessage(new Error('Invalid Arena server message.'));
		messages.push(parsed.data);
		if (parsed.data.type === 'server_hello') {
			socket.send(JSON.stringify({ type: 'directory_subscribe', data: {} }));
		} else if (parsed.data.type === 'directory_snapshot') {
			resolveMessage();
		}
	});
	socket.addEventListener('error', () => rejectMessage(new Error('Arena endpoint probe failed.')));
	try {
		await complete;
		invariant(
			messages.some((message) => message.type === 'server_hello'),
			'remote hello'
		);
		invariant(
			messages.some((message) => message.type === 'directory_snapshot'),
			'remote directory'
		);
		process.stdout.write('Remote Arena protocol probe passed.\n');
	} finally {
		clearTimeout(timer);
		socket.close();
	}
}

async function main(): Promise<void> {
	const args = Bun.argv.slice(2);
	if (args.length === 0) {
		await runLocalWebSocketSmoke();
		return;
	}
	if (args.length === 1) {
		await runRemoteProtocolProbe(args[0]!);
		return;
	}
	throw new Error('Usage: phase2-smoke.ts [wss://host/ws]');
}

if (import.meta.main) await main();
