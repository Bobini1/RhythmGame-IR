import { json, type RequestHandler } from '@sveltejs/kit';
import {
	queryScoreSummaries,
	queryScoreSummariesCount,
	type ScoreSummariesOrderBy
} from '$lib/server/api/queries';
import {
	parsePagination,
	parseSorting,
	collectionHeaders,
	scoreSummaryLinks
} from '$lib/server/api/utils';

const VALID_ORDER_BY = new Set<ScoreSummariesOrderBy>([
	'player',
	'score_pct',
	'grade',
	'combo',
	'combo_breaks',
	'clear_type',
	'date',
	'play_count'
]);

export const GET: RequestHandler = async ({ url }) => {
	const chart = url.searchParams.get('chart');
	if (!chart) {
		return json({ error: 'Missing required query parameter: chart' }, { status: 400 });
	}

	const { limit, offset } = parsePagination(url);
	const { orderBy, sort } = parseSorting(url, VALID_ORDER_BY, 'score_pct');
	const search = url.searchParams.get('search') ?? '';

	try {
		const [rows, total] = await Promise.all([
			queryScoreSummaries(chart, limit, offset, orderBy, sort, search),
			queryScoreSummariesCount(chart, search)
		]);

		const data = rows.map((r) => ({
			...r,
			_links: scoreSummaryLinks(chart, r.userId)
		}));

		return json(data, {
			headers: collectionHeaders(url, total, limit, offset)
		});
	} catch (err) {
		console.error('[GET /api/score_summaries]', err);
		return json({ error: 'Internal server error' }, { status: 500 });
	}
};

