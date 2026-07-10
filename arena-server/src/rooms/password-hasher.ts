export interface PasswordHasher {
	hash(password: string): Promise<string>;
	verify(password: string, digest: string): Promise<boolean>;
}
