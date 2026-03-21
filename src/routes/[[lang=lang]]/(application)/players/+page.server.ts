import type { PageServerLoad } from './$types';
import { getUserList, getUserListCount } from '$lib/server/scores/query';
import type { UserListSortColumn } from '$lib/server/scores/query';
import { pageCollectionHeaders } from '$lib/server/api/utils';

const DEFAULT_PAGE_SIZE = 25;
const VALID_SORT_COLUMNS = new Set<UserListSortColumn>(['name', 'score_count', 'joined']);

export const load: PageServerLoad = async ({ url, setHeaders }) => {
	const page = Math.max(0, Number(url.searchParams.get('page') ?? 0));
	const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? DEFAULT_PAGE_SIZE)));
	const offset = page * pageSize;

	const rawSortBy = url.searchParams.get('sortBy') ?? '';
	const sortBy: UserListSortColumn = VALID_SORT_COLUMNS.has(rawSortBy as UserListSortColumn)
		? (rawSortBy as UserListSortColumn)
		: 'joined';
	const sortDir: 'asc' | 'desc' = url.searchParams.get('sortDir') === 'asc' ? 'asc' : 'desc';

	const [users, total] = await Promise.all([getUserList(pageSize, offset, sortBy, sortDir), getUserListCount()]);

	setHeaders(pageCollectionHeaders(url, total, pageSize, page));

	return { users, total, page, pageSize, sortBy, sortDir };
};
