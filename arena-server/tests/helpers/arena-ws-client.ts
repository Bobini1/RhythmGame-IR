import { serverMessageSchema, type ClientMessage } from '../../src/protocol/messages.ts';

type ClientCommand =
	| Readonly<{ command: 'connect'; url: string }>
	| Readonly<{ command: 'send'; message: ClientMessage }>
	| Readonly<{ command: 'send_raw'; text: string }>
	| Readonly<{ command: 'send_binary'; bytes: readonly number[] }>
	| Readonly<{ command: 'close' }>
	| Readonly<{ command: 'exit' }>;

let socket: WebSocket | undefined;

function emit(event: unknown): void {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

function parseCommand(line: string): ClientCommand | undefined {
	try {
		const value = JSON.parse(line) as Record<string, unknown>;
		if (typeof value !== 'object' || value === null || typeof value.command !== 'string') {
			return undefined;
		}
		return value as ClientCommand;
	} catch {
		return undefined;
	}
}

function run(command: ClientCommand): void {
	switch (command.command) {
		case 'connect': {
			if (socket !== undefined) return emit({ event: 'error', code: 'already_connected' });
			try {
				socket = new WebSocket(command.url);
				socket.binaryType = 'arraybuffer';
				socket.addEventListener('open', () => emit({ event: 'opened' }));
				socket.addEventListener('message', (received) => {
					if (typeof received.data !== 'string') {
						if (!(received.data instanceof ArrayBuffer)) {
							emit({ event: 'error', code: 'invalid_server_binary' });
							return;
						}
						emit({ event: 'binary', bytes: Array.from(new Uint8Array(received.data)) });
						return;
					}
					try {
						const parsed = serverMessageSchema.safeParse(JSON.parse(received.data));
						if (!parsed.success) {
							emit({ event: 'error', code: 'invalid_server_message' });
							return;
						}
						emit({ event: 'message', message: parsed.data });
					} catch {
						emit({ event: 'error', code: 'invalid_server_message' });
					}
				});
				socket.addEventListener('close', (closed) =>
					emit({ event: 'closed', code: closed.code, reason: closed.reason })
				);
				socket.addEventListener('error', () => emit({ event: 'error', code: 'socket_error' }));
			} catch {
				emit({ event: 'error', code: 'connect_failed' });
			}
			return;
		}
		case 'send':
			socket?.send(JSON.stringify(command.message));
			return;
		case 'send_raw':
			socket?.send(command.text);
			return;
		case 'send_binary':
			socket?.send(Uint8Array.from(command.bytes));
			return;
		case 'close':
			socket?.close();
			return;
		case 'exit':
			socket?.close();
			process.exit(0);
	}
}

const decoder = new TextDecoder();
let buffered = '';
for await (const chunk of Bun.stdin.stream()) {
	buffered += decoder.decode(chunk, { stream: true });
	for (;;) {
		const newline = buffered.indexOf('\n');
		if (newline < 0) break;
		const line = buffered.slice(0, newline);
		buffered = buffered.slice(newline + 1);
		const command = parseCommand(line);
		if (command === undefined) emit({ event: 'error', code: 'invalid_command' });
		else run(command);
	}
}
socket?.close();
