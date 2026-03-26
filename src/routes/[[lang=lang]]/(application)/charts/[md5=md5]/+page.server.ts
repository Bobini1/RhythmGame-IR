import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import {
	getChartByMd5,
	getChartScores,
	getChartScoreCount
} from '$lib/server/scores/query';
import type { ChartSortableColumn } from '$lib/server/scores/query';
import { pageCollectionHeaders } from '$lib/server/api/utils';
import { BaseUrl } from '$lib/api/configurations/common';

const DEFAULT_PAGE_SIZE = 10;
const VALID_SORT_COLUMNS = new Set<ChartSortableColumn>([
	'player',
	'score_pct',
	'grade',
	'combo',
	'combo_breaks',
	'play_count',
	'clear_type',
	'date'
]);

export const load: PageServerLoad = async ({ params, url, setHeaders }) => {
	const md5 = params.md5;

	const chart = await getChartByMd5(md5);
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
	const search = url.searchParams.get('search') ?? '';

	const [chartScores, total] = await Promise.all([
		getChartScores(md5, pageSize, offset, sortBy, sortDir, search),
		getChartScoreCount(md5, search)
	]);

	setHeaders(pageCollectionHeaders(url, total, pageSize, page));

	const jsonLd = {
		'@type': 'MusicComposition',
		name: chart.subtitle ? `${chart.title} ${chart.subtitle}` : chart.title,
		url: `${BaseUrl}/charts/${chart.md5}`,
		composer: { '@type': 'Person', name: chart.subartist ? `${chart.artist} (${chart.subartist})` : chart.artist },
		genre: chart.genre ?? undefined,
		identifier: chart.md5
	};

	return {
		chart,
		scores: chartScores,
		total,
		page,
		pageSize,
		sortBy,
		sortDir,
		search,
		jsonLd
	};
};




