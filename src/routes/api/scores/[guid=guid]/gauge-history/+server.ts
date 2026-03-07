import { json, type RequestHandler } from '@sveltejs/kit';
import { getScoreGauge } from '$lib/server/api/queries';

export const GET: RequestHandler = async ({ params }) => {
	const data = await getScoreGauge(params.guid!);
	if (!data) {
		return json({ error: 'Score not found' }, { status: 404 });
	}
	return json(data);
};

