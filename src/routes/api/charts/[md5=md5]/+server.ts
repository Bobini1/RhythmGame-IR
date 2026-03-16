import { json, type RequestHandler } from '@sveltejs/kit';
import { getChartByMd5 } from '$lib/server/api/charts.queries';
import { chartLinks, parseFields, pickFields } from '$lib/server/api/utils';

export const GET: RequestHandler = async ({ params, url }) => {
	const md5 = params.md5;
	if (!md5) {
		return json({ error: 'Missing md5' }, { status: 400 });
	}
	const fields = parseFields(url);

	const chart = await getChartByMd5(md5);
	if (!chart) {
		return json({ error: 'Chart not found' }, { status: 404 });
	}

	const baseUrl = new URL(url.protocol + '//' + url.host);
	return json(
		pickFields(
			{
				...chart,
				_links: chartLinks(baseUrl, md5)
			},
			fields
		)
	);
};

