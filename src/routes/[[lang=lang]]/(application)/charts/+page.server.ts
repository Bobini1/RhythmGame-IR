import type { PageServerLoad } from './$types';
import { getChartList, getChartListCount } from '$lib/server/scores/query';
import type { ChartListSortColumn } from '$lib/server/scores/query';
import { pageCollectionHeaders } from '$lib/server/api/utils';
import { BaseUrl } from '$lib/api/configurations/common';
import { createMetaTags } from '$lib/client/configurations/meta-tags';

const DEFAULT_PAGE_SIZE = 25;
const VALID_SORT_COLUMNS = new Set<ChartListSortColumn>(['title', 'play_count', 'artist']);

export const load: PageServerLoad = async ({ url, setHeaders }) => {
	const page = Math.max(0, Number(url.searchParams.get('page') ?? 0));
	const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? DEFAULT_PAGE_SIZE)));
	const offset = page * pageSize;

	const rawSortBy = url.searchParams.get('sortBy') ?? '';
	const sortBy: ChartListSortColumn = VALID_SORT_COLUMNS.has(rawSortBy as ChartListSortColumn)
		? (rawSortBy as ChartListSortColumn)
		: 'play_count';
	const sortDir: 'asc' | 'desc' = url.searchParams.get('sortDir') === 'asc' ? 'asc' : 'desc';

	const search = url.searchParams.get('search')?.trim() ?? '';

	const [chartList, total] = await Promise.all([getChartList(pageSize, offset, sortBy, sortDir, search), getChartListCount(search)]);

	setHeaders(pageCollectionHeaders(url, total, pageSize, page));

	const jsonLd = {
		'@type': 'ItemList',
		name: 'Charts',
		url: `${BaseUrl}/charts`,
		numberOfItems: total,
		itemListElement: chartList.map((chart, i) => ({
			'@type': 'ListItem',
			position: i + 1 + page * pageSize,
			name: chart.subtitle ? `${chart.title} ${chart.subtitle}` : chart.title,
			url: `${BaseUrl}/charts/${chart.md5}`
		}))
	};

	const meta = createMetaTags("charts.list.title", "charts.list.description");

	return { chartList, total, page, pageSize, sortBy, sortDir, search, jsonLd, meta };
};
