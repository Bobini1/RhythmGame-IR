import { db } from '$lib/server/database/client';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { betterAuth } from 'better-auth';
import { account, session, user, verification } from '../database/schemas/auth';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { getRequestEvent } from '$app/server';
import { env } from '$env/dynamic/private';
import { oAuthProxy } from 'better-auth/plugins/oauth-proxy';

export const auth = betterAuth({
	database: drizzleAdapter(db, {
		provider: 'pg',
		schema: {
			user,
			session,
			account,
			verification
		}
	}),
	emailAndPassword: {
		enabled: true
	},
	socialProviders: {
		google: {
			clientId: env.GOOGLE_CLIENT_ID as string,
			clientSecret: env.GOOGLE_CLIENT_SECRET as string
		}
	},
	plugins: [
		// sync set-cookie headers into SvelteKit's cookie jar
		sveltekitCookies(getRequestEvent),
		// enable the OAuth proxy which can: wrap state/cookies for cross-origin flows,
		// set cookies via a proxy callback, and finally redirect to the original callback URL
		oAuthProxy({
			// productionURL should point to your production auth host if different
			productionURL: env.BETTER_AUTH_URL || env.PUBLIC_BETTER_AUTH_URL || undefined,
			// keep short to limit replay window for the encrypted cookie payload
			maxAge: 60
		})
	]
});
