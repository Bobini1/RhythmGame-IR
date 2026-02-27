import { auth } from '$lib/server/auth/config';
import { json, type RequestHandler } from '@sveltejs/kit';
import { APIError } from 'better-auth';

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type'
};

export const OPTIONS: RequestHandler = async () => {
	return new Response(null, {
		status: 204,
		headers: corsHeaders
	});
};

export const POST: RequestHandler = async ({ request }) => {
	try {
		const { email, password } = await request.json();

		if (!email || !password) {
			return json(
				{ error: 'Email and password are required' },
				{ status: 400, headers: corsHeaders }
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
				user: result.user,
				token: result.token
			},
			{ headers: corsHeaders }
		);
	} catch (error) {
		console.error('Native sign-in error:', error);
		if (error instanceof APIError) {
			const status = typeof error.status === 'number' ? error.status : 400;
			return json({ error: error.message }, { status, headers: corsHeaders });
		}
		return json({ error: 'Internal server error' }, { status: 500, headers: corsHeaders });
	}
};
