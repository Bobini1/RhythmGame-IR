import type { PasswordHasher } from './password-hasher.ts';

export class BunPasswordHasher implements PasswordHasher {
	async hash(password: string): Promise<string> {
		return Bun.password.hash(password, { algorithm: 'argon2id' });
	}

	async verify(password: string, digest: string): Promise<boolean> {
		return Bun.password.verify(password, digest, 'argon2id');
	}
}
