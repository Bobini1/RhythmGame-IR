import { describe, expect, test } from 'bun:test';

import type { AddressKey } from '../../src/transport/client-address.ts';
import { createConnectionAdmission } from '../../src/transport/connection-admission.ts';

const address = (value: string) => value as AddressKey;

function admission(overrides: Partial<Parameters<typeof createConnectionAdmission>[0]> = {}) {
	let lease = 0;
	return createConnectionAdmission({
		maxAttemptsPerMinute: 120,
		maxConnectionsPerAddress: 20,
		helloTimeoutMs: 10_000,
		maxTrackedAddresses: 20_000,
		maxConnections: 5_000,
		newLeaseId: () => `lease-${++lease}`,
		...overrides
	});
}

describe('ConnectionAdmission', () => {
	test('accepts 120 rolling attempts and rejects the 121st without growing timestamps', () => {
		const control = admission();
		for (let index = 0; index < 120; index += 1) {
			const result = control.attemptUpgrade(address('same'), 1_000 + index);
			expect(result.accepted).toBe(true);
			if (result.accepted) control.release(result.leaseId);
		}
		expect(control.attemptUpgrade(address('same'), 1_120)).toEqual({
			accepted: false,
			status: 429
		});
		expect(control.debugSnapshot()).toMatchObject({ trackedAddresses: 1, retainedAttempts: 120 });

		const expired = control.attemptUpgrade(address('same'), 61_119);
		expect(expired.accepted).toBe(true);
	});

	test('bounds concurrent leases independently per address and releases idempotently', () => {
		const control = admission();
		const leases: string[] = [];
		for (let index = 0; index < 20; index += 1) {
			const result = control.attemptUpgrade(address('one'), index);
			expect(result.accepted).toBe(true);
			if (result.accepted) leases.push(result.leaseId);
		}
		expect(control.attemptUpgrade(address('one'), 100)).toEqual({
			accepted: false,
			status: 429
		});
		expect(control.attemptUpgrade(address('two'), 100).accepted).toBe(true);

		control.release(leases[0]!);
		control.release(leases[0]!);
		expect(control.attemptUpgrade(address('one'), 101).accepted).toBe(true);
	});

	test('expires an uncompleted hello at the exact boundary and cancels after hello', () => {
		const control = admission();
		const first = control.attemptUpgrade(address('one'), 5_000);
		const second = control.attemptUpgrade(address('one'), 5_001);
		if (!first.accepted || !second.accepted) throw new Error('setup rejected');

		control.markHello(second.leaseId);
		expect(control.nextHelloDeadlineMs()).toBe(15_000);
		expect(control.sweep(14_999)).toEqual([]);
		expect(control.sweep(15_000)).toEqual([{ leaseId: first.leaseId, reason: 'hello_timeout' }]);
		expect(control.debugSnapshot().activeLeases).toBe(1);
		control.release(second.leaseId);
	});

	test('evicts idle expired address entries', () => {
		const control = admission();
		const result = control.attemptUpgrade(address('idle'), 0);
		if (!result.accepted) throw new Error('setup rejected');
		control.release(result.leaseId);
		expect(control.debugSnapshot().trackedAddresses).toBe(1);

		control.sweep(60_000);
		expect(control.debugSnapshot()).toMatchObject({ trackedAddresses: 0, retainedAttempts: 0 });
	});

	test('enforces the exact tracked-address boundary after sweeping', () => {
		const control = admission({
			maxTrackedAddresses: 20_000,
			maxConnections: 20_001,
			maxConnectionsPerAddress: 1
		});
		for (let index = 0; index < 20_000; index += 1) {
			expect(control.attemptUpgrade(address(`address-${index}`), 1).accepted).toBe(true);
		}
		expect(control.attemptUpgrade(address('overflow'), 1)).toEqual({
			accepted: false,
			status: 503
		});
	});

	test('gives global capacity and shutdown 503 precedence without recording an attempt', () => {
		const control = admission({ maxConnections: 1 });
		expect(control.attemptUpgrade(address('one'), 0).accepted).toBe(true);
		expect(control.attemptUpgrade(address('two'), 0)).toEqual({ accepted: false, status: 503 });
		expect(control.debugSnapshot()).toMatchObject({ trackedAddresses: 1, retainedAttempts: 1 });

		control.beginShutdown();
		expect(control.attemptUpgrade(address('three'), 1)).toEqual({
			accepted: false,
			status: 503
		});
	});

	test('releases every lease and retained entry during shutdown cleanup', () => {
		const control = admission();
		control.attemptUpgrade(address('one'), 0);
		control.attemptUpgrade(address('two'), 0);
		control.releaseAll();

		expect(control.debugSnapshot()).toEqual({
			activeLeases: 0,
			awaitingHello: 0,
			trackedAddresses: 0,
			retainedAttempts: 0,
			shuttingDown: true
		});
	});
});
