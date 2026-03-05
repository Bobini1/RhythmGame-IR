// ---------------------------------------------------------------------------
// Pagination helpers (used by SSR page.server.ts files)
// ---------------------------------------------------------------------------

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

