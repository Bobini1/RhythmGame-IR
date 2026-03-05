import { json, type RequestHandler } from '@sveltejs/kit';
import { z } from 'zod';
import { getUserScoreGuids } from '$lib/server/scores/query';
import { guidSchema } from '$lib/server/scores/validation';

const bodySchema = z.array(guidSchema);

/**
 * POST /api/scores/unknown
 *
 * Preflight for bulk upload. The client sends the GUIDs of all scores it
 * wants to upload; the server returns the subset it does not already have.
 * The client then uploads only those via POST /api/scores/bulk.
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
		return json(
			{ error: 'Validation failed', details: parsed.error.flatten() },
			{ status: 422 }
		);
	}

	const serverGuids = new Set(await getUserScoreGuids(Number(locals.user.id)));
	const unknownGuids = parsed.data.filter((guid) => !serverGuids.has(guid));

	return json(unknownGuids);
};

