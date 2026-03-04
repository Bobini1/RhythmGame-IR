import { json, type RequestHandler } from '@sveltejs/kit';
import { queryUsers, queryUsersCount, type UsersOrderBy } from '$lib/server/api/queries';
import { parsePagination, parseSorting, collectionHeaders, userLinks } from '$lib/server/api/utils';

const VALID_ORDER_BY = new Set<UsersOrderBy>(['name', 'score_count']);

export const GET: RequestHandler = async ({ url }) => {
	const { limit, offset } = parsePagination(url);
	const { orderBy, sort } = parseSorting(url, VALID_ORDER_BY, 'score_count');

	try {
		const [rows, total] = await Promise.all([
			queryUsers(limit, offset, orderBy, sort),
			queryUsersCount()
		]);

		const data = rows.map((r) => ({
			...r,
			_links: userLinks(r.id)
		}));

		return json(data, {
			headers: collectionHeaders(url, total, limit, offset)
		});
	} catch (err) {
		console.error('[GET /api/users]', err);
		return json({ error: 'Internal server error' }, { status: 500 });
	}
};

