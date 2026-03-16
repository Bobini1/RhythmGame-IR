import { json, type RequestHandler } from '@sveltejs/kit';
import {
	queryScoreSummaries,
	queryScoreSummariesCount,
	type ScoreSummariesOrderBy,
	type ScoreSummaryFilters
} from '$lib/server/api/score-summaries.queries';
import {
	parsePagination,
	parseSorting,
	collectionHeaders,
	scoreSummaryLinks,
	parseFields,
	pickFields
} from '$lib/server/api/utils';
import type { ScoresCollectionFilters } from '$lib/server/api/scores.queries';

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
	const filters: ScoreSummaryFilters = {};
	const { limit, offset } = parsePagination(url);
	const { orderBy, sort } = parseSorting(url, VALID_ORDER_BY, 'score_pct');
	const search = url.searchParams.get('search') ?? '';
	const userParam = url.searchParams.get('user');
	if (userParam !== null && !isNaN(Number(userParam))) filters.user = Number(userParam);
	const fields = parseFields(url);
	const md5 = url.searchParams.get('md5');
	if (md5 !== null) filters.md5 = md5;

	try {
		const [rows, total] = await Promise.all([
			queryScoreSummaries(filters, limit, offset, orderBy, sort, search),
			queryScoreSummariesCount(filters, search)
		]);

		const baseUrl = new URL(url.protocol + '//' + url.host);
		const data = rows.map((r) =>
			pickFields({ ...r, _links: scoreSummaryLinks(baseUrl, r.md5, r.user.id) }, fields)
		);

		return json(data, {
			headers: collectionHeaders(url, total, limit, offset)
		});
	} catch (err) {
		console.error('[GET /api/score-summaries]', err);
		return json({ error: 'Internal server error' }, { status: 500 });
	}
};

