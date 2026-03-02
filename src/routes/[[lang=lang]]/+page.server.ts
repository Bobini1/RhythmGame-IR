import { getUserCookiesPreferences } from '$lib/manage-cookies/manager';
import type { PageServerLoad } from './$types';
import { getLatestScores, getLatestScoreCount } from '$lib/server/scores/query';

const DEFAULT_PAGE_SIZE = 10;

export const load: PageServerLoad = async (event) => {
	const showManageCookiesPreferences = event.cookies.get('show-manage-cookies-banner');
	const cookieBannerOpen =
		showManageCookiesPreferences === 'true' || showManageCookiesPreferences === undefined;

	const page = Math.max(0, Number(event.url.searchParams.get('page') ?? 0));
	const pageSize = Math.min(
		100,
		Math.max(1, Number(event.url.searchParams.get('limit') ?? DEFAULT_PAGE_SIZE))
	);
	const offset = page * pageSize;

	const [latestScores, total] = await Promise.all([
		getLatestScores(pageSize, offset),
		getLatestScoreCount()
	]);

	return {
		cookieBannerOpen,
		cookiePreferences: getUserCookiesPreferences(event),
		latestScores,
		total,
		page,
		pageSize
	};
};
