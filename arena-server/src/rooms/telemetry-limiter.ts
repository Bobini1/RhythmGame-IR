const CAPACITY = 10;
const REFILL_INTERVAL_MS = 200;
const VIOLATION_WINDOW_MS = 10_000;
const CLOSE_VIOLATION_COUNT = 20;

export class TelemetryLimiter {
	#tokens = CAPACITY;
	#lastRefillMs: number | undefined;
	readonly #violations: number[] = [];

	attempt(nowMs: number): 'allow' | 'drop' | 'close' {
		this.#refill(nowMs);
		if (this.#tokens > 0) {
			this.#tokens -= 1;
			return 'allow';
		}
		return this.violation(nowMs);
	}

	violation(nowMs: number): 'drop' | 'close' {
		this.#pruneViolations(nowMs);
		this.#violations.push(nowMs);
		if (this.#violations.length > CLOSE_VIOLATION_COUNT) this.#violations.shift();
		return this.#violations.length >= CLOSE_VIOLATION_COUNT ? 'close' : 'drop';
	}

	clear(): void {
		this.#tokens = CAPACITY;
		this.#lastRefillMs = undefined;
		this.#violations.length = 0;
	}

	#refill(nowMs: number): void {
		if (this.#lastRefillMs === undefined) {
			this.#lastRefillMs = nowMs;
			return;
		}
		if (nowMs <= this.#lastRefillMs) return;
		const quanta = Math.floor((nowMs - this.#lastRefillMs) / REFILL_INTERVAL_MS);
		if (quanta === 0) return;
		this.#tokens = Math.min(CAPACITY, this.#tokens + quanta);
		this.#lastRefillMs += quanta * REFILL_INTERVAL_MS;
	}

	#pruneViolations(nowMs: number): void {
		const firstActive = this.#violations.findIndex(
			(timestamp) => timestamp > nowMs - VIOLATION_WINDOW_MS
		);
		if (firstActive < 0) this.#violations.length = 0;
		else if (firstActive > 0) this.#violations.splice(0, firstActive);
	}
}
