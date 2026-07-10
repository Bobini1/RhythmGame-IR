import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { ArenaApplication } from '../../src/application/arena-application.ts';
import type { ArenaIdentity, VerifiedArenaTicket } from '../../src/auth/identity.ts';
import type { TicketVerifier } from '../../src/auth/ticket-verifier.ts';
import { loadArenaConfig } from '../../src/config.ts';
import { encodeHashChunk } from '../../src/protocol/binary.ts';
import type { ClientMessage, ServerMessage } from '../../src/protocol/messages.ts';
import { createRoomDirectory } from '../../src/rooms/room-directory.ts';
import {
	startArenaServer,
	type ArenaLogger,
	type ArenaServerHandle
} from '../../src/transport/start-server.ts';
import { FakePasswordHasher } from '../helpers/fake-password-hasher.ts';

type ClientEvent =
	| Readonly<{ event: 'opened' }>
	| Readonly<{ event: 'message'; message: ServerMessage }>
	| Readonly<{ event: 'closed'; code: number; reason: string }>
	| Readonly<{ event: 'error'; code: string }>
	| Readonly<{ event: 'process_exit' }>;

type EventWaiter = {
	readonly accepts: (event: ClientEvent) => boolean;
	readonly resolve: (event: ClientEvent) => void;
	readonly reject: (error: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
};

const helperPath = path.join(import.meta.dir, '..', 'helpers', 'arena-ws-client.ts');
const alice: ArenaIdentity = { userId: 'alice', displayName: 'Alice', avatarUrl: null };
const bob: ArenaIdentity = { userId: 'bob', displayName: 'Bob', avatarUrl: null };
let handle: ArenaServerHandle | undefined;
const clients: SplitProcessClient[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) await client.stop();
	await handle?.shutdown({ drainMs: 0 });
	handle = undefined;
});

class SplitProcessClient {
	readonly #process: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
	readonly #events: ClientEvent[] = [];
	readonly #waiters: EventWaiter[] = [];
	#stopping = false;

	private constructor(process: Bun.Subprocess<'pipe', 'pipe', 'pipe'>) {
		this.#process = process;
		void this.#pump();
		void Bun.readableStreamToText(process.stderr);
	}

	static async connect(url: string): Promise<SplitProcessClient> {
		const process = Bun.spawn([processExecPath(), helperPath], {
			stdin: 'pipe',
			stdout: 'pipe',
			stderr: 'pipe',
			cwd: import.meta.dir
		});
		const client = new SplitProcessClient(process);
		clients.push(client);
		client.#write({ command: 'connect', url });
		await client.#next((event) => event.event === 'opened', 'opened');
		return client;
	}

	send(message: ClientMessage): void {
		this.#write({ command: 'send', message });
	}

	sendRaw(text: string): void {
		this.#write({ command: 'send_raw', text });
	}

	sendBinary(bytes: readonly number[]): void {
		this.#write({ command: 'send_binary', bytes });
	}

	close(): void {
		this.#write({ command: 'close' });
	}

	async nextAnyMessage(): Promise<ServerMessage> {
		const event = await this.#next((candidate) => candidate.event === 'message', 'server message');
		if (event.event !== 'message') throw new Error('Expected a server message.');
		return event.message;
	}

	async nextMessage<T extends ServerMessage['type']>(
		type: T
	): Promise<Extract<ServerMessage, { type: T }>> {
		const event = await this.#next(
			(candidate) => candidate.event === 'message' && candidate.message.type === type,
			type
		);
		if (event.event !== 'message' || event.message.type !== type) {
			throw new Error(`Expected ${type}.`);
		}
		return event.message as Extract<ServerMessage, { type: T }>;
	}

	async closed(): Promise<Readonly<{ code: number; reason: string }>> {
		const event = await this.#next((candidate) => candidate.event === 'closed', 'socket close');
		if (event.event !== 'closed') throw new Error('Expected socket close.');
		return { code: event.code, reason: event.reason };
	}

	async stop(): Promise<void> {
		if (this.#stopping) return;
		this.#stopping = true;
		if (this.#process.exitCode === null) {
			this.#write({ command: 'exit' });
			this.#process.stdin.end();
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					this.#process.exited,
					new Promise<never>((_, reject) => {
						timer = setTimeout(() => reject(new Error('Client process did not exit.')), 2_000);
					})
				]);
			} catch {
				this.#process.kill();
				await this.#process.exited;
			} finally {
				if (timer !== undefined) clearTimeout(timer);
			}
		}
		for (const waiter of this.#waiters.splice(0)) {
			clearTimeout(waiter.timer);
			waiter.reject(new Error('Client process stopped.'));
		}
	}

	#write(command: unknown): void {
		if (this.#process.exitCode !== null) throw new Error('Client process has exited.');
		this.#process.stdin.write(`${JSON.stringify(command)}\n`);
		this.#process.stdin.flush();
	}

	async #pump(): Promise<void> {
		const decoder = new TextDecoder();
		let buffered = '';
		for await (const chunk of this.#process.stdout) {
			buffered += decoder.decode(chunk, { stream: true });
			for (;;) {
				const newline = buffered.indexOf('\n');
				if (newline < 0) break;
				const line = buffered.slice(0, newline);
				buffered = buffered.slice(newline + 1);
				try {
					this.#push(JSON.parse(line) as ClientEvent);
				} catch {
					this.#push({ event: 'error', code: 'invalid_helper_output' });
				}
			}
		}
		this.#push({ event: 'process_exit' });
	}

	#push(event: ClientEvent): void {
		const waiterIndex = this.#waiters.findIndex((waiter) => waiter.accepts(event));
		if (waiterIndex < 0) {
			this.#events.push(event);
			return;
		}
		const [waiter] = this.#waiters.splice(waiterIndex, 1);
		if (waiter === undefined) return;
		clearTimeout(waiter.timer);
		waiter.resolve(event);
	}

	#next(accepts: (event: ClientEvent) => boolean, label: string): Promise<ClientEvent> {
		const eventIndex = this.#events.findIndex(accepts);
		if (eventIndex >= 0) return Promise.resolve(this.#events.splice(eventIndex, 1)[0]!);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				const index = this.#waiters.findIndex((waiter) => waiter.timer === timer);
				if (index >= 0) this.#waiters.splice(index, 1);
				reject(new Error(`Timed out waiting for ${label}; only event types are retained.`));
			}, 3_000);
			this.#waiters.push({ accepts, resolve, reject, timer });
		});
	}
}

function processExecPath(): string {
	return process.execPath;
}

class TestTicketVerifier implements TicketVerifier {
	readonly calls: string[] = [];

	async verify(ticket: string, now: Date): Promise<VerifiedArenaTicket> {
		this.calls.push(ticket);
		return verifiedTicket(ticket.startsWith('bob') ? bob : alice, ticket, now);
	}
}

class DeferredTicketVerifier implements TicketVerifier {
	readonly started: Promise<void>;
	#markStarted!: () => void;
	#release!: () => void;
	readonly #released: Promise<void>;

	constructor() {
		this.started = new Promise((resolve) => {
			this.#markStarted = resolve;
		});
		this.#released = new Promise((resolve) => {
			this.#release = resolve;
		});
	}

	release(): void {
		this.#release();
	}

	async verify(ticket: string, now: Date): Promise<VerifiedArenaTicket> {
		this.#markStarted();
		await this.#released;
		return verifiedTicket(alice, ticket, now);
	}
}

function verifiedTicket(identity: ArenaIdentity, ticket: string, now: Date): VerifiedArenaTicket {
	return {
		identity,
		emailVerified: true,
		jti: `jti-${ticket}`,
		issuedAt: new Date(now.getTime() - 1_000),
		expiresAt: new Date(now.getTime() + 89_000),
		protocolMajor: 1,
		protocolMinor: 2
	};
}

function startTestServer(
	verifier: TicketVerifier = new TestTicketVerifier(),
	environment: Record<string, string | undefined> = {},
	logger?: ArenaLogger
): ArenaServerHandle {
	return startArenaServer({
		application: new ArenaApplication({
			ticketVerifier: verifier,
			roomDirectory: createRoomDirectory(
				{ roomCapacity: 16, reconnectGraceMs: 60_000, chatBacklog: 200 },
				new FakePasswordHasher()
			),
			now: Date.now,
			newNonce: () => crypto.randomUUID()
		}),
		config: loadArenaConfig({ HOST: '127.0.0.1', ...environment }),
		portOverride: 0,
		maintenanceIntervalMs: 60_000,
		...(logger === undefined ? {} : { logger })
	});
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for ${label}.`);
}

function clientHello(ticket?: string): ClientMessage {
	const authenticated = ticket !== undefined;
	return {
		type: 'client_hello',
		data: {
			protocolMajor: 1,
			protocolMinor: authenticated ? 2 : 0,
			clientVersion: 'test',
			capabilities: authenticated ? ['rooms-v1', 'rounds-v1', 'competition-v1'] : ['rooms-v1'],
			...(ticket === undefined ? {} : { ticket })
		}
	};
}

async function authenticatedClient(url: string, ticket: string): Promise<SplitProcessClient> {
	const client = await SplitProcessClient.connect(url);
	client.send(clientHello(ticket));
	await client.nextMessage('server_hello');
	return client;
}

describe('Arena WebSocket gateway', () => {
	test('honors forwarded clients only through a configured trusted proxy network', async () => {
		handle = startTestServer(new TestTicketVerifier(), {
			TRUSTED_PROXY_CIDRS: '127.0.0.0/8',
			UPGRADE_ATTEMPTS_PER_ADDRESS_PER_MINUTE: '1'
		});
		const request = (forwardedFor: string) =>
			fetch(`http://127.0.0.1:${handle!.port}/ws`, {
				headers: { 'X-Forwarded-For': forwardedFor }
			});

		expect((await request('198.51.100.1')).status).toBe(426);
		expect((await request('198.51.100.1')).status).toBe(429);
		expect((await request('198.51.100.2')).status).toBe(426);
	});

	test.skipIf(process.platform === 'win32')(
		'policy-closes an incomplete hello and releases its global lease',
		async () => {
			handle = startTestServer(new TestTicketVerifier(), {
				CLIENT_HELLO_TIMEOUT_MS: '1000',
				MAX_CONNECTIONS: '1'
			});
			const client = await SplitProcessClient.connect(`ws://127.0.0.1:${handle.port}/ws`);

			expect(await client.closed()).toEqual({ code: 1008, reason: 'hello_timeout' });
			expect((await fetch(`http://127.0.0.1:${handle.port}/ws`)).status).toBe(426);
		}
	);

	test('returns HTTP 503 before allocating application state over the connection cap', async () => {
		handle = startTestServer(new TestTicketVerifier(), { MAX_CONNECTIONS: '1' });
		const client = await SplitProcessClient.connect(`ws://127.0.0.1:${handle.port}/ws`);
		expect((await fetch(`http://127.0.0.1:${handle.port}/healthz`)).status).toBe(200);
		const capped = await fetch(`http://127.0.0.1:${handle.port}/ws`);
		expect(capped.status).toBe(503);
		client.close();
		await client.closed();
		const released = await fetch(`http://127.0.0.1:${handle.port}/ws`);
		expect(released.status).toBe(426);
	});

	test('never logs ticket, identity, room, chat, telemetry, or result payloads', async () => {
		const captured: unknown[] = [];
		handle = startTestServer(new TestTicketVerifier(), {}, (level, event, fields) =>
			captured.push({ level, event, fields })
		);
		const client = await authenticatedClient(
			`ws://127.0.0.1:${handle.port}/ws`,
			'alice-SENTINEL-CREDENTIAL'
		);
		client.send({
			type: 'room_create',
			requestId: 'privacy-create',
			data: { name: 'SENTINEL-ROOM' }
		});
		const snapshot = await client.nextMessage('room_snapshot');
		if (!('selection' in snapshot.data)) throw new Error('competition snapshot missing');
		const binding = {
			roomId: snapshot.data.roomId,
			roomGeneration: snapshot.data.roomGeneration,
			connectionGeneration: snapshot.data.self.connectionGeneration
		};
		client.send({
			type: 'round_telemetry',
			data: {
				...binding,
				roundId: 'SENTINEL-ROUND-ID',
				launchAttemptId: 'SENTINEL-ATTEMPT-ID',
				telemetry: {
					sequence: 1,
					exScore: 2_468,
					progressPermille: 500,
					maxCombo: 1_234,
					badPoorCount: 0,
					judgements: { perfect: 1_234, great: 0, good: 0, bad: 0, poor: 0, emptyPoor: 0 },
					gauge: { type: 'normal', valueMilli: 54_321 },
					playStatus: 'playing'
				}
			}
		});
		client.send({
			type: 'round_result_submit',
			requestId: 'privacy-result',
			data: {
				...binding,
				roundId: 'SENTINEL-ROUND-ID',
				launchAttemptId: 'SENTINEL-ATTEMPT-ID',
				result: {
					exScore: 2_468,
					maxCombo: 1_234,
					badPoorCount: 0,
					judgements: { perfect: 1_234, great: 0, good: 0, bad: 0, poor: 0, emptyPoor: 0 },
					clearType: 'normal',
					finalGauge: { type: 'normal', valueMilli: 54_321 }
				}
			}
		});
		await client.nextMessage('command_error');
		client.send({
			type: 'chat_send',
			requestId: 'privacy-chat',
			data: { ...binding, text: 'SENTINEL-CHAT' }
		});
		await client.nextMessage('chat_message');
		client.close();
		await client.closed();
		await handle.shutdown({ drainMs: 0 });
		handle = undefined;
		const encoded = JSON.stringify(captured);
		for (const sentinel of [
			'SENTINEL-CREDENTIAL',
			'SENTINEL-ROOM',
			'SENTINEL-CHAT',
			'SENTINEL-ROUND-ID',
			'2468',
			'54321',
			'Alice'
		]) {
			expect(encoded).not.toContain(sentinel);
		}
	});

	test('upgrades the exact path and serializes anonymous hello before directory state', async () => {
		handle = startTestServer();
		const client = await SplitProcessClient.connect(`ws://127.0.0.1:${handle.port}/ws`);

		client.send(clientHello());
		expect(await client.nextMessage('server_hello')).toEqual(
			expect.objectContaining({ type: 'server_hello' })
		);

		client.send({ type: 'directory_subscribe', data: {} });
		expect(await client.nextMessage('directory_snapshot')).toEqual({
			type: 'directory_snapshot',
			data: { revision: 0, rooms: [] }
		});
	});

	test('keeps frames behind a slow authenticated hello ordered on that socket', async () => {
		const verifier = new DeferredTicketVerifier();
		handle = startTestServer(verifier);
		const client = await SplitProcessClient.connect(`ws://127.0.0.1:${handle.port}/ws`);
		client.send(clientHello('alice-slow'));
		client.send({ type: 'directory_subscribe', data: {} });
		await verifier.started;
		verifier.release();

		expect((await client.nextAnyMessage()).type).toBe('server_hello');
		expect((await client.nextAnyMessage()).type).toBe('directory_snapshot');
	});

	test('settles the receive tail and quarantines the socket when internal cleanup fails', async () => {
		let receiveCalls = 0;
		const events: string[] = [];
		const failingApplication = {
			connect: () => [],
			receive: async () => {
				receiveCalls += 1;
				throw new Error('sentinel receive failure');
			},
			disconnect: () => {
				throw new Error('sentinel cleanup failure');
			},
			sweep: () => [],
			nextDeadlineMs: () => undefined,
			shutdown: () => []
		} as unknown as ArenaApplication;
		handle = startArenaServer({
			application: failingApplication,
			config: loadArenaConfig({ HOST: '127.0.0.1' }),
			portOverride: 0,
			maintenanceIntervalMs: 60_000,
			logger: (_level, event) => events.push(event)
		});
		const client = await SplitProcessClient.connect(`ws://127.0.0.1:${handle.port}/ws`);

		client.send({ type: 'directory_subscribe', data: {} });
		await waitFor(() => receiveCalls === 1, 'first failed receive');
		client.send({ type: 'directory_subscribe', data: {} });
		await Bun.sleep(100);

		expect(receiveCalls).toBe(1);
		expect(events).toContain('websocket_receive_failed');
		expect(events).toContain('websocket_internal_cleanup_failed');
	});

	test.skipIf(process.platform === 'win32')(
		'policy-closes the 33rd queued frame while ticket verification is blocked',
		async () => {
			const verifier = new DeferredTicketVerifier();
			handle = startTestServer(verifier);
			const client = await SplitProcessClient.connect(`ws://127.0.0.1:${handle.port}/ws`);
			client.send(clientHello('alice-slow-flood'));
			await verifier.started;
			for (let frame = 0; frame < 32; frame += 1) {
				client.send({ type: 'directory_subscribe', data: {} });
			}
			const closed = await client.closed();
			expect(closed).toEqual({ code: 1008, reason: 'rate_limited' });
			verifier.release();
		}
	);

	test('supports password create/join, ordered chat, kick, and explicit leave for two clients', async () => {
		handle = startTestServer();
		const url = `ws://127.0.0.1:${handle.port}/ws`;
		const owner = await authenticatedClient(url, 'alice-ticket');
		owner.send({ type: 'directory_subscribe', data: {} });
		await owner.nextMessage('directory_snapshot');
		owner.send({
			type: 'room_create',
			requestId: 'create-1',
			data: { name: 'Private room', password: 'sentinel-password' }
		});
		const ownerRoom = await owner.nextMessage('room_snapshot');
		await owner.nextMessage('room_directory_updated');

		const guest = await authenticatedClient(url, 'bob-ticket');
		guest.send({
			type: 'room_join',
			requestId: 'join-1',
			data: { roomId: ownerRoom.data.roomId, password: 'sentinel-password' }
		});
		const guestRoom = await guest.nextMessage('room_snapshot');
		expect((await owner.nextMessage('room_member_joined')).data.member.memberId).toBe(
			guestRoom.data.self.memberId
		);
		await owner.nextMessage('room_directory_updated');

		guest.send({
			type: 'chat_send',
			requestId: 'chat-1',
			data: {
				roomId: guestRoom.data.roomId,
				roomGeneration: guestRoom.data.roomGeneration,
				connectionGeneration: guestRoom.data.self.connectionGeneration,
				text: 'hello from guest'
			}
		});
		expect((await guest.nextMessage('chat_message')).data.message.text).toBe('hello from guest');
		expect((await owner.nextMessage('chat_message')).data.message.text).toBe('hello from guest');

		owner.send({
			type: 'room_kick',
			requestId: 'kick-1',
			data: {
				roomId: ownerRoom.data.roomId,
				roomGeneration: ownerRoom.data.roomGeneration,
				connectionGeneration: ownerRoom.data.self.connectionGeneration,
				targetMemberId: guestRoom.data.self.memberId
			}
		});
		expect((await guest.nextMessage('room_member_left')).data.reason).toBe('kicked');
		expect((await owner.nextMessage('room_member_left')).data.reason).toBe('kicked');
		await owner.nextMessage('room_directory_updated');

		guest.send({
			type: 'chat_send',
			requestId: 'chat-after-kick',
			data: {
				roomId: guestRoom.data.roomId,
				roomGeneration: guestRoom.data.roomGeneration,
				connectionGeneration: guestRoom.data.self.connectionGeneration,
				text: 'blocked'
			}
		});
		expect((await guest.nextMessage('command_error')).data.code).toBe('not_in_room');

		owner.send({
			type: 'room_leave',
			requestId: 'leave-1',
			data: {
				roomId: ownerRoom.data.roomId,
				roomGeneration: ownerRoom.data.roomGeneration,
				connectionGeneration: ownerRoom.data.self.connectionGeneration
			}
		});
		expect((await owner.nextMessage('room_member_left')).data.reason).toBe('left');
		expect((await owner.nextMessage('room_directory_updated')).data.removedRoomIds).toEqual([
			ownerRoom.data.roomId
		]);
	});

	test('resumes a closed seat with a fresh ticket and rotated token', async () => {
		handle = startTestServer();
		const url = `ws://127.0.0.1:${handle.port}/ws`;
		const browser = await SplitProcessClient.connect(url);
		browser.send(clientHello());
		await browser.nextMessage('server_hello');
		browser.send({ type: 'directory_subscribe', data: {} });
		await browser.nextMessage('directory_snapshot');

		const original = await authenticatedClient(url, 'alice-ticket-1');
		original.send({
			type: 'room_create',
			requestId: 'create-resume',
			data: { name: 'Resume room' }
		});
		const room = await original.nextMessage('room_snapshot');
		await browser.nextMessage('room_directory_updated');
		original.close();
		await original.closed();
		const reserved = await browser.nextMessage('room_directory_updated');
		expect(reserved.data.upserts[0]).toEqual(
			expect.objectContaining({ connectedCount: 0, reservedCount: 1 })
		);

		const resumed = await SplitProcessClient.connect(url);
		resumed.send({
			type: 'client_hello',
			data: {
				protocolMajor: 1,
				protocolMinor: 2,
				clientVersion: 'test',
				capabilities: ['rooms-v1', 'rounds-v1', 'competition-v1'],
				ticket: 'alice-ticket-2',
				resume: { roomId: room.data.roomId, seatToken: room.data.self.resumeToken }
			}
		});
		const hello = await resumed.nextMessage('server_hello');
		expect(hello.data.resume.status).toBe('succeeded');
		if (hello.data.resume.status !== 'succeeded') return;
		expect(hello.data.resume.room.self.resumeToken).not.toBe(room.data.self.resumeToken);
		expect(hello.data.resume.room.self.connectionGeneration).toBe(2);
		await browser.nextMessage('room_directory_updated');

		resumed.send({
			type: 'chat_send',
			requestId: 'chat-resumed',
			data: {
				roomId: hello.data.resume.room.roomId,
				roomGeneration: hello.data.resume.room.roomGeneration,
				connectionGeneration: hello.data.resume.room.self.connectionGeneration,
				text: 'resumed'
			}
		});
		expect((await resumed.nextMessage('chat_message')).data.message.text).toBe('resumed');
	});

	test.skipIf(process.platform === 'win32')(
		'rejects binary frames with a stable fatal close',
		async () => {
			handle = startTestServer();
			const url = `ws://127.0.0.1:${handle.port}/ws`;
			const binary = await SplitProcessClient.connect(url);
			binary.sendBinary([1, 2, 3]);
			expect((await binary.nextMessage('fatal_error')).data.code).toBe('unexpected_binary');
			expect(await binary.closed()).toEqual({ code: 1003, reason: 'unexpected_binary' });
		}
	);

	test('runs one real text/binary Arena round on the exact deadline timer', async () => {
		handle = startTestServer();
		const client = await authenticatedClient(
			`ws://127.0.0.1:${handle.port}/ws`,
			'alice-round-ticket'
		);
		client.send({
			type: 'room_create',
			requestId: 'round-create',
			data: { name: 'Round' }
		});
		const snapshot = await client.nextMessage('room_snapshot');
		if (!('selection' in snapshot.data)) throw new Error('Phase 2 snapshot missing');
		const binding = {
			roomId: snapshot.data.roomId,
			roomGeneration: snapshot.data.roomGeneration,
			connectionGeneration: snapshot.data.self.connectionGeneration
		};
		const bytes = new Uint8Array(32);
		new DataView(bytes.buffer).setUint32(28, 2, false);
		const declaration = {
			libraryGeneration: 1,
			hashCount: 1,
			byteCount: 32,
			chunkCount: 1,
			vectorDigest: createHash('sha256').update(bytes).digest('hex')
		};
		client.send({
			type: 'inventory_upload_begin',
			requestId: 'round-begin',
			data: { ...binding, ...declaration }
		});
		const upload = await client.nextMessage('inventory_upload_ready');
		client.sendBinary([
			...encodeHashChunk({
				kind: 1,
				transferId: Uint8Array.from(Buffer.from(upload.data.uploadId, 'base64url')),
				chunkIndex: 0,
				hashes: bytes
			})
		]);
		client.send({
			type: 'inventory_upload_commit',
			requestId: 'round-commit',
			data: { ...binding, uploadId: upload.data.uploadId, ...declaration }
		});
		await client.nextMessage('inventory_committed');
		const common = await client.nextMessage('availability_transfer_begin');
		await client.nextMessage('availability_transfer_commit');
		client.send({
			type: 'availability_applied',
			requestId: 'round-ack',
			data: { ...binding, availabilityRevision: common.data.targetRevision }
		});
		const selectedChart = {
			sha256: '2'.padStart(64, '0'),
			title: 'Round chart',
			subtitle: '',
			artist: 'Artist',
			keyMode: 7 as const,
			randomSequence: [1],
			noteOrderP1: 'random' as const,
			noteOrderP2: 'mirror' as const,
			dpMode: 'off' as const,
			laneSeed: '0123456789abcdef',
			randomizationVersion: 1 as const
		};
		client.send({
			type: 'selection_set',
			requestId: 'round-select',
			data: {
				...binding,
				availabilityRevision: common.data.targetRevision,
				inventoryRevision: 1,
				selection: selectedChart
			}
		});
		const selected = await client.nextMessage('selection_changed');
		client.send({
			type: 'ready_set',
			requestId: 'round-ready',
			data: {
				...binding,
				ready: true,
				selectionRevision: selected.data.selectionRevision,
				availabilityRevision: common.data.targetRevision,
				inventoryRevision: 1
			}
		});
		const probe = await client.nextMessage('round_probe_requested');
		client.send({
			type: 'round_probe_result',
			requestId: 'round-probe',
			data: {
				...binding,
				roundId: probe.data.roundId,
				launchAttemptId: probe.data.launchAttemptId,
				selectionRevision: probe.data.selectionRevision,
				availabilityRevision: probe.data.availabilityRevision,
				inventoryRevision: probe.data.inventoryRevision,
				nonce: probe.data.nonce,
				ok: true,
				sha256: probe.data.sha256
			}
		});
		await client.nextMessage('round_load_requested');
		client.send({
			type: 'round_load_result',
			requestId: 'round-load',
			data: {
				...binding,
				roundId: probe.data.roundId,
				launchAttemptId: probe.data.launchAttemptId,
				selectionRevision: probe.data.selectionRevision,
				availabilityRevision: probe.data.availabilityRevision,
				inventoryRevision: probe.data.inventoryRevision,
				ok: true,
				chartLengthMs: 120_000
			}
		});
		const scheduled = await client.nextMessage('round_start_scheduled');
		expect(scheduled.data.startAfterMs).toBeGreaterThanOrEqual(1_999);
		expect((await client.nextMessage('round_started')).data.roundId).toBe(probe.data.roundId);
		await client.nextMessage('round_standings');
		client.send({
			type: 'round_telemetry',
			data: {
				...binding,
				roundId: probe.data.roundId,
				launchAttemptId: probe.data.launchAttemptId,
				telemetry: {
					sequence: 1,
					exScore: 20,
					progressPermille: 500,
					maxCombo: 10,
					badPoorCount: 0,
					judgements: { perfect: 10, great: 0, good: 0, bad: 0, poor: 0, emptyPoor: 0 },
					gauge: { type: 'normal', valueMilli: 50_000 },
					playStatus: 'playing'
				}
			}
		});
		expect((await client.nextMessage('round_standings')).data.entries[0]).toEqual(
			expect.objectContaining({ rank: 1, competitionState: 'playing' })
		);
		client.send({
			type: 'round_result_submit',
			requestId: 'round-final',
			data: {
				...binding,
				roundId: probe.data.roundId,
				launchAttemptId: probe.data.launchAttemptId,
				result: {
					exScore: 20,
					maxCombo: 10,
					badPoorCount: 0,
					judgements: { perfect: 10, great: 0, good: 0, bad: 0, poor: 0, emptyPoor: 0 },
					clearType: 'normal',
					finalGauge: { type: 'normal', valueMilli: 60_000 }
				}
			}
		});
		expect((await client.nextMessage('round_terminal_accepted')).requestId).toBe('round-final');
		const finalized = await client.nextMessage('round_finalized');
		expect(finalized.data.result.winnerMemberIds).toEqual([snapshot.data.self.memberId]);
		expect(finalized.data.members[0]?.lobbyWins).toBe(0);
	});

	test('accepts an exactly 64 KiB valid text frame', async () => {
		handle = startTestServer();
		const url = `ws://127.0.0.1:${handle.port}/ws`;
		const exact = await SplitProcessClient.connect(url);
		const encodedHello = JSON.stringify(clientHello());
		exact.sendRaw(
			`${encodedHello}${' '.repeat(65_536 - new TextEncoder().encode(encodedHello).length)}`
		);
		expect((await exact.nextMessage('server_hello')).type).toBe('server_hello');
	});

	test.skipIf(process.platform === 'win32')(
		'closes an oversized text frame without requiring a structured response',
		async () => {
			handle = startTestServer();
			const url = `ws://127.0.0.1:${handle.port}/ws`;
			const oversized = await SplitProcessClient.connect(url);
			const encodedHello = JSON.stringify(clientHello());
			const oversizedFrame = `${encodedHello}${' '.repeat(
				65_537 - new TextEncoder().encode(encodedHello).length
			)}`;
			oversized.sendRaw(oversizedFrame);
			expect([1009, 1006]).toContain((await oversized.closed()).code);
		}
	);

	test.skipIf(process.platform === 'win32')(
		'sends going-away and closes active sockets on idempotent shutdown',
		async () => {
			handle = startTestServer();
			const client = await SplitProcessClient.connect(`ws://127.0.0.1:${handle.port}/ws`);
			client.send(clientHello());
			await client.nextMessage('server_hello');
			const goingAway = client.nextMessage('server_going_away');
			const closed = client.closed();

			const first = handle.shutdown({ drainMs: 50 });
			const second = handle.shutdown({ drainMs: 0 });
			expect(second).toBe(first);
			expect((await goingAway).data.displayMessageKey).toBe('arena.serverGoingAway');
			expect(await closed).toEqual({ code: 1012, reason: 'server_restart' });
			await first;
		}
	);

	test('shutdown is idempotent', async () => {
		handle = startTestServer();
		const first = handle.shutdown({ drainMs: 0 });
		const second = handle.shutdown({ drainMs: 0 });
		expect(second).toBe(first);
		await first;
	});
});
