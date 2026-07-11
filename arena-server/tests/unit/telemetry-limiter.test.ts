import { describe, expect, test } from 'bun:test';

import { TelemetryLimiter } from '../../src/rooms/telemetry-limiter.ts';

describe('Arena TelemetryLimiter', () => {
	test('allows the initial burst of ten and refills one integer token each 200 ms', () => {
		const limiter = new TelemetryLimiter();
		for (let index = 0; index < 10; ++index) expect(limiter.attempt(1_000)).toBe('allow');
		expect(limiter.attempt(1_000)).toBe('drop');
		expect(limiter.attempt(1_199)).toBe('drop');
		expect(limiter.attempt(1_200)).toBe('allow');
		expect(limiter.attempt(1_200)).toBe('drop');
		expect(limiter.attempt(3_200)).toBe('allow');
		for (let index = 0; index < 9; ++index) expect(limiter.attempt(3_200)).toBe('allow');
		expect(limiter.attempt(3_200)).toBe('drop');
	});

	test('closes on the exact twentieth violation in the rolling ten-second window', () => {
		const limiter = new TelemetryLimiter();
		for (let index = 0; index < 19; ++index) {
			expect(limiter.violation(index)).toBe('drop');
		}
		expect(limiter.violation(19)).toBe('close');
		expect(limiter.violation(20)).toBe('close');
	});

	test('expires the violation window at the exact boundary and bounds retained timestamps', () => {
		const limiter = new TelemetryLimiter();
		for (let index = 0; index < 19; ++index) expect(limiter.violation(0)).toBe('drop');
		expect(limiter.violation(9_999)).toBe('close');
		expect(limiter.violation(10_000)).toBe('drop');
		for (let index = 0; index < 18; ++index) {
			const outcome = limiter.violation(10_001 + index);
			if (index < 17) expect(outcome).toBe('drop');
			else expect(outcome).toBe('close');
		}
	});

	test('shares one violation window between token exhaustion and semantic violations', () => {
		const limiter = new TelemetryLimiter();
		for (let index = 0; index < 10; ++index) {
			expect(limiter.attempt(0)).toBe('allow');
			expect(limiter.violation(0)).toBe('drop');
		}
		for (let index = 0; index < 9; ++index) expect(limiter.attempt(0)).toBe('drop');
		expect(limiter.attempt(0)).toBe('close');
	});

	test('clear restores a fresh limiter', () => {
		const limiter = new TelemetryLimiter();
		for (let index = 0; index < 20; ++index) limiter.violation(0);
		limiter.clear();
		for (let index = 0; index < 10; ++index) expect(limiter.attempt(50_000)).toBe('allow');
		expect(limiter.attempt(50_000)).toBe('drop');
		expect(limiter.violation(50_000)).toBe('drop');
	});
});
