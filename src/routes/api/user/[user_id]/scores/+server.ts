import { json, type RequestHandler } from '@sveltejs/kit';
import { getUserScores, getUserScoreCount } from '$lib/server/scores/query';

const PAGE_SIZE = 20;

export const GET: RequestHandler = async ({ params, url }) => {
	const userId = params.user_id;
	if (!userId) {
		return json({ error: 'Missing user_id' }, { status: 400 });
	}

	const page = Math.max(0, Number(url.searchParams.get('page') ?? 0));
	const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? PAGE_SIZE)));
	const offset = page * limit;

	const [rows, total] = await Promise.all([
		getUserScores(userId, limit, offset),
		getUserScoreCount(userId)
	]);

	return json({ scores: rows, total });
};

