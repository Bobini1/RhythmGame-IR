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
import { BaseUrl } from '$lib/api/configurations/common';
import { imageUrlFromUserId } from '$lib/utils/imageUrlFromUserId';
import { createMetaTags } from '$lib/client/configurations/meta-tags';

const DEFAULT_PAGE_SIZE = 25;
const VALID_SORT_COLUMNS = new Set<ChartUserSortableColumn>([
	'score_pct', 'grade', 'combo', 'clear_type', 'date',
	'poor', 'empty_poor', 'bad', 'good', 'great', 'perfect', 'mine_hit'
]);

export const load: PageServerLoad = async ({ params, url, setHeaders }) => {
	const { md5, user_id } = params;
	const userId = Number(user_id);

	const [chart, profile] = await Promise.all([getChartByMd5(md5), getUserProfile(userId)]);

	if (!chart) error(404, 'Chart not found');
	if (!profile) error(404, 'Player not found');

	const page = Math.max(0, Number(url.searchParams.get('page') ?? 0));
	const pageSize = Math.min(
		100,
		Math.max(1, Number(url.searchParams.get('limit') ?? DEFAULT_PAGE_SIZE))
	);
	const offset = page * pageSize;

	const rawSortBy = url.searchParams.get('sortBy') ?? '';
	const sortBy: ChartUserSortableColumn = VALID_SORT_COLUMNS.has(rawSortBy as ChartUserSortableColumn)
		? (rawSortBy as ChartUserSortableColumn)
		: 'date';
	const sortDir: 'asc' | 'desc' = url.searchParams.get('sortDir') === 'asc' ? 'asc' : 'desc';

	const [scores, total] = await Promise.all([
		getChartUserScores(md5, userId, pageSize, offset, sortBy, sortDir),
		getChartUserScoreCount(md5, userId)
	]);

	setHeaders(pageCollectionHeaders(url, total, pageSize, page));

	const chartTitle = chart.subtitle ? `${chart.title} ${chart.subtitle}` : chart.title;

	const jsonLd = {
		'@type': 'ItemList',
		name: `${profile.name} scores on ${chartTitle}`,
		url: `${BaseUrl}/charts/${chart.md5}/players/${profile.id}/scores`,
		numberOfItems: total,
		about: [
			{
				'@type': 'MusicComposition',
				name: chartTitle,
				url: `${BaseUrl}/charts/${chart.md5}`,
				identifier: chart.md5
			},
			{
				'@type': 'Person',
				name: profile.name,
				image: imageUrlFromUserId(profile.id),
				url: `${BaseUrl}/players/${profile.id}`
			}
		],
		itemListElement: scores.map((score, i) => ({
			'@type': 'ListItem',
			position: i + 1 + page * pageSize,
			name: `${profile.name} - ${score.clearType} - ${score.points}`
		}))
	};

	// Use user's profile image if available for OG image
	const ogImage = profile.image ?? imageUrlFromUserId(profile.id, 'png');
	let title = t.get('charts.user_scores.title', { player: profile.name, chart: chartTitle });
	let description = t.get('charts.user_scores.description', { player: profile.name });

	// Provide i18n keys with interpolation vars to createMetaTags
	const meta = createMetaTags(, title, description, undefined, {
		vars: { player: profile.name, chart: chartTitle },
		image: ogImage,
		titleIsKey: false,
		descriptionIsKey: false
	});

	return { chart, profile, scores, total, page, pageSize, sortBy, sortDir, jsonLd, meta };
};


