import { json, type RequestHandler } from '@sveltejs/kit';
import { APIError } from 'better-auth';

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

export const OPTIONS: RequestHandler = async () => {
	return new Response(null, {
		status: 204,
		headers: corsHeaders
	});
};

export const GET: RequestHandler = async (event) => {
	try {
		const session = event.locals.session;

		if (!session) {
			return json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders });
		}

		return json(
			{
				user: event.locals.user
			},
			{ headers: corsHeaders }
		);
	} catch (error) {
		console.error('Get user error:', error);
		if (error instanceof APIError) {
			const status = typeof error.status === 'number' ? error.status : 400;
			return json({ error: error.message }, { status, headers: corsHeaders });
		}
		return json({ error: 'Internal server error' }, { status: 500, headers: corsHeaders });
	}
};
