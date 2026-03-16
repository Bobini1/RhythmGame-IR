import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getUserById } from '$lib/server/api/users.queries';
import { parseFields, pickFields, userLinks } from '$lib/server/api/utils';
import { db } from '$lib/server/database/client';
import { user } from '$lib/server/database/schemas/auth';
import { eq } from 'drizzle-orm';

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

export const GET: RequestHandler = async ({ params, url }) => {
	const id = Number(params.id);
	if (!id) {
		return json({ error: 'Missing id' }, { status: 400 });
	}
	if (!Number.isInteger(id) || id < 1) error(404, 'Player not found');
	const fields = parseFields(url);

	const profile = await getUserById(id);
	if (!profile) {
		return json({ error: 'User not found' }, { status: 404 });
	}

	const baseUrl = new URL(url.protocol + '//' + url.host);
	return json(
		pickFields(
			{
				...profile,
				_links: userLinks(baseUrl, id)
			},
			fields
		)
	);
};

export const DELETE: RequestHandler = async (event) => {
	try {
		const session = event.locals.session;
		if (!session || Number(event.locals.user.id) !== Number(event.params.user_id)) {
			return json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders });
		}

		await db.delete(user).where(eq(user.id, Number(event.locals.user.id)));

		return new Response(null, { status: 204, headers: corsHeaders });
	} catch (error) {
		console.error('Delete user error:', error);
		return json({ error: 'Internal server error' }, { status: 500, headers: corsHeaders });
	}
};