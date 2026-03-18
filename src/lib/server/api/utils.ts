import { type SQL, sql, and } from 'drizzle-orm';
import type { ScoreSummaryRow } from '$lib/server/api/score-summaries.queries';

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export interface PaginationParams {
	limit?: number;
	offset?: number;
}

export function parsePagination(url: URL): PaginationParams {
	const limitString = url.searchParams.get('limit');
	const offsetString = url.searchParams.get('offset');
	const limit = limitString ? Number(limitString) : undefined;
	const offset = offsetString ? Number(offsetString) : undefined;
	return { limit, offset };
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

export interface SortParams<T extends string> {
	orderBy: T;
	sort: 'asc' | 'desc';
}

export function parseSorting<T extends string>(
	url: URL,
	validColumns: Set<T>,
	defaultColumn: T,
	defaultDir: 'asc' | 'desc' = 'desc'
): SortParams<T> {
	const raw = url.searchParams.get('order_by') ?? '';
	const orderBy: T = validColumns.has(raw as T) ? (raw as T) : defaultColumn;
	const sort: 'asc' | 'desc' = url.searchParams.get('sort') === 'asc' ? 'asc' : defaultDir;
	return { orderBy, sort };
}

// ---------------------------------------------------------------------------
// Range filters (_gte / _lte)
// ---------------------------------------------------------------------------

export interface RangeFilterDef {
	param: string;
	column: SQL;
}

export function parseRangeFilters(url: URL, defs: RangeFilterDef[]): SQL[] {
	const conditions: SQL[] = [];
	for (const { param, column } of defs) {
		const gteVal = url.searchParams.get(`${param}_gte`);
		const lteVal = url.searchParams.get(`${param}_lte`);
		if (gteVal !== null && !isNaN(Number(gteVal))) {
			conditions.push(sql`${column} >= ${Number(gteVal)}`);
		}
		if (lteVal !== null && !isNaN(Number(lteVal))) {
			conditions.push(sql`${column} <= ${Number(lteVal)}`);
		}
	}
	return conditions;
}

export function combineFilters(...filters: (SQL | undefined)[]): SQL | undefined {
	const defined = filters.filter((f): f is SQL => f !== undefined);
	if (defined.length === 0) return undefined;
	if (defined.length === 1) return defined[0];
	return and(...defined);
}

// ---------------------------------------------------------------------------
// Response headers for collection pagination
// RFC 8288  – Link: <url>; rel="next", rel="prev", rel="first", rel="last"
// X-Total-Count, X-Limit, X-Offset for pagination metadata
// ---------------------------------------------------------------------------

/**
 * Build pagination headers for a collection response (API endpoints).
 * Uses offset-based pagination.
 *
 * @param baseUrl  The full request URL (used to build Link header hrefs).
 * @param total    Total number of items matching the current filter.
 * @param limit    Page size.
 * @param offset   Current offset.
 */
export function collectionHeaders(
	baseUrl: URL,
	total: number,
	limit?: number,
	offset?: number
): Record<string, string> {
	const headers: Record<string, string> = {
		'X-Total-Count': String(total),
	};
	if (limit !== undefined) headers['X-Limit'] = String(limit);
	if (offset !== undefined) headers['X-Offset'] = String(offset);

	// Link header (RFC 8288)
	const links: string[] = [];

	const makeUrl = (o: number) => {
		const u = new URL(baseUrl.toString());
		u.searchParams.set('offset', String(o));
		u.searchParams.set('limit', String(limit));
		return u.toString();
	};

	if (limit && offset) links.push(`<${makeUrl(0)}>; rel="first"`);
	if (limit && offset && offset > 0) links.push(`<${makeUrl(Math.max(0, offset - limit))}>; rel="prev"`);
	if (limit && (offset ?? 0) + limit < total)
		links.push(`<${makeUrl((offset ?? 0) + limit)}>; rel="next"`);
	if (limit) {
		const lastOffset = total > 0 ? Math.floor((total - 1) / limit) * limit : 0;
		links.push(`<${makeUrl(lastOffset)}>; rel="last"`);
	}

	headers['Link'] = links.join(', ');
	return headers;
}

/**
 * Build pagination headers for SSR pages that use page-number + limit.
 *
 * @param baseUrl   The full request URL (used to build Link header hrefs).
 * @param total     Total number of items matching the current filter.
 * @param pageSize  Items per page.
 * @param page      Current zero-based page index.
 */
export function pageCollectionHeaders(
	baseUrl: URL,
	total: number,
	pageSize: number,
	page: number
): Record<string, string> {
	const offset = page * pageSize;
	const headers: Record<string, string> = {
		'X-Total-Count': String(total),
		'X-Limit': String(pageSize),
		'X-Offset': String(offset)
	};

	const lastPage = total > 0 ? Math.floor((total - 1) / pageSize) : 0;

	const makeUrl = (p: number) => {
		const u = new URL(baseUrl.toString());
		u.searchParams.set('page', String(p));
		u.searchParams.set('limit', String(pageSize));
		return u.toString();
	};

	const links: string[] = [];
	links.push(`<${makeUrl(0)}>; rel="first"`);
	if (page > 0) links.push(`<${makeUrl(page - 1)}>; rel="prev"`);
	if (page < lastPage) links.push(`<${makeUrl(page + 1)}>; rel="next"`);
	links.push(`<${makeUrl(lastPage)}>; rel="last"`);

	headers['Link'] = links.join(', ');
	return headers;
}

// ---------------------------------------------------------------------------
// Field selection (?fields=a,b,c)
// ---------------------------------------------------------------------------

/**
 * Parse the `fields` query parameter into a Set of requested field names.
 * Returns `null` when the parameter is absent, meaning "return all fields".
 *
 * @example  ?fields=id,name,scoreCount  →  Set { 'id', 'name', 'scoreCount' }
 */
export function parseFields(url: URL): Set<string> | null {
	const raw = url.searchParams.get('fields');
	if (!raw) return null;
	const fields = raw
		.split(',')
		.map((f) => f.trim())
		.filter((f) => f.length > 0);
	return fields.length > 0 ? new Set(fields) : null;
}

/**
 * Filter an object to only the requested fields.
 * `_links` is always preserved so that HATEOAS navigation stays intact.
 *
 * When `fields` is `null` (param not supplied) the original object is
 * returned unchanged.
 */
export function pickFields<T extends Record<string, unknown>>(
	obj: T,
	fields: Set<string> | null
): Partial<T> {
	if (!fields) return obj;
	return Object.fromEntries(
		Object.entries(obj).filter(([key]) => fields.has(key))
	) as Partial<T>;
}

// ---------------------------------------------------------------------------
// HATEOAS links
// ---------------------------------------------------------------------------

export function chartLinks(baseUrl: URL, md5: string) {
	return {
		self: new URL(`/api/charts/${md5}`, baseUrl),
		scores: new URL(`/api/scores?md5=${md5}`, baseUrl),
		scoreSummaries: new URL(`/api/score-summaries?md5=${md5}`, baseUrl)
	};
}

export function userLinks(baseUrl: URL, userId: number) {
	return {
		self: new URL(`/api/users/${userId}`, baseUrl),
		scores: new URL(`/api/scores?user=${userId}`, baseUrl),
		scoreSummaries: new URL(`/api/score-summaries?user=${userId}`, baseUrl)
	};
}

export function scoreLinks(baseUrl: URL, id: string, md5: string, userId: number) {
	return {
		self: new URL(`/api/scores/${id}`, baseUrl),
		chart: new URL(`/api/charts/${md5}`, baseUrl),
		user: new URL(`/api/users/${userId}`, baseUrl),
		parentScoreSummary: new URL(`/api/score-summaries?md5=${md5}&user=${userId}`, baseUrl)
	};
}

export function scoreSummaryLinks(baseUrl: URL, md5: string, userId: number, summary: ScoreSummaryRow) {
	return {
		self: new URL(`/api/score-summaries?md5=${md5}&user=${userId}`, baseUrl),
		chart: new URL(`/api/charts/${md5}`, baseUrl),
		user: new URL(`/api/users/${userId}`, baseUrl),
		scores: new URL(`/api/scores?md5=${md5}&user=${userId}`, baseUrl),
		bestPointsScore: new URL(`/api/scores/${summary.bestPointsGuid}`, baseUrl),
		bestClearTypeScore: new URL(`/api/scores/${summary.bestClearTypeGuid}`, baseUrl),
		bestComboScore: new URL(`/api/scores/${summary.bestComboGuid}`, baseUrl),
		bestComboBreaksScore: new URL(`/api/scores/${summary.bestComboBreaksGuid}`, baseUrl),
		latestDateScore: new URL(`/api/scores/${summary.latestDateGuid}`, baseUrl)
	};
}



