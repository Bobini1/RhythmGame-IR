import {
	createLocalJWKSet,
	exportJWK,
	generateKeyPair,
	SignJWT,
	type CryptoKey,
	type JWTVerifyGetKey,
	type JWTPayload,
	type KeyObject
} from 'jose';

export const TEST_NOW = new Date('2026-07-10T12:00:00.000Z');
export const TEST_NOW_SECONDS = Math.floor(TEST_NOW.getTime() / 1_000);

type SigningKey = CryptoKey | KeyObject | Uint8Array;

export type TestTicketOptions = Readonly<{
	claims?: Readonly<Record<string, unknown>>;
	omit?: readonly string[];
}>;

export type TestTicketFixture = Readonly<{
	resolver: JWTVerifyGetKey;
	sign(options?: TestTicketOptions): Promise<string>;
	signWithWrongKey(options?: TestTicketOptions): Promise<string>;
	signWithWrongAlgorithm(options?: TestTicketOptions): Promise<string>;
}>;

const defaultClaims = {
	iss: 'https://rhythmgame.eu',
	aud: 'https://arena.rhythmgame.eu',
	sub: 'user-123',
	name: 'Arena Player',
	picture: null,
	emailVerified: false,
	purpose: 'arena-connect',
	protocolMajor: 1,
	protocolMinor: 0,
	jti: 'ticket-123',
	iat: TEST_NOW_SECONDS - 1,
	exp: TEST_NOW_SECONDS + 89
} as const;

function payloadFor(options: TestTicketOptions): JWTPayload {
	const payload: Record<string, unknown> = {
		...defaultClaims,
		...options.claims
	};

	for (const claim of options.omit ?? []) {
		delete payload[claim];
	}

	return payload as JWTPayload;
}

async function signEd25519(
	key: SigningKey,
	options: TestTicketOptions,
	kid = 'arena-test-key'
): Promise<string> {
	return new SignJWT(payloadFor(options))
		.setProtectedHeader({ alg: 'EdDSA', kid, typ: 'JWT' })
		.sign(key);
}

export async function createTestTicketFixture(): Promise<TestTicketFixture> {
	const signingKeyPair = await generateKeyPair('EdDSA', {
		crv: 'Ed25519',
		extractable: true
	});
	const wrongKeyPair = await generateKeyPair('EdDSA', {
		crv: 'Ed25519',
		extractable: true
	});
	const publicJwk = await exportJWK(signingKeyPair.publicKey);
	const resolver = createLocalJWKSet({
		keys: [{ ...publicJwk, alg: 'EdDSA', kid: 'arena-test-key', use: 'sig' }]
	});

	return {
		resolver,
		sign: (options = {}) => signEd25519(signingKeyPair.privateKey, options),
		signWithWrongKey: (options = {}) => signEd25519(wrongKeyPair.privateKey, options),
		signWithWrongAlgorithm: (options = {}) =>
			new SignJWT(payloadFor(options))
				.setProtectedHeader({ alg: 'HS256', kid: 'arena-test-key', typ: 'JWT' })
				.sign(new TextEncoder().encode('arena-test-hmac-key-with-enough-entropy'))
	};
}
