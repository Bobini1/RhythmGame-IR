export class ReplayGuard {
	readonly #consumedUntil = new Map<string, number>();

	consume(jti: string, expiresAtMs: number, nowMs: number): boolean {
		if (!Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs) || expiresAtMs <= nowMs) {
			return false;
		}

		this.sweep(nowMs);
		if (this.#consumedUntil.has(jti)) {
			return false;
		}

		this.#consumedUntil.set(jti, expiresAtMs);
		return true;
	}

	sweep(nowMs: number): void {
		for (const [jti, expiresAtMs] of this.#consumedUntil) {
			if (expiresAtMs <= nowMs) {
				this.#consumedUntil.delete(jti);
			}
		}
	}
}
