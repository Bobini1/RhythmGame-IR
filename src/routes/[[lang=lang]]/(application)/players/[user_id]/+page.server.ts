import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { getUserProfile } from '$lib/server/scores/query';
import { GET } from '$lib/api/helpers/request';
import { userScores } from '../../../../api';
import type { ScoreRow } from '$lib/server/scores/query';

const PAGE_SIZE = 20;

export const load: PageServerLoad = async ({ params, fetch }) => {
	const userId = params.user_id;

	const profile = await getUserProfile(userId);
	if (!profile) {
		error(404, 'Player not found');
	}

	const { scores, total } = await GET<{ scores: ScoreRow[]; total: number }>(
		userScores(userId),
		{ fetch, limit: PAGE_SIZE }
	);

	return {
		profile,
		scores,
		total,
		pageSize: PAGE_SIZE
	};
};


