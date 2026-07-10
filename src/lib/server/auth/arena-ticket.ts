import type { BetterAuthOptions } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { jwt } from 'better-auth/plugins';

export const ARENA_ISSUER = 'https://rhythmgame.eu';
export const ARENA_AUDIENCE = 'https://arena.rhythmgame.eu';

export function createArenaJwtPlugin() {
	return jwt({
		disableSettingJwtHeader: true,
		jwks: {
			keyPairConfig: { alg: 'EdDSA', crv: 'Ed25519' },
			rotationInterval: 60 * 60 * 24 * 30,
			gracePeriod: 60 * 60 * 24
		},
		jwt: {
			issuer: ARENA_ISSUER,
			audience: ARENA_AUDIENCE,
			expirationTime: '90s',
			definePayload: ({ user }) => ({
				name: user.name,
				picture: user.image ?? null,
				emailVerified: user.emailVerified,
				purpose: 'arena-connect',
				protocolMajor: 1,
				protocolMinor: 1,
				jti: crypto.randomUUID()
			})
		}
	});
}

export const arenaTicketNoStoreHook = createAuthMiddleware(async (ctx) => {
	if (ctx.path === '/token') {
		ctx.setHeader('Cache-Control', 'no-store');
	}
});

export function createArenaAuthOptions() {
	return {
		hooks: { after: arenaTicketNoStoreHook },
		plugins: [createArenaJwtPlugin()]
	} satisfies Pick<BetterAuthOptions, 'hooks' | 'plugins'>;
}
