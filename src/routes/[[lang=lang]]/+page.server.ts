import { getUserCookiesPreferences } from '$lib/manage-cookies/manager';
import type { PageServerLoad } from './$types';
import { getLatestScores, getLatestScoreCount } from '$lib/server/scores/query';
import { pageCollectionHeaders } from '$lib/server/api/utils';

const DEFAULT_PAGE_SIZE = 10;

interface GitHubRelease {
	tag_name: string;
	name: string;
	published_at: string;
	html_url: string;
}

// Simple in-memory cache
let releaseCache: { data: GitHubRelease | null; timestamp: number } | null = null;
const CACHE_DURATION = 15 * 60 * 1000; // 15 minutes in milliseconds

async function getLatestRelease(): Promise<GitHubRelease | null> {
	// Check cache first
	if (releaseCache && Date.now() - releaseCache.timestamp < CACHE_DURATION) {
		return releaseCache.data;
	}

	try {
		const response = await fetch('https://api.github.com/repos/Bobini1/RhythmGame/releases/latest', {
			headers: {
				'Accept': 'application/vnd.github+json',
				'User-Agent': 'RhythmGame-Website'
			}
		});

		if (!response.ok) {
			console.error('Failed to fetch GitHub release:', response.status);
			return null;
		}

		const data = await response.json();

		// Update cache
		releaseCache = {
			data,
			timestamp: Date.now()
		};

		return data;
	} catch (error) {
		console.error('Error fetching GitHub release:', error);
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
		getLatestRelease()
	]);

	event.setHeaders(pageCollectionHeaders(event.url, total, pageSize, page));

	return {
		cookieBannerOpen,
		cookiePreferences: getUserCookiesPreferences(event),
		latestScores,
		total,
		page,
		pageSize,
		latestRelease
	};
};
