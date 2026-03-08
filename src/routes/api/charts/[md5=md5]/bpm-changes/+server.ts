import { json, type RequestHandler } from '@sveltejs/kit';
import { getChartBpmChanges } from '$lib/server/api/charts.queries';

export const GET: RequestHandler = async ({ params }) => {
	const data = await getChartBpmChanges(params.md5!);
	if (!data) {
		return json({ error: 'Chart not found' }, { status: 404 });
	}
	return json(data);
};

