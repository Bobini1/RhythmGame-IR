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

	// range filters similar to /api/scores
	const lastPlayedGte = url.searchParams.get('last_played_gte');
	const lastPlayedLte = url.searchParams.get('last_played_lte');
	if (lastPlayedGte !== null && !isNaN(Number(lastPlayedGte))) filters.lastPlayedGte = Number(lastPlayedGte);
	if (lastPlayedLte !== null && !isNaN(Number(lastPlayedLte))) filters.lastPlayedLte = Number(lastPlayedLte);

	const dateGte = url.searchParams.get('date_gte');
	const dateLte = url.searchParams.get('date_lte');
	if (dateGte !== null && !isNaN(Number(dateGte))) filters.dateGte = Number(dateGte);
	if (dateLte !== null && !isNaN(Number(dateLte))) filters.dateLte = Number(dateLte);

	const scorePctGte = url.searchParams.get('score_pct_gte');
	const scorePctLte = url.searchParams.get('score_pct_lte');
	if (scorePctGte !== null && !isNaN(Number(scorePctGte))) filters.scorePctGte = Number(scorePctGte);
	if (scorePctLte !== null && !isNaN(Number(scorePctLte))) filters.scorePctLte = Number(scorePctLte);

	const comboGte = url.searchParams.get('combo_gte');
	const comboLte = url.searchParams.get('combo_lte');
	if (comboGte !== null && !isNaN(Number(comboGte))) filters.comboGte = Number(comboGte);
	if (comboLte !== null && !isNaN(Number(comboLte))) filters.comboLte = Number(comboLte);

	const missCountGte = url.searchParams.get('miss_count_gte');
	const missCountLte = url.searchParams.get('miss_count_lte');
	if (missCountGte !== null && !isNaN(Number(missCountGte))) filters.missCountGte = Number(missCountGte);
	if (missCountLte !== null && !isNaN(Number(missCountLte))) filters.missCountLte = Number(missCountLte);

	try {
		const [rows, total] = await Promise.all([
			queryScoreSummaries(filters, limit, offset, orderBy, sort, search),
			queryScoreSummariesCount(filters, search)
		]);

		const baseUrl = new URL(url.protocol + '//' + url.host);
		const data = rows.map((r) =>
			pickFields({ ...r, _links: scoreSummaryLinks(baseUrl, r.md5, r.userId, r) }, fields)
		);

		return json(data, {
			headers: collectionHeaders(url, total, limit, offset)
		});
	} catch (err) {
		console.error('[GET /api/score-summaries]', err);
		return json({ error: 'Internal server error' }, { status: 500 });
	}
};

