import { json, type RequestHandler } from '@sveltejs/kit';
import {
	queryCharts,
	queryChartsCount,
	type ChartsOrderBy,
	type ChartsCollectionFilters
} from '$lib/server/api/charts.queries';
import {
	parsePagination,
	parseSorting,
	collectionHeaders,
	chartLinks,
	parseFields,
	pickFields
} from '$lib/server/api/utils';

const VALID_ORDER_BY = new Set<ChartsOrderBy>(['title', 'play_count', 'play_level', 'score_count', 'player_count']);

export const GET: RequestHandler = async ({ url }) => {
	const { limit, offset } = parsePagination(url);
	const { orderBy, sort } = parseSorting(url, VALID_ORDER_BY, 'play_count');
	const fields = parseFields(url);

	const filters: ChartsCollectionFilters = {};

	const query = url.searchParams.get('query');
	if (query) filters.query = query;

	const keymodeGte = url.searchParams.get('keymode_gte');
	const keymodeLte = url.searchParams.get('keymode_lte');
	if (keymodeGte !== null && !isNaN(Number(keymodeGte))) filters.keymodeGte = Number(keymodeGte);
	if (keymodeLte !== null && !isNaN(Number(keymodeLte))) filters.keymodeLte = Number(keymodeLte);

	const playLevelGte = url.searchParams.get('play_level_gte');
	const playLevelLte = url.searchParams.get('play_level_lte');
	if (playLevelGte !== null && !isNaN(Number(playLevelGte))) filters.playLevelGte = Number(playLevelGte);
	if (playLevelLte !== null && !isNaN(Number(playLevelLte))) filters.playLevelLte = Number(playLevelLte);

	try {
		const [rows, total] = await Promise.all([
			queryCharts(filters, limit, offset, orderBy, sort),
			queryChartsCount(filters)
		]);

		const data = rows.map((r) =>
			pickFields({ ...r, _links: chartLinks(r.md5) }, fields)
		);

		return json(data, {
			headers: collectionHeaders(url, total, limit, offset)
		});
	} catch (err) {
		console.error('[GET /api/charts]', err);
		return json({ error: 'Internal server error' }, { status: 500 });
	}
};

