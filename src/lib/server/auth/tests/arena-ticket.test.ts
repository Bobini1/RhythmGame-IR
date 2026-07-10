import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { bearer } from 'better-auth/plugins';
import { createLocalJWKSet, decodeJwt, jwtVerify, type JSONWebKeySet } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';
import { jwks } from '../../database/schemas/auth';
import { authDatabaseSchema } from '../auth-database-schema';
import { createArenaAuthOptions } from '../arena-ticket';

const BASE_URL = 'http://localhost:3000';

function createTestAuth() {
	const arenaAuthOptions = createArenaAuthOptions();

	return betterAuth({
		baseURL: BASE_URL,
		secret: 'arena-ticket-test-secret-is-long-enough',
		database: memoryAdapter({
			user: [],
			session: [],
			account: [],
			verification: [],
			jwks: []
		}),
		emailAndPassword: { enabled: true },
		plugins: [bearer(), ...arenaAuthOptions.plugins],
		hooks: arenaAuthOptions.hooks
	});
}

async function signUpAndGetBearerToken(auth: ReturnType<typeof createTestAuth>) {
	const response = await auth.handler(
		new Request(`${BASE_URL}/api/auth/sign-up/email`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				name: 'Arena Player',
				email: 'arena-player@example.com',
				password: 'a-secure-password'
			})
		})
	);

	expect(response.status).toBe(200);
	const token = response.headers.get('set-auth-token');
	const body = (await response.json()) as { user: { id: string } };
	expect(token).toBeTruthy();
	return { bearerToken: token!, userId: String(body.user.id) };
}

function bearerRequest(path: string, token: string) {
	return new Request(`${BASE_URL}/api/auth${path}`, {
		headers: { authorization: `Bearer ${token}` }
	});
}

describe('Arena identity tickets', () => {
	let auth: ReturnType<typeof createTestAuth>;

	beforeEach(() => {
		auth = createTestAuth();
	});

	it('rejects unauthenticated ticket requests', async () => {
		const response = await auth.handler(new Request(`${BASE_URL}/api/auth/token`));

		expect(response.status).toBe(401);
	});

	it('includes the JWKS table in the production auth database schema', () => {
		expect(authDatabaseSchema.jwks).toBe(jwks);
	});

	it('issues a short-lived Ed25519 Arena ticket and publishes its verification key', async () => {
		const { bearerToken, userId } = await signUpAndGetBearerToken(auth);
		const response = await auth.handler(bearerRequest('/token', bearerToken));

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toContain('no-store');
		const { token } = (await response.json()) as { token: string };

		const jwksResponse = await auth.handler(new Request(`${BASE_URL}/api/auth/jwks`));
		expect(jwksResponse.status).toBe(200);
		const publishedJwks = (await jwksResponse.json()) as JSONWebKeySet;
		const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet(publishedJwks), {
			algorithms: ['EdDSA'],
			issuer: 'https://rhythmgame.eu',
			audience: 'https://arena.rhythmgame.eu'
		});

		expect(protectedHeader.alg).toBe('EdDSA');
		expect(payload.iss).toBe('https://rhythmgame.eu');
		expect(payload.aud).toBe('https://arena.rhythmgame.eu');
		expect(payload.sub).toBe(userId);
		expect(payload.name).toBe('Arena Player');
		expect(payload.picture).toBeNull();
		expect(payload.emailVerified).toBe(false);
		expect(payload.purpose).toBe('arena-connect');
		expect(payload.protocolMajor).toBe(1);
		expect(payload.protocolMinor).toBe(1);
		expect(payload.exp! - payload.iat!).toBe(90);
		expect(payload.jti).toEqual(expect.any(String));
		expect(publishedJwks.keys).toContainEqual(
			expect.objectContaining({
				alg: 'EdDSA',
				crv: 'Ed25519',
				kid: protectedHeader.kid,
				kty: 'OKP'
			})
		);
	});

	it('uses a distinct JWT ID for every ticket', async () => {
		const { bearerToken } = await signUpAndGetBearerToken(auth);
		const firstResponse = await auth.handler(bearerRequest('/token', bearerToken));
		const secondResponse = await auth.handler(bearerRequest('/token', bearerToken));
		const firstToken = ((await firstResponse.json()) as { token: string }).token;
		const secondToken = ((await secondResponse.json()) as { token: string }).token;

		expect(decodeJwt(firstToken).jti).not.toBe(decodeJwt(secondToken).jti);
	});

	it('does not attach an auth JWT header to session responses', async () => {
		const { bearerToken } = await signUpAndGetBearerToken(auth);
		const response = await auth.handler(bearerRequest('/get-session', bearerToken));

		expect(response.status).toBe(200);
		expect(response.headers.get('set-auth-jwt')).toBeNull();
	});
});
