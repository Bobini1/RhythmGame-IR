import { json, type RequestHandler } from '@sveltejs/kit';
import { getScoreByGuid } from '$lib/server/api/queries';
import { scoreLinks } from '$lib/server/api/utils';

export const GET: RequestHandler = async ({ params }) => {
	const guid = params.guid;
	if (!guid) {
		return json({ error: 'Missing guid' }, { status: 400 });
	}

	const score = await getScoreByGuid(guid);
	if (!score) {
		return json({ error: 'Score not found' }, { status: 404 });
	}

	return json({
		...score,
		_links: scoreLinks(score.id, score.chartMd5, score.userId)
	});
};

