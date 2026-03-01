import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import {
	getChartBySha256,
	getChartScores,
	getChartScoreCount
} from '$lib/server/scores/query';
import type { ChartSortableColumn } from '$lib/server/scores/query';

const DEFAULT_PAGE_SIZE = 20;
const VALID_SORT_COLUMNS = new Set<ChartSortableColumn>([
	'player',
	'score_pct',
	'grade',
	'combo',
	'combo_breaks',
	'date'
]);

export const load: PageServerLoad = async ({ params, url }) => {
	const sha256 = params.sha256;

	const chart = await getChartBySha256(sha256);
	if (!chart) {
		error(404, 'Chart not found');
	}

	const page = Math.max(0, Number(url.searchParams.get('page') ?? 0));
	const pageSize = Math.min(
		100,
		Math.max(1, Number(url.searchParams.get('limit') ?? DEFAULT_PAGE_SIZE))
	);
	const offset = page * pageSize;

	const rawSortBy = url.searchParams.get('sortBy') ?? '';
	const sortBy: ChartSortableColumn = VALID_SORT_COLUMNS.has(rawSortBy as ChartSortableColumn)
		? (rawSortBy as ChartSortableColumn)
		: 'score_pct';
	const sortDir: 'asc' | 'desc' = url.searchParams.get('sortDir') === 'asc' ? 'asc' : 'desc';

	const [chartScores, total] = await Promise.all([
		getChartScores(sha256, pageSize, offset, sortBy, sortDir),
		getChartScoreCount(sha256)
	]);

	return {
		chart,
		scores: chartScores,
		total,
		page,
		pageSize,
		sortBy,
		sortDir
	};
};




