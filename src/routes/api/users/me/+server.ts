import { json, type RequestHandler } from '@sveltejs/kit';
import { APIError } from 'better-auth';
import { db } from '$lib/server/database/client';
import { user } from '$lib/server/database/schemas/auth';
import { eq } from 'drizzle-orm';
import { parseFields, pickFields, userLinks } from '$lib/server/api/utils';

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
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
		const fields = parseFields(event.url);

		const baseUrl = new URL(event.url.protocol + '://' + event.url.host);
		return json(
			pickFields(
				{
					...event.locals.user,
					_links: userLinks(baseUrl, Number(event.locals.user.id))
				},
				fields
			),
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

export const DELETE: RequestHandler = async (event) => {
	try {
		const session = event.locals.session;
		if (!session) {
			return json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders });
		}

		await db.delete(user).where(eq(user.id, Number(event.locals.user.id)));

		return new Response(null, { status: 204, headers: corsHeaders });
	} catch (error) {
		console.error('Delete user error:', error);
		return json({ error: 'Internal server error' }, { status: 500, headers: corsHeaders });
	}
};

