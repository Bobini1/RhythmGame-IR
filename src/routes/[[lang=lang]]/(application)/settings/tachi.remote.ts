import { getRequestEvent, form } from '$app/server';
import { uploadScoresToTachi } from '$lib/server/integrations/tachi';
import { queryScores, type ScoresCollectionFilters } from '$lib/server/api/scores.queries';

export const syncScores = form(async () => {
	const { locals } = getRequestEvent();
	const userId = locals.user.id;
	if (!locals.session || !locals.tachi?.userID) {
		return;
	}
	const filters: ScoresCollectionFilters = {};
	filters.user = Number(userId);
	const scores = await queryScores(filters);
	await uploadScoresToTachi(scores, locals.tachi.token);
	return { synced: true };
});
