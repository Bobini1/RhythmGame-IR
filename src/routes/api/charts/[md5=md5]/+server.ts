import { json, type RequestHandler } from '@sveltejs/kit';
import { getChartByMd5 } from '$lib/server/api/queries';
import { chartLinks } from '$lib/server/api/utils';

export const GET: RequestHandler = async ({ params }) => {
	const md5 = params.md5;
	if (!md5) {
		return json({ error: 'Missing md5' }, { status: 400 });
	}

	const chart = await getChartByMd5(md5);
	if (!chart) {
		return json({ error: 'Chart not found' }, { status: 404 });
	}

	return json({
		...chart,
		_links: chartLinks(md5)
	});
};

