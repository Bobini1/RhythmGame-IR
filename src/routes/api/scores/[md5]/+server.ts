import { json, type RequestHandler } from '@sveltejs/kit';
import { getScoresForChartMd5 } from '$lib/server/scores/query';

export const GET: RequestHandler = async ({ params }) => {
	const md5 = params.md5;
	if (!md5) {
		return json({ error: 'Missing md5' }, { status: 400 });
	}

	try {
		const groups = await getScoresForChartMd5(md5);
		return json(groups);
	} catch (err) {
		console.error('[GET /api/scores/:md5]', err);
		return json({ error: 'Internal server error' }, { status: 500 });
	}
};

