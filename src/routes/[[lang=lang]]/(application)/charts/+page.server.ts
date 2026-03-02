import type { PageServerLoad } from './$types';
import { getChartList, getChartListCount } from '$lib/server/scores/query';
import type { ChartListSortColumn } from '$lib/server/scores/query';

const DEFAULT_PAGE_SIZE = 20;
const VALID_SORT_COLUMNS = new Set<ChartListSortColumn>(['title', 'play_count']);

export const load: PageServerLoad = async ({ url }) => {
	const page = Math.max(0, Number(url.searchParams.get('page') ?? 0));
	const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? DEFAULT_PAGE_SIZE)));
	const offset = page * pageSize;

	const rawSortBy = url.searchParams.get('sortBy') ?? '';
	const sortBy: ChartListSortColumn = VALID_SORT_COLUMNS.has(rawSortBy as ChartListSortColumn)
		? (rawSortBy as ChartListSortColumn)
		: 'play_count';
	const sortDir: 'asc' | 'desc' = url.searchParams.get('sortDir') === 'asc' ? 'asc' : 'desc';

	const [chartList, total] = await Promise.all([getChartList(pageSize, offset, sortBy, sortDir), getChartListCount()]);

	return { chartList, total, page, pageSize, sortBy, sortDir };
};
