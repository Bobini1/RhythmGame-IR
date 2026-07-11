import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from 'jose';
import type { RemoteJWKSetOptions } from 'jose/jwks/remote';

import type { ArenaConfig } from '../config.ts';
import type { ArenaIdentity, VerifiedArenaTicket } from './identity.ts';
import { ReplayGuard } from './replay-guard.ts';
import { TicketVerificationError, type TicketVerifier } from './ticket-verifier.ts';

const MAX_USER_ID_LENGTH = 128;
const MAX_DISPLAY_NAME_CODE_POINTS = 80;
const MAX_AVATAR_URL_LENGTH = 2_048;
const MAX_JTI_LENGTH = 128;
const MAX_TICKET_LIFETIME_MS = 120_000;

const requiredClaims = [
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
];

type TicketVerifierConfig = Pick<ArenaConfig, 'irJwksUrl' | 'irIssuer' | 'arenaAudience'>;

export type JoseTicketVerifierOptions = Readonly<{
	replayGuard?: ReplayGuard;
	jwksResolver?: JWTVerifyGetKey;
	remoteJwksOptions?: Readonly<Pick<RemoteJWKSetOptions, 'cooldownDuration' | 'timeoutDuration'>>;
}>;

function invalidTicket(): never {
	throw new TicketVerificationError('invalid_ticket');
}

function boundedString(value: unknown, maxLength: number): string {
	if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
		invalidTicket();
	}
	return value;
}

function boundedCodePointString(value: unknown, maxLength: number): string {
	const result = boundedString(value, Number.POSITIVE_INFINITY);
	if (Array.from(result).length > maxLength) {
		invalidTicket();
	}
	return result;
}

function avatarUrl(value: unknown): string | null {
	if (value === null) {
		return null;
	}

	const result = boundedString(value, MAX_AVATAR_URL_LENGTH);
	try {
		new URL(result);
	} catch {
		invalidTicket();
	}
	return result;
}

function numericDate(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		invalidTicket();
	}
	return value;
}

function validatedIdentity(payload: JWTPayload): ArenaIdentity {
	return {
		userId: boundedString(payload.sub, MAX_USER_ID_LENGTH),
		displayName: boundedCodePointString(payload.name, MAX_DISPLAY_NAME_CODE_POINTS),
		avatarUrl: avatarUrl(payload.picture)
	};
}

export class JoseTicketVerifier implements TicketVerifier {
	readonly #issuer: string;
	readonly #audience: string;
	readonly #jwksResolver: JWTVerifyGetKey;
	readonly #replayGuard: ReplayGuard;

	constructor(config: TicketVerifierConfig, options: JoseTicketVerifierOptions = {}) {
		this.#issuer = config.irIssuer;
		this.#audience = config.arenaAudience;
		this.#jwksResolver =
			options.jwksResolver ??
			createRemoteJWKSet(new URL(config.irJwksUrl), options.remoteJwksOptions);
		this.#replayGuard = options.replayGuard ?? new ReplayGuard();
	}

	async verify(ticket: string, now: Date): Promise<VerifiedArenaTicket> {
		try {
			const nowMs = now.getTime();
			if (!Number.isFinite(nowMs)) {
				invalidTicket();
			}

			const { payload } = await jwtVerify(ticket, this.#jwksResolver, {
				algorithms: ['EdDSA'],
				issuer: this.#issuer,
				audience: this.#audience,
				currentDate: now,
				requiredClaims
			});

			const identity = validatedIdentity(payload);
			if (typeof payload.emailVerified !== 'boolean') {
				invalidTicket();
			}
			if (payload.purpose !== 'arena-connect' || payload.protocolMajor !== 1) {
				invalidTicket();
			}
			const protocolMinor = payload.protocolMinor;
			if (
				typeof protocolMinor !== 'number' ||
				!Number.isSafeInteger(protocolMinor) ||
				protocolMinor < 0
			) {
				invalidTicket();
			}

			const jti = boundedString(payload.jti, MAX_JTI_LENGTH);
			const issuedAtMs = numericDate(payload.iat) * 1_000;
			const expiresAtMs = numericDate(payload.exp) * 1_000;
			if (
				!Number.isFinite(issuedAtMs) ||
				!Number.isFinite(expiresAtMs) ||
				issuedAtMs > nowMs ||
				expiresAtMs <= nowMs ||
				expiresAtMs <= issuedAtMs ||
				expiresAtMs - issuedAtMs > MAX_TICKET_LIFETIME_MS
			) {
				invalidTicket();
			}

			const verifiedTicket: VerifiedArenaTicket = {
				identity,
				emailVerified: payload.emailVerified,
				jti,
				issuedAt: new Date(issuedAtMs),
				expiresAt: new Date(expiresAtMs),
				protocolMajor: 1,
				protocolMinor
			};

			if (!this.#replayGuard.consume(jti, expiresAtMs, nowMs)) {
				throw new TicketVerificationError('ticket_replayed');
			}

			return verifiedTicket;
		} catch (error) {
			if (error instanceof TicketVerificationError) {
				throw error;
			}
			throw new TicketVerificationError('invalid_ticket');
		}
	}
}
