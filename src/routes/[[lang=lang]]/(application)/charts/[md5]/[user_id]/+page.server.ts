import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import {
	getChartByMd5,
	getChartUserScores,
	getChartUserScoreCount,
	getUserProfile
} from '$lib/server/scores/query';
import type { ChartUserSortableColumn } from '$lib/server/scores/query';
import { pageCollectionHeaders } from '$lib/server/api/utils';

const DEFAULT_PAGE_SIZE = 20;
const VALID_SORT_COLUMNS = new Set<ChartUserSortableColumn>([
	'score_pct', 'grade', 'combo', 'clear_type', 'date',
	'poor', 'empty_poor', 'bad', 'good', 'great', 'perfect', 'mine_hit'
]);

export const load: PageServerLoad = async ({ params, url, setHeaders }) => {
	const { md5, user_id } = params;

	const [chart, profile] = await Promise.all([getChartByMd5(md5), getUserProfile(user_id)]);

	if (!chart) error(404, 'Chart not found');
	if (!profile) error(404, 'Player not found');

	const page = Math.max(0, Number(url.searchParams.get('page') ?? 0));
	const pageSize = Math.min(
		100,
		Math.max(1, Number(url.searchParams.get('limit') ?? DEFAULT_PAGE_SIZE))
	);
	const offset = page * pageSize;

	const rawSortBy = url.searchParams.get('sortBy') ?? '';
	const sortBy = VALID_SORT_COLUMNS.has(rawSortBy as ChartUserSortableColumn)
		? (rawSortBy as ChartUserSortableColumn)
		: null;
	const sortDir = url.searchParams.get('sortDir') === 'asc' ? 'asc' : 'desc';

	const [scores, total] = await Promise.all([
		getChartUserScores(md5, user_id, pageSize, offset, sortBy, sortDir),
		getChartUserScoreCount(md5, user_id)
	]);

	setHeaders(pageCollectionHeaders(url, total, pageSize, page));

	return { chart, profile, scores, total, page, pageSize, sortBy, sortDir };
};


