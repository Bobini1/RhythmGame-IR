import { describe, expect, test } from 'bun:test';
import type { JWTVerifyGetKey } from 'jose';

import { ReplayGuard } from '../../src/auth/replay-guard.ts';
import { JoseTicketVerifier } from '../../src/auth/jose-ticket-verifier.ts';
import {
	TicketVerificationError,
	type TicketVerificationErrorCode
} from '../../src/auth/ticket-verifier.ts';
import {
	createTestTicketFixture,
	TEST_NOW,
	TEST_NOW_SECONDS,
	type TestTicketFixture,
	type TestTicketOptions
} from '../helpers/test-ticket.ts';

const verifierConfig = {
	irJwksUrl: new URL('https://identity.example.test/api/auth/jwks'),
	irIssuer: 'https://rhythmgame.eu',
	arenaAudience: 'https://arena.rhythmgame.eu'
};

function createVerifier(
	fixture: TestTicketFixture,
	replayGuard = new ReplayGuard(),
	resolver: JWTVerifyGetKey = fixture.resolver
): JoseTicketVerifier {
	return new JoseTicketVerifier(verifierConfig, { replayGuard, jwksResolver: resolver });
}

async function expectTicketFailure(
	verification: Promise<unknown>,
	code: TicketVerificationErrorCode = 'invalid_ticket',
	forbiddenValues: readonly string[] = []
): Promise<void> {
	try {
		await verification;
		expect.unreachable('expected ticket verification to fail');
	} catch (error) {
		expect(error).toBeInstanceOf(TicketVerificationError);
		expect((error as TicketVerificationError).code).toBe(code);

		const publicError = String(error) + JSON.stringify(error);
		for (const forbiddenValue of forbiddenValues) {
			expect(publicError).not.toContain(forbiddenValue);
		}
	}
}

describe('ReplayGuard', () => {
	test('atomically consumes distinct live JTIs and rejects duplicates', () => {
		const guard = new ReplayGuard();
		const nowMs = TEST_NOW.getTime();

		expect(guard.consume('jti-a', nowMs + 1_000, nowMs)).toBe(true);
		expect(guard.consume('jti-a', nowMs + 1_000, nowMs)).toBe(false);
		expect(guard.consume('jti-b', nowMs + 1_000, nowMs)).toBe(true);
	});

	test('retains entries until expiry and sweeps them at the exact boundary', () => {
		const guard = new ReplayGuard();
		const nowMs = TEST_NOW.getTime();
		const expiresAtMs = nowMs + 1_000;

		expect(guard.consume('boundary-jti', expiresAtMs, nowMs)).toBe(true);
		guard.sweep(expiresAtMs - 1);
		expect(guard.consume('boundary-jti', expiresAtMs, expiresAtMs - 1)).toBe(false);
		guard.sweep(expiresAtMs);
		expect(guard.consume('boundary-jti', expiresAtMs + 1_000, expiresAtMs)).toBe(true);
		expect(guard.consume('already-expired', expiresAtMs, expiresAtMs)).toBe(false);
	});
});

describe('JoseTicketVerifier', () => {
	test('verifies a valid Ed25519 Arena identity ticket', async () => {
		const fixture = await createTestTicketFixture();
		const ticket = await fixture.sign();

		expect(await createVerifier(fixture).verify(ticket, TEST_NOW)).toEqual({
			identity: {
				userId: 'user-123',
				displayName: 'Arena Player',
				avatarUrl: null
			},
			emailVerified: false,
			jti: 'ticket-123',
			issuedAt: new Date((TEST_NOW_SECONDS - 1) * 1_000),
			expiresAt: new Date((TEST_NOW_SECONDS + 89) * 1_000),
			protocolMajor: 1,
			protocolMinor: 0
		});
	});

	test('rejects the wrong algorithm, signature, issuer, audience, purpose, or protocol major', async () => {
		const fixture = await createTestTicketFixture();
		const invalidTickets = [
			await fixture.signWithWrongAlgorithm(),
			await fixture.signWithWrongKey(),
			await fixture.sign({ claims: { iss: 'https://evil.example.test' } }),
			await fixture.sign({ claims: { aud: 'https://evil.example.test' } }),
			await fixture.sign({ claims: { purpose: 'another-purpose' } }),
			await fixture.sign({ claims: { protocolMajor: 2 } })
		];

		for (const ticket of invalidTickets) {
			await expectTicketFailure(
				createVerifier(fixture).verify(ticket, TEST_NOW),
				'invalid_ticket',
				[ticket]
			);
		}
	});

	test('requires every identity and ticket-policy claim', async () => {
		const fixture = await createTestTicketFixture();
		for (const claim of [
			'sub',
			'name',
			'picture',
			'emailVerified',
			'purpose',
			'protocolMajor',
			'protocolMinor',
			'jti',
			'iat',
			'exp'
		]) {
			const ticket = await fixture.sign({ omit: [claim] });
			await expectTicketFailure(createVerifier(fixture).verify(ticket, TEST_NOW));
		}
	});

	test('rejects wrong-typed required claims', async () => {
		const fixture = await createTestTicketFixture();
		const mutations: readonly TestTicketOptions[] = [
			{ claims: { sub: 1 } },
			{ claims: { name: false } },
			{ claims: { picture: 1 } },
			{ claims: { emailVerified: 'false' } },
			{ claims: { purpose: 1 } },
			{ claims: { protocolMajor: '1' } },
			{ claims: { protocolMinor: '0' } },
			{ claims: { protocolMinor: -1 } },
			{ claims: { protocolMinor: 0.5 } },
			{ claims: { jti: 1 } },
			{ claims: { iat: 'now' } },
			{ claims: { exp: 'later' } }
		];

		for (const options of mutations) {
			const ticket = await fixture.sign(options);
			await expectTicketFailure(createVerifier(fixture).verify(ticket, TEST_NOW));
		}
	});

	test('accepts identity and JTI strings at their exact bounds', async () => {
		const fixture = await createTestTicketFixture();
		const ticket = await fixture.sign({
			claims: {
				sub: 'u'.repeat(128),
				name: 'n'.repeat(80),
				picture: `https://example.test/${'p'.repeat(2_027)}`,
				jti: 'j'.repeat(128)
			}
		});

		const verified = await createVerifier(fixture).verify(ticket, TEST_NOW);
		expect(verified.identity.userId).toHaveLength(128);
		expect(verified.identity.displayName).toHaveLength(80);
		expect(verified.identity.avatarUrl).toHaveLength(2_048);
		expect(verified.jti).toHaveLength(128);
	});

	test('rejects expired, not-yet-valid, inverted, and overlong ticket times', async () => {
		const fixture = await createTestTicketFixture();
		const invalidTimes: readonly TestTicketOptions[] = [
			{ claims: { exp: TEST_NOW_SECONDS } },
			{ claims: { nbf: TEST_NOW_SECONDS + 1 } },
			{ claims: { iat: TEST_NOW_SECONDS + 1, exp: TEST_NOW_SECONDS + 91 } },
			{ claims: { iat: TEST_NOW_SECONDS + 1, exp: TEST_NOW_SECONDS + 1 } },
			{ claims: { iat: TEST_NOW_SECONDS + 2, exp: TEST_NOW_SECONDS + 1 } },
			{ claims: { iat: TEST_NOW_SECONDS - 1, exp: TEST_NOW_SECONDS + 120 } }
		];

		for (const options of invalidTimes) {
			const ticket = await fixture.sign(options);
			await expectTicketFailure(createVerifier(fixture).verify(ticket, TEST_NOW));
		}
	});

	test('accepts a newer protocol minor and either email verification state', async () => {
		const fixture = await createTestTicketFixture();
		const falseTicket = await fixture.sign({
			claims: { protocolMinor: 7, jti: 'minor-7-unverified' }
		});
		const trueTicket = await fixture.sign({
			claims: { protocolMinor: 7, emailVerified: true, jti: 'minor-7-verified' }
		});

		expect((await createVerifier(fixture).verify(falseTicket, TEST_NOW)).emailVerified).toBe(false);
		expect((await createVerifier(fixture).verify(trueTicket, TEST_NOW)).emailVerified).toBe(true);
	});

	test('rejects empty or over-bound identity and JTI strings', async () => {
		const fixture = await createTestTicketFixture();
		const invalidStrings: readonly TestTicketOptions[] = [
			{ claims: { sub: ' ' } },
			{ claims: { sub: 'u'.repeat(129) } },
			{ claims: { name: '' } },
			{ claims: { name: 'n'.repeat(81) } },
			{ claims: { picture: '' } },
			{ claims: { picture: 'p'.repeat(2_049) } },
			{ claims: { jti: ' ' } },
			{ claims: { jti: 'j'.repeat(129) } }
		];

		for (const options of invalidStrings) {
			const ticket = await fixture.sign(options);
			await expectTicketFailure(createVerifier(fixture).verify(ticket, TEST_NOW));
		}
	});

	test('consumes a JTI only after every signature and claim check succeeds', async () => {
		const fixture = await createTestTicketFixture();
		const replayGuard = new ReplayGuard();
		const verifier = createVerifier(fixture, replayGuard);
		const invalid = await fixture.sign({ claims: { purpose: 'wrong', jti: 'shared-jti' } });
		const valid = await fixture.sign({ claims: { jti: 'shared-jti' } });

		await expectTicketFailure(verifier.verify(invalid, TEST_NOW));
		expect((await verifier.verify(valid, TEST_NOW)).jti).toBe('shared-jti');
	});

	test('rejects sequential and concurrent replay while accepting distinct JTIs', async () => {
		const fixture = await createTestTicketFixture();
		const sequentialVerifier = createVerifier(fixture);
		const sequentialTicket = await fixture.sign({ claims: { jti: 'sequential-jti' } });
		await sequentialVerifier.verify(sequentialTicket, TEST_NOW);
		await expectTicketFailure(
			sequentialVerifier.verify(sequentialTicket, TEST_NOW),
			'ticket_replayed'
		);

		const concurrentVerifier = createVerifier(fixture);
		const concurrentTicket = await fixture.sign({ claims: { jti: 'concurrent-jti' } });
		const concurrentResults = await Promise.allSettled([
			concurrentVerifier.verify(concurrentTicket, TEST_NOW),
			concurrentVerifier.verify(concurrentTicket, TEST_NOW)
		]);
		expect(concurrentResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		const rejection = concurrentResults.find((result) => result.status === 'rejected');
		expect(rejection?.status).toBe('rejected');
		expect((rejection as PromiseRejectedResult).reason).toBeInstanceOf(TicketVerificationError);
		expect(((rejection as PromiseRejectedResult).reason as TicketVerificationError).code).toBe(
			'ticket_replayed'
		);

		const distinctVerifier = createVerifier(fixture);
		const first = await fixture.sign({ claims: { jti: 'distinct-a' } });
		const second = await fixture.sign({ claims: { jti: 'distinct-b' } });
		expect((await distinctVerifier.verify(first, TEST_NOW)).jti).toBe('distinct-a');
		expect((await distinctVerifier.verify(second, TEST_NOW)).jti).toBe('distinct-b');
	});

	test('sanitizes malformed tickets and JWKS resolver failures', async () => {
		const fixture = await createTestTicketFixture();
		const malformedTicket = 'sentinel.secret.ticket';
		await expectTicketFailure(
			createVerifier(fixture).verify(malformedTicket, TEST_NOW),
			'invalid_ticket',
			[malformedTicket]
		);

		const resolverSecret = 'sentinel-jwks-internal-detail';
		const unavailableResolver: JWTVerifyGetKey = async () => {
			throw new Error(resolverSecret);
		};
		const validTicket = await fixture.sign({ claims: { jti: 'jwks-failure' } });
		await expectTicketFailure(
			createVerifier(fixture, new ReplayGuard(), unavailableResolver).verify(validTicket, TEST_NOW),
			'invalid_ticket',
			[validTicket, resolverSecret]
		);
	});
});
