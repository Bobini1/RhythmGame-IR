import { json, type RequestHandler } from '@sveltejs/kit';
import { auth } from '$lib/server/auth/config';
import type { BetterAuthError } from 'better-auth';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const { email, password } = await request.json();

		if (!email || !password) {
			return json({ error: 'Missing email or password' }, { status: 400 });
		}

		// Use better-auth's signIn method
		const result = await auth.api.signIn.email({
			body: {
				email,
				password
			}
		});

		if (!result.data) {
			return json({ error: 'Authentication failed' }, { status: 401 });
		}

		// The bearer plugin should have added a token to the response
		// Extract it from headers or response data
		const token =
			result.headers?.get('authorization')?.replace('Bearer ', '') || (result.data as any).token;

		if (!token) {
			return json({ error: 'Token not generated' }, { status: 500 });
		}

		return json({
			user: {
				id: result.data.user.id,
				email: result.data.user.email,
				name: result.data.user.name,
				image: result.data.user.image
			},
			token,
			expiresAt: result.data.session.expiresAt
		});
	} catch (error) {
		console.error('[POST /api/auth/native-signin]', error);
		const err = error as BetterAuthError;
		return json({ error: err.message || 'Internal server error' }, { status: err.status || 500 });
	}
};
