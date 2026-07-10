import { ArenaApplication } from './application/arena-application.ts';
import { JoseTicketVerifier } from './auth/jose-ticket-verifier.ts';
import { loadArenaConfig } from './config.ts';
import { InventoryUploadManager } from './inventory/inventory-upload-manager.ts';
import { BunPasswordHasher } from './rooms/bun-password-hasher.ts';
import { createRoomDirectory } from './rooms/room-directory.ts';
import {
	startArenaServer,
	type ArenaLogger,
	type ArenaServerHandle
} from './transport/start-server.ts';

const structuredLogger: ArenaLogger = (level, event, fields = {}) => {
	process.stdout.write(
		`${JSON.stringify({
			timestamp: new Date().toISOString(),
			level,
			event,
			...fields
		})}\n`
	);
};

export function startProductionArenaServer(
	environment: Record<string, string | undefined> = Bun.env
): ArenaServerHandle {
	const config = loadArenaConfig(environment);
	const ticketVerifier = new JoseTicketVerifier(config);
	const roomDirectory = createRoomDirectory(
		{
			roomCapacity: config.roomCapacity,
			reconnectGraceMs: config.reconnectGraceMs,
			chatBacklog: config.chatBacklog
		},
		new BunPasswordHasher()
	);
	const application = new ArenaApplication({
		ticketVerifier,
		roomDirectory,
		now: Date.now,
		newNonce: () => crypto.randomUUID(),
		inventoryUploadManager: new InventoryUploadManager({
			uploadTimeoutMs: config.inventoryUploadTimeoutMs,
			maxPendingBytes: config.maxPendingInventoryBytes,
			maxCommittedBytes: config.maxCommittedInventoryBytes
		})
	});
	const handle = startArenaServer({ application, config, logger: structuredLogger });
	structuredLogger('info', 'server_started', { host: config.host, port: handle.port });
	return handle;
}

function registerShutdownSignals(handle: ArenaServerHandle): void {
	let stopping = false;
	const stop = (signal: 'SIGINT' | 'SIGTERM'): void => {
		if (stopping) return;
		stopping = true;
		structuredLogger('info', 'shutdown_requested', { signal });
		void handle.shutdown().catch(() => {
			structuredLogger('error', 'shutdown_failed');
			process.exitCode = 1;
		});
	};
	process.once('SIGINT', () => stop('SIGINT'));
	process.once('SIGTERM', () => stop('SIGTERM'));
}

if (import.meta.main) {
	try {
		registerShutdownSignals(startProductionArenaServer());
	} catch {
		structuredLogger('error', 'startup_failed');
		process.exitCode = 1;
	}
}
