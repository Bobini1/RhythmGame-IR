import { getUserCookiesPreferences } from '$lib/manage-cookies/manager';
import type { PageServerLoad } from './$types';
import { getLatestScores, getLatestScoreCount } from '$lib/server/scores/query';
import { pageCollectionHeaders } from '$lib/server/api/utils';
import { BaseUrl } from '$lib/api/configurations/common';

const DEFAULT_PAGE_SIZE = 10;

interface GitHubRelease {
	tag_name: string;
	name: string;
	published_at: string;
	html_url: string;
}

let cachedRelease: { data: GitHubRelease | null; fetchedAt: number } | null = null;
const CACHE_TTL = 1000 * 60 * 60;

async function getLatestRelease(fetchFunc: typeof fetch): Promise<GitHubRelease | null> {
	if (cachedRelease && Date.now() - cachedRelease.fetchedAt < CACHE_TTL) {
		return cachedRelease.data;
	}

	try {
		const response = await fetchFunc(
			'https://api.github.com/repos/Bobini1/RhythmGame/releases/latest',
			{
				headers: {
					Accept: 'application/vnd.github+json',
					'User-Agent': 'RhythmGame-Website'
				}
			}
		);

		if (!response.ok) {
			console.error('Failed to fetch GitHub release:', response.status);
			cachedRelease = { data: null, fetchedAt: Date.now() };
			return null;
		}

		const data = await response.json();
		cachedRelease = { data, fetchedAt: Date.now() };
		return data;
	} catch (error) {
		console.error('Error fetching GitHub release:', error);
		cachedRelease = { data: null, fetchedAt: Date.now() };
		return null;
	}
}

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

	const [latestScores, total, latestRelease] = await Promise.all([
		getLatestScores(pageSize, offset),
		getLatestScoreCount(),
		getLatestRelease(event.fetch)
	]);

	event.setHeaders(pageCollectionHeaders(event.url, total, pageSize, page));

	let jsonLd = {
		'@graph': [
			{
				'@type': 'WebSite',
				name: 'RhythmGame',
				url: BaseUrl,
				description: 'Configurable BMS player for Windows and Linux'
			},
			{
				'@type': 'SoftwareApplication',
				name: 'RhythmGame',
				url: BaseUrl,
				operatingSystem: 'Windows, Linux',
				applicationCategory: 'GameApplication',
				offers: {
					'@type': 'Offer',
					price: '0',
					priceCurrency: 'USD'
				},
				downloadUrl: latestRelease?.html_url ?? undefined,
				softwareVersion: latestRelease?.tag_name ?? undefined,
				datePublished: latestRelease?.published_at ?? undefined
			}
		]
	};

	return {
		cookieBannerOpen,
		cookiePreferences: getUserCookiesPreferences(event),
		latestScores,
		total,
		page,
		pageSize,
		latestRelease,
		jsonLd
	};
};
