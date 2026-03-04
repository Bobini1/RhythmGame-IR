import { json, type RequestHandler } from '@sveltejs/kit';
import { z } from 'zod';
import { getUserScoreGuids, getScoresByIds } from '$lib/server/scores/query';
import { guidSchema } from '$lib/server/scores/validation';

const bodySchema = z.array(guidSchema);

/**
 * POST /api/scores/missing
 *
 * The client sends the list of score GUIDs it already has locally.
 * The server responds with full payloads (score + replay + gauge history)
 * for every score that is not in that list.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	const session = locals.session;
	if (!session) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	const parsed = bodySchema.safeParse(body);
	if (!parsed.success) {
		return json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 422 });
	}

	const localSet = new Set(parsed.data);
	const allGuids = await getUserScoreGuids(locals.user.id);
	const missingGuids = allGuids.filter((guid) => !localSet.has(guid));
	const missingScores = await getScoresByIds(locals.user.id, missingGuids);

	return json(missingScores);
};

