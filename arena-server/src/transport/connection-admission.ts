import type { AddressKey } from './client-address.ts';

export interface ConnectionAdmission {
	attemptUpgrade(
		address: AddressKey,
		nowMs: number
	):
		| Readonly<{ accepted: true; leaseId: string }>
		| Readonly<{ accepted: false; status: 429 | 503 }>;
	markHello(leaseId: string): void;
	release(leaseId: string): void;
	sweep(nowMs: number): readonly Readonly<{ leaseId: string; reason: 'hello_timeout' }>[];
}

export type ConnectionAdmissionOptions = Readonly<{
	maxAttemptsPerMinute: number;
	maxConnectionsPerAddress: number;
	helloTimeoutMs: number;
	maxTrackedAddresses: number;
	maxConnections: number;
	windowMs?: number;
	newLeaseId?: () => string;
}>;

export interface ConnectionAdmissionController extends ConnectionAdmission {
	beginShutdown(): void;
	releaseAll(): void;
	nextHelloDeadlineMs(): number | undefined;
	debugSnapshot(): Readonly<{
		activeLeases: number;
		awaitingHello: number;
		trackedAddresses: number;
		retainedAttempts: number;
		shuttingDown: boolean;
	}>;
}

type AddressEntry = {
	attempts: number[];
	readonly activeLeaseIds: Set<string>;
};
type Lease = Readonly<{
	leaseId: string;
	address: AddressKey;
	helloDeadlineMs: number;
}> & { helloComplete: boolean };

const DEFAULT_WINDOW_MS = 60_000;

export function createConnectionAdmission(
	options: ConnectionAdmissionOptions
): ConnectionAdmissionController {
	validateOptions(options);
	const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
	const newLeaseId = options.newLeaseId ?? (() => crypto.randomUUID());
	const addresses = new Map<AddressKey, AddressEntry>();
	const leases = new Map<string, Lease>();
	let shuttingDown = false;

	const pruneAttempts = (entry: AddressEntry, nowMs: number): void => {
		const firstActive = entry.attempts.findIndex((timestamp) => timestamp > nowMs - windowMs);
		entry.attempts = firstActive < 0 ? [] : entry.attempts.slice(firstActive);
	};

	const pruneEntries = (nowMs: number): void => {
		for (const [key, entry] of addresses) {
			pruneAttempts(entry, nowMs);
			if (entry.attempts.length === 0 && entry.activeLeaseIds.size === 0) addresses.delete(key);
		}
	};

	const releaseLease = (leaseId: string): void => {
		const lease = leases.get(leaseId);
		if (lease === undefined) return;
		leases.delete(leaseId);
		addresses.get(lease.address)?.activeLeaseIds.delete(leaseId);
	};

	return {
		attemptUpgrade(address, nowMs) {
			if (shuttingDown || leases.size >= options.maxConnections) {
				return { accepted: false, status: 503 };
			}
			let entry = addresses.get(address);
			if (entry === undefined) {
				if (addresses.size >= options.maxTrackedAddresses) {
					pruneEntries(nowMs);
				}
				if (addresses.size >= options.maxTrackedAddresses) {
					return { accepted: false, status: 503 };
				}
				entry = { attempts: [], activeLeaseIds: new Set() };
				addresses.set(address, entry);
			} else pruneAttempts(entry, nowMs);
			if (entry.attempts.length >= options.maxAttemptsPerMinute) {
				return { accepted: false, status: 429 };
			}
			entry.attempts.push(nowMs);
			if (entry.activeLeaseIds.size >= options.maxConnectionsPerAddress) {
				return { accepted: false, status: 429 };
			}

			let leaseId = newLeaseId();
			for (let collision = 0; leases.has(leaseId) && collision < 8; collision += 1) {
				leaseId = newLeaseId();
			}
			if (leases.has(leaseId)) throw new Error('Arena admission lease IDs must be unique.');
			const lease: Lease = {
				leaseId,
				address,
				helloDeadlineMs: nowMs + options.helloTimeoutMs,
				helloComplete: false
			};
			leases.set(leaseId, lease);
			entry.activeLeaseIds.add(leaseId);
			return { accepted: true, leaseId };
		},

		markHello(leaseId) {
			const lease = leases.get(leaseId);
			if (lease !== undefined) lease.helloComplete = true;
		},

		release: releaseLease,

		sweep(nowMs) {
			const expired: { leaseId: string; reason: 'hello_timeout' }[] = [];
			for (const lease of [...leases.values()]) {
				if (lease.helloComplete || nowMs < lease.helloDeadlineMs) continue;
				expired.push({ leaseId: lease.leaseId, reason: 'hello_timeout' });
				releaseLease(lease.leaseId);
			}
			pruneEntries(nowMs);
			return expired;
		},

		beginShutdown() {
			shuttingDown = true;
		},

		releaseAll() {
			shuttingDown = true;
			leases.clear();
			addresses.clear();
		},

		nextHelloDeadlineMs() {
			let earliest: number | undefined;
			for (const lease of leases.values()) {
				if (lease.helloComplete) continue;
				if (earliest === undefined || lease.helloDeadlineMs < earliest) {
					earliest = lease.helloDeadlineMs;
				}
			}
			return earliest;
		},

		debugSnapshot() {
			let awaitingHello = 0;
			let retainedAttempts = 0;
			for (const lease of leases.values()) if (!lease.helloComplete) awaitingHello += 1;
			for (const entry of addresses.values()) retainedAttempts += entry.attempts.length;
			return {
				activeLeases: leases.size,
				awaitingHello,
				trackedAddresses: addresses.size,
				retainedAttempts,
				shuttingDown
			};
		}
	};
}

function validateOptions(options: ConnectionAdmissionOptions): void {
	for (const value of [
		options.maxAttemptsPerMinute,
		options.maxConnectionsPerAddress,
		options.helloTimeoutMs,
		options.maxTrackedAddresses,
		options.maxConnections,
		options.windowMs ?? DEFAULT_WINDOW_MS
	]) {
		if (!Number.isSafeInteger(value) || value < 1) {
			throw new Error('Invalid Arena connection admission configuration.');
		}
	}
}
