import { json, type RequestHandler } from '@sveltejs/kit';
import { getScoreById } from '$lib/server/api/scores.queries';
import { parseFields, pickFields, scoreLinks } from '$lib/server/api/utils';
import { bigIntJsonResponse } from '$lib/server/api/json-bigint';

export const GET: RequestHandler = async ({ params, url }) => {
	const guid = params.guid;
	if (!guid) {
		return json({ error: 'Missing guid' }, { status: 400 });
	}
	const fields = parseFields(url);

	const score = await getScoreById(guid);
	if (!score) {
		return json({ error: 'Score not found' }, { status: 404 });
	}

	const baseUrl = new URL(url.protocol + '//' + url.host);
	return bigIntJsonResponse(
		pickFields({ ...score, _links: scoreLinks(baseUrl, score.guid, score.md5, score.userId) }, fields)
	);
};
