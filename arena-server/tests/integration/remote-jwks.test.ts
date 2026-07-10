import { expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { JoseTicketVerifier } from '../../src/auth/jose-ticket-verifier.ts';
import { TicketVerificationError } from '../../src/auth/ticket-verifier.ts';
import { TEST_NOW, TEST_NOW_SECONDS } from '../helpers/test-ticket.ts';

async function createSigningKey(kid: string) {
	const keyPair = await generateKeyPair('EdDSA', {
		crv: 'Ed25519',
		extractable: true
	});
	const publicJwk = await exportJWK(keyPair.publicKey);

	return {
		kid,
		privateKey: keyPair.privateKey,
		publicJwk: { ...publicJwk, alg: 'EdDSA', kid, use: 'sig' }
	};
}

type SigningKey = Awaited<ReturnType<typeof createSigningKey>>;

function signTicket(key: SigningKey, jti: string): Promise<string> {
	return new SignJWT({
		name: 'Remote JWKS Player',
		picture: null,
		emailVerified: false,
		purpose: 'arena-connect',
		protocolMajor: 1,
		protocolMinor: 0,
		jti
	})
		.setProtectedHeader({ alg: 'EdDSA', kid: key.kid, typ: 'JWT' })
		.setIssuer('https://rhythmgame.eu')
		.setAudience('https://arena.rhythmgame.eu')
		.setSubject('remote-user')
		.setIssuedAt(TEST_NOW_SECONDS - 1)
		.setExpirationTime(TEST_NOW_SECONDS + 89)
		.sign(key.privateKey);
}

test('uses the production remote JWKS resolver cache and refresh path safely', async () => {
	const [firstKey, rotatedKey, unknownKey] = await Promise.all([
		createSigningKey('remote-key-a'),
		createSigningKey('remote-key-b'),
		createSigningKey('remote-key-unknown')
	]);
	let publishedKeys = [firstKey.publicJwk];
	let available = true;
	let requestCount = 0;
	const unavailableDetail = 'sentinel-private-jwks-outage-detail';
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch() {
			requestCount += 1;
			if (!available) {
				return new Response(unavailableDetail, { status: 503 });
			}
			return Response.json({ keys: publishedKeys });
		}
	});

	try {
		const verifier = new JoseTicketVerifier(
			{
				irJwksUrl: new URL(`http://127.0.0.1:${server.port}/jwks`),
				irIssuer: 'https://rhythmgame.eu',
				arenaAudience: 'https://arena.rhythmgame.eu'
			},
			{
				remoteJwksOptions: { cooldownDuration: 0, timeoutDuration: 500 }
			}
		);

		const firstTicket = await signTicket(firstKey, 'remote-jti-a-1');
		expect((await verifier.verify(firstTicket, TEST_NOW)).jti).toBe('remote-jti-a-1');
		expect(requestCount).toBe(1);

		available = false;
		const cachedTicket = await signTicket(firstKey, 'remote-jti-a-2');
		expect((await verifier.verify(cachedTicket, TEST_NOW)).jti).toBe('remote-jti-a-2');
		expect(requestCount).toBe(1);

		available = true;
		publishedKeys = [firstKey.publicJwk, rotatedKey.publicJwk];
		const rotatedTicket = await signTicket(rotatedKey, 'remote-jti-b-1');
		expect((await verifier.verify(rotatedTicket, TEST_NOW)).jti).toBe('remote-jti-b-1');
		expect(requestCount).toBe(2);

		available = false;
		const unknownTicket = await signTicket(unknownKey, 'remote-jti-unknown');
		try {
			await verifier.verify(unknownTicket, TEST_NOW);
			expect.unreachable('expected unavailable JWKS verification to fail');
		} catch (error) {
			expect(error).toBeInstanceOf(TicketVerificationError);
			expect((error as TicketVerificationError).code).toBe('invalid_ticket');
			const publicError = String(error) + JSON.stringify(error);
			expect(publicError).not.toContain(unknownTicket);
			expect(publicError).not.toContain(unavailableDetail);
		}
		expect(requestCount).toBe(3);
	} finally {
		await server.stop(true);
	}
});
