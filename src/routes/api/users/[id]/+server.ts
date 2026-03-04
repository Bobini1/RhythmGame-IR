import { json, type RequestHandler } from '@sveltejs/kit';
import { getUserById } from '$lib/server/api/queries';
import { userLinks } from '$lib/server/api/utils';

export const GET: RequestHandler = async ({ params }) => {
	const id = params.id;
	if (!id) {
		return json({ error: 'Missing id' }, { status: 400 });
	}

	const profile = await getUserById(id);
	if (!profile) {
		return json({ error: 'User not found' }, { status: 404 });
	}

	return json({
		...profile,
		_links: userLinks(id)
	});
};

