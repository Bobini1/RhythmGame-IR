import type { PasswordHasher } from '../../src/rooms/password-hasher.ts';

export type DeferredVerification = Readonly<{
	resolve(result: boolean): void;
}>;

type PendingVerification = {
	promise: Promise<boolean>;
	resolve(result: boolean): void;
};

export class FakePasswordHasher implements PasswordHasher {
	readonly hashCalls: string[] = [];
	readonly verifyCalls: Array<Readonly<{ password: string; digest: string }>> = [];
	readonly #deferred: PendingVerification[] = [];

	deferVerify(): DeferredVerification {
		let resolvePromise!: (result: boolean) => void;
		const pending: PendingVerification = {
			promise: new Promise<boolean>((resolve) => {
				resolvePromise = resolve;
			}),
			resolve: (result) => resolvePromise(result)
		};
		this.#deferred.push(pending);
		return { resolve: pending.resolve };
	}

	async hash(password: string): Promise<string> {
		this.hashCalls.push(password);
		return `digest:${password}`;
	}

	async verify(password: string, digest: string): Promise<boolean> {
		this.verifyCalls.push({ password, digest });
		const pending = this.#deferred.shift();
		return pending ? pending.promise : digest === `digest:${password}`;
	}
}
