import { type SQL, sql, and } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export interface PaginationParams {
	limit: number;
	offset: number;
}

export function parsePagination(url: URL, defaultLimit = 20): PaginationParams {
	const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? defaultLimit)));
	const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0));
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
	limit: number,
	offset: number
): Record<string, string> {
	const headers: Record<string, string> = {
		'X-Total-Count': String(total),
		'X-Limit': String(limit),
		'X-Offset': String(offset)
	};

	// Link header (RFC 8288)
	const links: string[] = [];

	const makeUrl = (o: number) => {
		const u = new URL(baseUrl.toString());
		u.searchParams.set('offset', String(o));
		u.searchParams.set('limit', String(limit));
		return u.toString();
	};

	links.push(`<${makeUrl(0)}>; rel="first"`);
	if (offset > 0) links.push(`<${makeUrl(Math.max(0, offset - limit))}>; rel="prev"`);
	if (offset + limit < total) links.push(`<${makeUrl(offset + limit)}>; rel="next"`);
	const lastOffset = total > 0 ? Math.floor((total - 1) / limit) * limit : 0;
	links.push(`<${makeUrl(lastOffset)}>; rel="last"`);

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
		Object.entries(obj).filter(([key]) => fields.has(key) || key === '_links')
	) as Partial<T>;
}

// ---------------------------------------------------------------------------
// HATEOAS links
// ---------------------------------------------------------------------------

export function chartLinks(md5: string) {
	return {
		self: `/api/charts/${md5}`,
		histogram: `/api/charts/${md5}/histogram`,
		bpm_changes: `/api/charts/${md5}/bpm-changes`,
		scores: `/api/scores?chart=${md5}`,
		score_summaries: `/api/score-summaries?chart=${md5}`
	};
}

export function userLinks(publicId: number) {
	return {
		self: `/api/users/${publicId}`,
		scores: `/api/scores?user=${publicId}`
	};
}

export function scoreLinks(id: string, chartMd5: string, userId: number) {
	return {
		self: `/api/scores/${id}`,
		chart: `/api/charts/${chartMd5}`,
		user: `/api/users/${userId}`
	};
}

export function scoreSummaryLinks(chartMd5: string, userId: number) {
	return {
		self: `/api/score-summaries?chart=${chartMd5}&user=${userId}`,
		chart: `/api/charts/${chartMd5}`,
		user: `/api/users/${userId}`,
		scores: `/api/scores?chart=${chartMd5}&user=${userId}`
	};
}



