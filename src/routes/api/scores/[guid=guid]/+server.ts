import { json, type RequestHandler } from '@sveltejs/kit';
import { getScoreById } from '$lib/server/api/scores.queries';
import { scoreLinks } from '$lib/server/api/utils';
import { bigIntJsonResponse } from '$lib/server/api/json-bigint';

export const GET: RequestHandler = async ({ params }) => {
	const guid = params.guid;
	if (!guid) {
		return json({ error: 'Missing guid' }, { status: 400 });
	}

	const score = await getScoreById(guid);
	if (!score) {
		return json({ error: 'Score not found' }, { status: 404 });
	}

	return bigIntJsonResponse(
		{ ...score, _links: scoreLinks(score.id, score.chartMd5, score.userId) }
	);
};
