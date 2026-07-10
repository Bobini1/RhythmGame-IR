export class FakeClock {
	#nowMs: number;

	constructor(nowMs = 0) {
		this.#nowMs = nowMs;
	}

	now(): number {
		return this.#nowMs;
	}

	advance(milliseconds: number): void {
		this.#nowMs += milliseconds;
	}

	set(nowMs: number): void {
		this.#nowMs = nowMs;
	}
}
