import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { getUserProfile, getUserScores, getUserScoreCount } from '$lib/server/scores/query';
import type { SortableColumn } from '$lib/server/scores/query';

const DEFAULT_PAGE_SIZE = 10;
const VALID_SORT_COLUMNS = new Set<SortableColumn>(['title', 'score_pct', 'grade', 'combo', 'clear_type', 'date']);

export const load: PageServerLoad = async ({ params, url }) => {
	const userId = params.user_id;

	const profile = await getUserProfile(userId);
	if (!profile) {
		error(404, 'Player not found');
	}

	const page = Math.max(0, Number(url.searchParams.get('page') ?? 0));
	const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? DEFAULT_PAGE_SIZE)));
	const offset = page * pageSize;

	const rawSortBy = url.searchParams.get('sortBy') ?? '';
	const sortBy = VALID_SORT_COLUMNS.has(rawSortBy as SortableColumn)
		? (rawSortBy as SortableColumn)
		: null;
	const sortDir = url.searchParams.get('sortDir') === 'asc' ? 'asc' : 'desc';
	const search = url.searchParams.get('search') ?? '';

	const [scores, total] = await Promise.all([
		getUserScores(userId, pageSize, offset, sortBy, sortDir, search),
		getUserScoreCount(userId, search)
	]);

	return {
		profile,
		scores,
		total,
		page,
		pageSize,
		sortBy,
		sortDir,
		search
	};
};
