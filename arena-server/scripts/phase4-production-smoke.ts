import { serverMessageSchema, type ServerMessage } from '../src/protocol/messages.ts';

const TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
	const args = process.argv.slice(2).filter((argument) => argument !== '--');
	if (args.length !== 1)
		throw new Error('Usage: bun run smoke:production -- https://arena.example');
	const origin = productionOrigin(args[0]!);
	const healthUrl = new URL('/healthz', origin);
	const health = await fetchWithTimeout(healthUrl);
	if (!health.ok) throw new Error(`Health returned HTTP ${health.status}.`);
	if (health.headers.get('cache-control') !== 'no-store') {
		throw new Error('Health must be no-store.');
	}
	const healthBody = (await health.json()) as Record<string, unknown>;
	if (
		healthBody.status !== 'ok' ||
		healthBody.protocolMajor !== 1 ||
		healthBody.protocolMinor !== 2 ||
		Object.keys(healthBody).length !== 3
	) {
		throw new Error('Health did not return the exact protocol 1.2 liveness body.');
	}

	const queryProbe = await fetchWithTimeout(new URL('/ws?ticket=phase4-public-sentinel', origin));
	if (queryProbe.status !== 400) {
		throw new Error(
			`Query-bearing WebSocket path returned HTTP ${queryProbe.status}, expected 400.`
		);
	}
	const missingUpgrade = await fetchWithTimeout(new URL('/ws', origin));
	if (missingUpgrade.status !== 426) {
		throw new Error(
			`Plain WebSocket request returned HTTP ${missingUpgrade.status}, expected 426.`
		);
	}

	const websocketUrl = new URL('/ws', origin);
	websocketUrl.protocol = 'wss:';
	const directory = await anonymousDirectory(websocketUrl);
	process.stdout.write(
		`${JSON.stringify({
			status: 'ok',
			origin: origin.origin,
			protocol: '1.2',
			certificate: 'validated-by-fetch-and-websocket',
			anonymousDirectoryRevision: directory.data.revision,
			anonymousRoomCount: directory.data.rooms.length
		})}\n`
	);
}

function productionOrigin(raw: string): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error('Production smoke origin is not a valid URL.');
	}
	if (
		url.protocol !== 'https:' ||
		url.username !== '' ||
		url.password !== '' ||
		url.search !== '' ||
		url.hash !== '' ||
		(url.pathname !== '' && url.pathname !== '/')
	) {
		throw new Error('Production smoke accepts one credential-free HTTPS origin only.');
	}
	url.pathname = '/';
	return url;
}

async function fetchWithTimeout(url: URL): Promise<Response> {
	return fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
}

function anonymousDirectory(
	url: URL
): Promise<Extract<ServerMessage, { type: 'directory_snapshot' }>> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url);
		const timer = setTimeout(() => {
			socket.close();
			reject(new Error('Timed out waiting for anonymous Arena directory.'));
		}, TIMEOUT_MS);
		const fail = (error: Error): void => {
			clearTimeout(timer);
			socket.close();
			reject(error);
		};
		socket.addEventListener('open', () => {
			socket.send(
				JSON.stringify({
					type: 'client_hello',
					data: {
						protocolMajor: 1,
						protocolMinor: 2,
						clientVersion: 'phase4-production-smoke',
						capabilities: ['rooms-v1', 'rounds-v1', 'competition-v1']
					}
				})
			);
		});
		socket.addEventListener('message', (event) => {
			if (typeof event.data !== 'string') return fail(new Error('Unexpected binary server frame.'));
			let parsed: ReturnType<typeof serverMessageSchema.safeParse>;
			try {
				parsed = serverMessageSchema.safeParse(JSON.parse(event.data));
			} catch {
				return fail(new Error('Server returned malformed JSON.'));
			}
			if (!parsed.success)
				return fail(new Error('Server returned a noncanonical protocol message.'));
			if (parsed.data.type === 'fatal_error') {
				return fail(new Error(`Server rejected anonymous smoke with ${parsed.data.data.code}.`));
			}
			if (parsed.data.type === 'server_hello') {
				socket.send(JSON.stringify({ type: 'directory_subscribe', data: {} }));
				return;
			}
			if (parsed.data.type === 'directory_snapshot') {
				clearTimeout(timer);
				socket.close();
				resolve(parsed.data);
			}
		});
		socket.addEventListener('error', () => fail(new Error('Anonymous WSS connection failed.')));
		socket.addEventListener('close', () => {
			// A successful directory closes the socket intentionally; all other paths own their error.
		});
	});
}

await main();
