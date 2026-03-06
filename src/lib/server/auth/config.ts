import { db } from '$lib/server/database/client';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { betterAuth } from 'better-auth';
import { bearer } from 'better-auth/plugins/bearer';
import { account, session, user, verification } from '../database/schemas/auth';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { getRequestEvent } from '$app/server';
import { env } from '$env/dynamic/private';
import { captcha, openAPI } from 'better-auth/plugins';

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
		// sendResetPassword: async ({ user, url, token }, request) => {
		// 	void sendEmail({
		// 		to: user.email,
		// 		subject: 'Reset your password',
		// 		text: `Click the link to reset your password: ${url}`
		// 	});
		// }
	},
	// requireEmailVerification: true,
	baseURL: env.BETTER_AUTH_URL,
	advanced: {
		database: {
			generateId: 'serial' // "serial" for auto-incrementing numeric IDs
		}
	},
	plugins: [
		bearer(),
		openAPI(),
		captcha({
			provider: 'cloudflare-turnstile',
			secretKey: env.TURNSTILE_SECRET_KEY!,
			endpoints: ["/sign-up/email", "/forget-password"]
		}),
		sveltekitCookies(getRequestEvent)
	]
});
