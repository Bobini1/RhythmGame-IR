import { db } from '$lib/server/database/client';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { betterAuth } from 'better-auth';
import { bearer } from 'better-auth/plugins/bearer';
import { account, session, user, verification } from '../database/schemas/auth';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { getRequestEvent } from '$app/server';
import { env } from '$env/dynamic/private';
import { captcha, openAPI } from 'better-auth/plugins';
import { resend } from '$lib/server/email/resend';

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
		enabled: true,
		sendResetPassword: async ({ user, url }) => {
			await resend.emails.send({
				from: 'RhythmGame <noreply@rhythmgame.eu>',
				to: user.email,
				subject: 'Reset your password',
				html: `<p>Click <a href="${url}">here</a> to reset your password.</p>`
			});
		}
	},
	emailVerification: {
		sendVerificationEmail: async ({ user, url }) => {
			await resend.emails.send({
				from: 'RhythmGame <noreply@rhythmgame.eu>',
				to: user.email,
				subject: 'Verify your email',
				html: `<p>Click <a href="${url}">here</a> to verify your email.</p>`
			});
		}
	},
	requireEmailVerification: true,
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
			endpoints: ['/sign-up/email', '/forget-password']
		}),
		sveltekitCookies(getRequestEvent)
	]
});
