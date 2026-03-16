import { json, type RequestHandler } from '@sveltejs/kit';
import { queryUsers, queryUsersCount, type UsersOrderBy } from '$lib/server/api/users.queries';
import {
	parsePagination,
	parseSorting,
	collectionHeaders,
	userLinks,
	parseFields,
	pickFields
} from '$lib/server/api/utils';

const VALID_ORDER_BY = new Set<UsersOrderBy>(['name', 'score_count', 'chart_count']);

export const GET: RequestHandler = async ({ url }) => {
	const { limit, offset } = parsePagination(url);
	const { orderBy, sort } = parseSorting(url, VALID_ORDER_BY, 'score_count');
	const fields = parseFields(url);

	try {
		const [rows, total] = await Promise.all([
			queryUsers(limit, offset, orderBy, sort),
			queryUsersCount()
		]);

		const baseUrl = new URL(url.protocol + '//' + url.host);
		const data = rows.map((r) => pickFields({ ...r, _links: userLinks(baseUrl, r.id) }, fields));

		return json(data, {
			headers: collectionHeaders(url, total, limit, offset)
		});
	} catch (err) {
		console.error('[GET /api/users]', err);
		return json({ error: 'Internal server error' }, { status: 500 });
	}
};

