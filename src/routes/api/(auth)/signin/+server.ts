import { auth } from '$lib/server/auth/config';
import { json, type RequestHandler } from '@sveltejs/kit';
import { APIError } from 'better-auth';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const { email, password } = await request.json();

		if (!email || !password) {
			return json(
				{ error: 'Email and password are required' },
				{ status: 400 }
			);
		}

		const result = await auth.api.signInEmail({
			body: {
				email,
				password
			}
		});

		return json(
			{
				token: result.token
			}
		);
	} catch (error) {
		console.error('Sign-in error:', error);
		if (error instanceof APIError) {
			const status = typeof error.status === 'number' ? error.status : 400;
			return json({ error: error.message }, { status });
		}
		return json({ error: 'Internal server error' }, { status: 500 });
	}
};
