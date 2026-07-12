import path from 'node:path';

import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { ArenaApplication } from '../src/application/arena-application.ts';
import { JoseTicketVerifier } from '../src/auth/jose-ticket-verifier.ts';
import { loadArenaConfig } from '../src/config.ts';
import {
	serverMessageSchema,
	type ClientMessage,
	type ServerMessage
} from '../src/protocol/messages.ts';
import { BunPasswordHasher } from '../src/rooms/bun-password-hasher.ts';
import { createRoomDirectory } from '../src/rooms/room-directory.ts';
import { startArenaServer, type ArenaServerHandle } from '../src/transport/start-server.ts';

type ClientEvent =
	| Readonly<{ event: 'opened' }>
	| Readonly<{ event: 'message'; message: ServerMessage }>
	| Readonly<{ event: 'binary'; bytes: readonly number[] }>
	| Readonly<{ event: 'closed'; code: number; reason: string }>
	| Readonly<{ event: 'error'; code: string }>
	| Readonly<{ event: 'process_exit' }>;
type EventWaiter = {
	readonly accepts: (event: ClientEvent) => boolean;
	readonly resolve: (event: ClientEvent) => void;
	readonly reject: (error: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
};
export type SmokeIdentity = Readonly<{ userId: string; displayName: string }>;

const ISSUER = 'https://rhythmgame.eu';
const AUDIENCE = 'https://arena.rhythmgame.eu';
const SMOKE_PASSWORD = 'phase1-smoke-password';
const SMOKE_CHAT = '<b>literal</b> & text';
const helperPath = path.join(import.meta.dir, '..', 'tests', 'helpers', 'arena-ws-client.ts');

function invariant(condition: unknown, label: string): asserts condition {
	if (!condition) throw new Error(`Phase 1 smoke assertion failed: ${label}.`);
}

function phase(number: number, label: string): void {
	process.stdout.write(`${number}. ${label}\n`);
}

export class SmokeClient {
	readonly #name: string;
	readonly #process: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
	readonly #events: ClientEvent[] = [];
	readonly #waiters: EventWaiter[] = [];
	readonly #observedMessages: ServerMessage[] = [];
	#stopping = false;

	private constructor(name: string, process: Bun.Subprocess<'pipe', 'pipe', 'pipe'>) {
		this.#name = name;
		this.#process = process;
		void this.#pump().catch(() => this.#push({ event: 'error', code: 'helper_read_failed' }));
		void Bun.readableStreamToText(process.stderr).catch(() => undefined);
	}

	static async connect(name: string, url: string): Promise<SmokeClient> {
		const subprocess = Bun.spawn([process.execPath, helperPath], {
			stdin: 'pipe',
			stdout: 'pipe',
			stderr: 'pipe',
			cwd: import.meta.dir
		});
		const client = new SmokeClient(name, subprocess);
		try {
			client.#write({ command: 'connect', url });
			await client.#next((event) => event.event === 'opened', 'socket open');
			return client;
		} catch (error) {
			await client.stop();
			throw error;
		}
	}

	send(message: ClientMessage): void {
		this.#write({ command: 'send', message });
	}

	sendBinary(bytes: Uint8Array): void {
		this.#write({ command: 'send_binary', bytes: [...bytes] });
	}

	close(): void {
		this.#write({ command: 'close' });
	}

	async nextMessage<T extends ServerMessage['type']>(
		type: T,
		accepts: (message: Extract<ServerMessage, { type: T }>) => boolean = () => true,
		timeoutMs = 10_000
	): Promise<Extract<ServerMessage, { type: T }>> {
		const event = await this.#next(
			(candidate) =>
				candidate.event === 'message' &&
				candidate.message.type === type &&
				accepts(candidate.message as Extract<ServerMessage, { type: T }>),
			type,
			timeoutMs
		);
		if (event.event !== 'message' || event.message.type !== type) {
			throw new Error(`${this.#name} did not receive ${type}.`);
		}
		return event.message as Extract<ServerMessage, { type: T }>;
	}

	async closed(timeoutMs = 3_000): Promise<Readonly<{ code: number; reason: string }>> {
		const event = await this.#next(
			(candidate) => candidate.event === 'closed',
			'socket close',
			timeoutMs
		);
		if (event.event !== 'closed') throw new Error(`${this.#name} did not close.`);
		return { code: event.code, reason: event.reason };
	}

	async nextBinary(timeoutMs = 3_000): Promise<Uint8Array> {
		const event = await this.#next(
			(candidate) => candidate.event === 'binary',
			'server binary frame',
			timeoutMs
		);
		if (event.event !== 'binary') throw new Error(`${this.#name} did not receive binary data.`);
		return Uint8Array.from(event.bytes);
	}

	observedMessages(): readonly ServerMessage[] {
		return this.#observedMessages;
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
						timer = setTimeout(() => reject(new Error('Smoke client did not exit.')), 2_000);
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
			waiter.reject(new Error(`${this.#name} stopped.`));
		}
	}

	#write(command: unknown): void {
		if (this.#process.exitCode !== null) throw new Error(`${this.#name} process exited.`);
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
					const value = JSON.parse(line) as unknown;
					if (
						typeof value === 'object' &&
						value !== null &&
						(value as { event?: unknown }).event === 'message'
					) {
						const message = serverMessageSchema.safeParse((value as { message?: unknown }).message);
						this.#push(
							message.success
								? { event: 'message', message: message.data }
								: { event: 'error', code: 'invalid_server_message' }
						);
					} else {
						this.#push(value as ClientEvent);
					}
				} catch {
					this.#push({ event: 'error', code: 'invalid_helper_output' });
				}
			}
		}
		this.#push({ event: 'process_exit' });
	}

	#push(event: ClientEvent): void {
		if (event.event === 'error') {
			for (const waiter of this.#waiters.splice(0)) {
				clearTimeout(waiter.timer);
				waiter.reject(new Error(`${this.#name} WebSocket helper failed with ${event.code}.`));
			}
			return;
		}
		if (event.event === 'message') this.#observedMessages.push(event.message);
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

	#next(
		accepts: (event: ClientEvent) => boolean,
		label: string,
		timeoutMs = 3_000
	): Promise<ClientEvent> {
		const eventIndex = this.#events.findIndex(accepts);
		if (eventIndex >= 0) return Promise.resolve(this.#events.splice(eventIndex, 1)[0]!);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				const index = this.#waiters.findIndex((waiter) => waiter.timer === timer);
				if (index >= 0) this.#waiters.splice(index, 1);
				const queuedTypes = this.#events.map((event) => {
					if (event.event !== 'message') return event.event;
					if (event.message.type !== 'command_error') return event.message.type;
					return `${event.message.type}:${event.message.requestId}:${event.message.data.code}`;
				});
				reject(
					new Error(
						`${this.#name} timed out waiting for ${label}; queued: ${queuedTypes.join(',') || 'none'}.`
					)
				);
			}, timeoutMs);
			this.#waiters.push({ accepts, resolve, reject, timer });
		});
	}
}

function hello(
	ticket?: string,
	resume?: Readonly<{ roomId: string; seatToken: string }>
): ClientMessage {
	return {
		type: 'client_hello',
		data: {
			protocolMajor: 1,
			protocolMinor: 0,
			clientVersion: 'phase1-smoke',
			capabilities:
				ticket === undefined ? ['rooms-v1'] : ['rooms-v1', 'rounds-v1', 'competition-v1'],
			...(ticket === undefined ? {} : { ticket }),
			...(resume === undefined ? {} : { resume })
		}
	};
}

function roomSummaryMatches(
	message: Extract<ServerMessage, { type: 'directory_snapshot' | 'room_directory_updated' }>,
	roomId: string,
	connectedCount: number,
	reservedCount: number
): boolean {
	const rooms = message.type === 'directory_snapshot' ? message.data.rooms : message.data.upserts;
	return rooms.some(
		(room) =>
			room.roomId === roomId &&
			room.connectedCount === connectedCount &&
			room.reservedCount === reservedCount &&
			room.maxCount === 32
	);
}

function validAnonymousUrl(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error('Anonymous Arena URL is invalid.');
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
		throw new Error('Anonymous Arena URL must use WSS or explicit loopback WS at /ws.');
	}
	return url.toString();
}

async function runAnonymousSmoke(rawUrl: string): Promise<void> {
	const client = await SmokeClient.connect('anonymous probe', validAnonymousUrl(rawUrl));
	try {
		client.send(hello());
		const serverHello = await client.nextMessage('server_hello');
		invariant(serverHello.data.identity === undefined, 'anonymous hello has no identity');
		client.send({ type: 'directory_subscribe', data: {} });
		await client.nextMessage('directory_snapshot');
		process.stdout.write('Anonymous Arena smoke passed.\n');
	} finally {
		await client.stop();
	}
}

export async function startLocalIssuer(protocolMinor = 0): Promise<
	Readonly<{
		server: Bun.Server<undefined>;
		issue(identity: SmokeIdentity): Promise<string>;
	}>
> {
	const keyPair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
	const exported = await exportJWK(keyPair.publicKey);
	invariant(
		typeof exported.kty === 'string' &&
			typeof exported.crv === 'string' &&
			typeof exported.x === 'string',
		'local public JWK fields'
	);
	const publicJwk = {
		kid: 'phase1-smoke-key',
		kty: exported.kty,
		crv: exported.crv,
		x: exported.x,
		alg: 'EdDSA',
		use: 'sig'
	};
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			if (request.method !== 'GET' || url.pathname !== '/jwks' || url.search !== '') {
				return new Response(null, { status: 404 });
			}
			return Response.json({ keys: [publicJwk] }, { headers: { 'Cache-Control': 'no-store' } });
		}
	});
	return {
		server,
		async issue(identity: SmokeIdentity): Promise<string> {
			const nowSeconds = Math.floor(Date.now() / 1_000);
			return new SignJWT({
				name: identity.displayName,
				picture: null,
				emailVerified: true,
				purpose: 'arena-connect',
				protocolMajor: 1,
				protocolMinor,
				jti: crypto.randomUUID()
			})
				.setProtectedHeader({ alg: 'EdDSA', kid: 'phase1-smoke-key', typ: 'JWT' })
				.setIssuer(ISSUER)
				.setAudience(AUDIENCE)
				.setSubject(identity.userId)
				.setIssuedAt(nowSeconds)
				.setExpirationTime(nowSeconds + 90)
				.sign(keyPair.privateKey);
		}
	};
}

async function authenticatedClient(
	clients: SmokeClient[],
	name: string,
	url: string,
	ticket: string,
	resume?: Readonly<{ roomId: string; seatToken: string }>
): Promise<
	Readonly<{
		client: SmokeClient;
		hello: Extract<ServerMessage, { type: 'server_hello' }>;
	}>
> {
	const client = await SmokeClient.connect(name, url);
	clients.push(client);
	client.send(hello(ticket, resume));
	return { client, hello: await client.nextMessage('server_hello') };
}

async function runLocalSmoke(): Promise<void> {
	const aliceIdentity = { userId: 'phase1-alice', displayName: 'Alice' } as const;
	const bobIdentity = { userId: 'phase1-bob', displayName: 'Bob' } as const;
	const clients: SmokeClient[] = [];
	let issuer: Awaited<ReturnType<typeof startLocalIssuer>> | undefined;
	let arena: ArenaServerHandle | undefined;
	let arenaStopped = false;
	try {
		issuer = await startLocalIssuer(2);
		const jwksPort = issuer.server.port;
		invariant(jwksPort !== undefined, 'local JWKS port');
		const config = loadArenaConfig({
			HOST: '127.0.0.1',
			IR_JWKS_URL: `http://127.0.0.1:${jwksPort}/jwks`,
			IR_ISSUER: ISSUER,
			ARENA_AUDIENCE: AUDIENCE,
			RECONNECT_GRACE_MS: '10000',
			ROOM_CAPACITY: '32',
			CHAT_BACKLOG: '200'
		});
		const directory = createRoomDirectory(
			{
				roomCapacity: config.roomCapacity,
				reconnectGraceMs: config.reconnectGraceMs,
				chatBacklog: config.chatBacklog
			},
			new BunPasswordHasher()
		);
		const application = new ArenaApplication({
			ticketVerifier: new JoseTicketVerifier(config),
			roomDirectory: directory,
			now: Date.now,
			newNonce: () => crypto.randomUUID()
		});
		arena = startArenaServer({
			application,
			config,
			portOverride: 0,
			maintenanceIntervalMs: 50,
			logger: () => undefined
		});
		const url = `ws://127.0.0.1:${arena.port}/ws`;

		const anonymousAlice = await SmokeClient.connect('Alice anonymous', url);
		clients.push(anonymousAlice);
		anonymousAlice.send(hello());
		const anonymousHello = await anonymousAlice.nextMessage('server_hello');
		invariant(anonymousHello.data.identity === undefined, 'anonymous hello identity');
		anonymousAlice.send({ type: 'directory_subscribe', data: {} });
		const emptyDirectory = await anonymousAlice.nextMessage('directory_snapshot');
		invariant(emptyDirectory.data.revision === 0, 'initial directory revision');
		invariant(emptyDirectory.data.rooms.length === 0, 'initial empty directory');
		anonymousAlice.send({
			type: 'room_create',
			requestId: 'anonymous-create',
			data: { name: 'Blocked anonymous room' }
		});
		const anonymousError = await anonymousAlice.nextMessage(
			'command_error',
			(message) => message.requestId === 'anonymous-create'
		);
		invariant(anonymousError.data.code === 'auth_required', 'anonymous mutation gate');
		await anonymousAlice.stop();

		const legacy = await SmokeClient.connect('Authenticated protocol 1.0', url);
		clients.push(legacy);
		legacy.send(
			hello(await issuer.issue({ userId: 'phase1-legacy', displayName: 'Legacy player' }))
		);
		const legacyHello = await legacy.nextMessage('server_hello');
		invariant(legacyHello.data.protocolMinor === 0, 'authenticated legacy protocol minor');
		invariant(
			legacyHello.data.identity?.userId === 'phase1-legacy',
			'authenticated legacy identity'
		);
		legacy.send({
			type: 'room_create',
			requestId: 'legacy-create',
			data: { name: 'Blocked legacy room' }
		});
		const legacyError = await legacy.nextMessage(
			'command_error',
			(message) => message.requestId === 'legacy-create'
		);
		invariant(
			legacyError.data.code === 'competition_capability_required',
			'authenticated protocol 1.0 mutation gate'
		);
		await legacy.stop();
		phase(1, 'Anonymous and authenticated protocol 1.0 browse gates');

		const aliceAdmission = await authenticatedClient(
			clients,
			'Alice',
			url,
			await issuer.issue(aliceIdentity)
		);
		const alice = aliceAdmission.client;
		invariant(
			aliceAdmission.hello.data.identity?.userId === aliceIdentity.userId,
			'Alice identity'
		);
		alice.send({ type: 'directory_subscribe', data: {} });
		await alice.nextMessage('directory_snapshot');
		alice.send({
			type: 'room_create',
			requestId: 'create-first-room',
			data: { name: 'Phase 1 password room', password: SMOKE_PASSWORD }
		});
		const firstAliceRoom = await alice.nextMessage(
			'room_snapshot',
			(message) => message.requestId === 'create-first-room'
		);
		await alice.nextMessage('room_directory_updated', (message) =>
			roomSummaryMatches(message, firstAliceRoom.data.roomId, 1, 0)
		);
		const bobAdmission = await authenticatedClient(
			clients,
			'Bob',
			url,
			await issuer.issue(bobIdentity)
		);
		const bob = bobAdmission.client;
		bob.send({ type: 'directory_subscribe', data: {} });
		const bobDirectory = await bob.nextMessage('directory_snapshot', (message) =>
			roomSummaryMatches(message, firstAliceRoom.data.roomId, 1, 0)
		);
		const firstSummary = bobDirectory.data.rooms.find(
			(room) => room.roomId === firstAliceRoom.data.roomId
		);
		invariant(firstSummary?.hasPassword === true, 'password room badge');
		invariant(
			firstSummary?.members.length === 1 &&
				firstSummary.members[0]?.displayName === 'Alice' &&
				firstSummary.members[0]?.avatarUrl === null &&
				firstSummary.members[0]?.connected === true,
			'public summary has the complete public roster'
		);
		invariant(!('chat' in (firstSummary ?? {})), 'public summary has no chat');
		phase(2, 'Password room creation and discovery');

		bob.send({
			type: 'room_join',
			requestId: 'wrong-password',
			data: { roomId: firstAliceRoom.data.roomId, password: 'wrong-smoke-password' }
		});
		const wrongPassword = await bob.nextMessage(
			'command_error',
			(message) => message.requestId === 'wrong-password'
		);
		invariant(wrongPassword.data.code === 'room_password_invalid', 'wrong password code');
		bob.send({ type: 'directory_subscribe', data: {} });
		await bob.nextMessage('directory_snapshot', (message) =>
			roomSummaryMatches(message, firstAliceRoom.data.roomId, 1, 0)
		);
		phase(3, 'Wrong password is recoverable');

		bob.send({
			type: 'room_join',
			requestId: 'join-first-room',
			data: { roomId: firstAliceRoom.data.roomId, password: SMOKE_PASSWORD }
		});
		const firstBobRoom = await bob.nextMessage(
			'room_snapshot',
			(message) => message.requestId === 'join-first-room'
		);
		const bobJoined = await alice.nextMessage(
			'room_member_joined',
			(message) => message.data.member.memberId === firstBobRoom.data.self.memberId
		);
		invariant(bobJoined.data.member.identity.userId === bobIdentity.userId, 'joined Bob identity');
		invariant(
			firstBobRoom.data.ownerMemberId === firstAliceRoom.data.self.memberId,
			'Alice owns room'
		);
		invariant(firstBobRoom.data.members.length === 2, 'two-member private roster');
		invariant(
			!JSON.stringify(firstBobRoom).includes(firstAliceRoom.data.self.resumeToken),
			'private snapshot contains only receiving token'
		);
		await alice.nextMessage('room_directory_updated', (message) =>
			roomSummaryMatches(message, firstAliceRoom.data.roomId, 2, 0)
		);
		await bob.nextMessage('room_directory_updated', (message) =>
			roomSummaryMatches(message, firstAliceRoom.data.roomId, 2, 0)
		);
		phase(4, 'Correct join and roster');

		bob.send({
			type: 'chat_send',
			requestId: 'literal-chat',
			data: {
				roomId: firstBobRoom.data.roomId,
				roomGeneration: firstBobRoom.data.roomGeneration,
				connectionGeneration: firstBobRoom.data.self.connectionGeneration,
				text: SMOKE_CHAT
			}
		});
		const aliceChat = await alice.nextMessage('chat_message');
		const bobChat = await bob.nextMessage('chat_message');
		invariant(
			aliceChat.data.message.messageId === bobChat.data.message.messageId,
			'shared chat ID'
		);
		invariant(
			aliceChat.data.message.authorMemberId === firstBobRoom.data.self.memberId,
			'chat author'
		);
		invariant(aliceChat.data.message.text === SMOKE_CHAT, 'literal chat body');
		invariant(
			aliceChat.data.message.sentAtMs === bobChat.data.message.sentAtMs,
			'shared chat time'
		);
		phase(5, 'Plain chat reaches both clients');

		bob.send({
			type: 'room_kick',
			requestId: 'non-owner-kick',
			data: {
				roomId: firstBobRoom.data.roomId,
				roomGeneration: firstBobRoom.data.roomGeneration,
				connectionGeneration: firstBobRoom.data.self.connectionGeneration,
				targetMemberId: firstAliceRoom.data.self.memberId
			}
		});
		const deniedKick = await bob.nextMessage(
			'command_error',
			(message) => message.requestId === 'non-owner-kick'
		);
		invariant(deniedKick.data.code === 'permission_denied', 'non-owner kick denial');
		bob.send({
			type: 'chat_send',
			requestId: 'post-denial-chat',
			data: {
				roomId: firstBobRoom.data.roomId,
				roomGeneration: firstBobRoom.data.roomGeneration,
				connectionGeneration: firstBobRoom.data.self.connectionGeneration,
				text: 'post-denial binding check'
			}
		});
		await alice.nextMessage('chat_message');
		await bob.nextMessage('chat_message');
		phase(6, 'Non-owner moderation fails safely');

		alice.send({
			type: 'room_kick',
			requestId: 'owner-kick',
			data: {
				roomId: firstAliceRoom.data.roomId,
				roomGeneration: firstAliceRoom.data.roomGeneration,
				connectionGeneration: firstAliceRoom.data.self.connectionGeneration,
				targetMemberId: firstBobRoom.data.self.memberId
			}
		});
		const aliceKick = await alice.nextMessage(
			'room_member_left',
			(message) => message.data.memberId === firstBobRoom.data.self.memberId
		);
		const bobKick = await bob.nextMessage(
			'room_member_left',
			(message) => message.data.memberId === firstBobRoom.data.self.memberId
		);
		invariant(
			aliceKick.data.reason === 'kicked' && bobKick.data.reason === 'kicked',
			'kick reason'
		);
		await alice.nextMessage('room_directory_updated', (message) =>
			roomSummaryMatches(message, firstAliceRoom.data.roomId, 1, 0)
		);
		await bob.nextMessage('room_directory_updated', (message) =>
			roomSummaryMatches(message, firstAliceRoom.data.roomId, 1, 0)
		);
		bob.send({
			type: 'room_join',
			requestId: 'banned-rejoin',
			data: { roomId: firstAliceRoom.data.roomId, password: SMOKE_PASSWORD }
		});
		const banned = await bob.nextMessage(
			'command_error',
			(message) => message.requestId === 'banned-rejoin'
		);
		invariant(banned.data.code === 'room_banned', 'room-lifetime ban');
		alice.send({
			type: 'room_leave',
			requestId: 'leave-first-room',
			data: {
				roomId: firstAliceRoom.data.roomId,
				roomGeneration: firstAliceRoom.data.roomGeneration,
				connectionGeneration: firstAliceRoom.data.self.connectionGeneration
			}
		});
		await alice.nextMessage(
			'room_member_left',
			(message) => message.data.memberId === firstAliceRoom.data.self.memberId
		);
		await alice.nextMessage('room_directory_updated', (message) =>
			message.data.removedRoomIds.includes(firstAliceRoom.data.roomId)
		);
		await bob.nextMessage('room_directory_updated', (message) =>
			message.data.removedRoomIds.includes(firstAliceRoom.data.roomId)
		);
		phase(7, 'Owner kick and room-lifetime ban');

		alice.send({
			type: 'room_create',
			requestId: 'create-resume-room',
			data: { name: 'Phase 1 resume room', password: SMOKE_PASSWORD }
		});
		const secondAliceRoom = await alice.nextMessage(
			'room_snapshot',
			(message) => message.requestId === 'create-resume-room'
		);
		await alice.nextMessage('room_directory_updated', (message) =>
			roomSummaryMatches(message, secondAliceRoom.data.roomId, 1, 0)
		);
		await bob.nextMessage('room_directory_updated', (message) =>
			roomSummaryMatches(message, secondAliceRoom.data.roomId, 1, 0)
		);
		bob.send({
			type: 'room_join',
			requestId: 'join-resume-room',
			data: { roomId: secondAliceRoom.data.roomId, password: SMOKE_PASSWORD }
		});
		const secondBobRoom = await bob.nextMessage(
			'room_snapshot',
			(message) => message.requestId === 'join-resume-room'
		);
		await alice.nextMessage(
			'room_member_joined',
			(message) => message.data.member.memberId === secondBobRoom.data.self.memberId
		);
		await alice.nextMessage('room_directory_updated', (message) =>
			roomSummaryMatches(message, secondAliceRoom.data.roomId, 2, 0)
		);
		await bob.nextMessage('room_directory_updated', (message) =>
			roomSummaryMatches(message, secondAliceRoom.data.roomId, 2, 0)
		);
		alice.close();
		await alice.closed();
		await bob.nextMessage(
			'room_member_updated',
			(message) =>
				message.data.member.memberId === secondAliceRoom.data.self.memberId &&
				message.data.member.status === 'reserved'
		);
		const ownerTransfer = await bob.nextMessage('room_owner_changed');
		invariant(
			ownerTransfer.data.ownerMemberId === secondBobRoom.data.self.memberId,
			'owner transfer'
		);
		await bob.nextMessage('room_directory_updated', (message) =>
			roomSummaryMatches(message, secondAliceRoom.data.roomId, 1, 1)
		);
		const resumedAdmission = await authenticatedClient(
			clients,
			'Alice resumed',
			url,
			await issuer.issue(aliceIdentity),
			{
				roomId: secondAliceRoom.data.roomId,
				seatToken: secondAliceRoom.data.self.resumeToken
			}
		);
		const resumedAlice = resumedAdmission.client;
		invariant(resumedAdmission.hello.data.resume.status === 'succeeded', 'resume success');
		if (resumedAdmission.hello.data.resume.status !== 'succeeded') {
			throw new Error('Phase 1 smoke resume state narrowed unexpectedly.');
		}
		const resumedRoom = resumedAdmission.hello.data.resume.room;
		invariant(
			resumedRoom.self.connectionGeneration === secondAliceRoom.data.self.connectionGeneration + 1,
			'resume connection generation'
		);
		invariant(
			resumedRoom.self.resumeToken !== secondAliceRoom.data.self.resumeToken,
			'resume token rotation'
		);
		invariant(resumedRoom.ownerMemberId === secondBobRoom.data.self.memberId, 'owner retained');
		await bob.nextMessage(
			'room_member_updated',
			(message) =>
				message.data.member.memberId === resumedRoom.self.memberId &&
				message.data.member.status === 'connected'
		);
		await bob.nextMessage('room_directory_updated', (message) =>
			roomSummaryMatches(message, secondAliceRoom.data.roomId, 2, 0)
		);
		const staleAdmission = await authenticatedClient(
			clients,
			'Alice stale resume',
			url,
			await issuer.issue(aliceIdentity),
			{
				roomId: secondAliceRoom.data.roomId,
				seatToken: secondAliceRoom.data.self.resumeToken
			}
		);
		const staleAlice = staleAdmission.client;
		invariant(staleAdmission.hello.data.resume.status === 'failed', 'stale token failure');
		staleAlice.send({ type: 'directory_subscribe', data: {} });
		await staleAlice.nextMessage('directory_snapshot', (message) =>
			roomSummaryMatches(message, secondAliceRoom.data.roomId, 2, 0)
		);
		phase(8, 'Fresh room resume and ownership');

		resumedAlice.close();
		await resumedAlice.closed();
		await bob.nextMessage(
			'room_member_updated',
			(message) =>
				message.data.member.memberId === resumedRoom.self.memberId &&
				message.data.member.status === 'reserved'
		);
		await bob.nextMessage('room_directory_updated', (message) =>
			roomSummaryMatches(message, secondAliceRoom.data.roomId, 1, 1)
		);
		await staleAlice.nextMessage('room_directory_updated', (message) =>
			roomSummaryMatches(message, secondAliceRoom.data.roomId, 1, 1)
		);
		bob.send({
			type: 'room_leave',
			requestId: 'leave-resume-room',
			data: {
				roomId: secondBobRoom.data.roomId,
				roomGeneration: secondBobRoom.data.roomGeneration,
				connectionGeneration: secondBobRoom.data.self.connectionGeneration
			}
		});
		await bob.nextMessage(
			'room_member_left',
			(message) => message.data.memberId === secondBobRoom.data.self.memberId
		);
		await bob.nextMessage('room_directory_updated', (message) =>
			roomSummaryMatches(message, secondAliceRoom.data.roomId, 0, 1)
		);
		await staleAlice.nextMessage('room_directory_updated', (message) =>
			roomSummaryMatches(message, secondAliceRoom.data.roomId, 0, 1)
		);
		await bob.nextMessage(
			'room_directory_updated',
			(message) => message.data.removedRoomIds.includes(secondAliceRoom.data.roomId),
			15_000
		);

		if (process.platform === 'win32') {
			for (const client of clients) await client.stop();
			await arena.shutdown({ drainMs: 0 });
			arenaStopped = true;
		} else {
			const goingAway = staleAlice.nextMessage('server_going_away');
			const closed = staleAlice.closed();
			await arena.shutdown({ drainMs: 50 });
			arenaStopped = true;
			await goingAway;
			const close = await closed;
			invariant(close.code === 1012, 'Linux shutdown close code');
		}
		phase(9, 'Grace expiry, destruction, and clean shutdown');
		process.stdout.write('Phase 1 Arena smoke passed.\n');
	} finally {
		for (const client of clients) await client.stop();
		if (arena !== undefined && !arenaStopped) await arena.shutdown({ drainMs: 0 });
		if (issuer !== undefined) await issuer.server.stop(true);
	}
}

async function main(): Promise<void> {
	const args = Bun.argv.slice(2);
	if (args.length === 0) {
		await runLocalSmoke();
		return;
	}
	if (args.length === 2 && args[0] === '--anonymous-url') {
		await runAnonymousSmoke(args[1]!);
		return;
	}
	throw new Error('Usage: phase1-smoke.ts [--anonymous-url wss://host/ws]');
}

if (import.meta.main) await main();
