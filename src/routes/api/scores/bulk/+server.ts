import { json, type RequestHandler } from '@sveltejs/kit';
import { z } from 'zod';
import { scoreSubmissionPayloadSchema } from '$lib/server/scores/validation';
import { submitScore } from '$lib/server/scores/service';

const bulkPayloadSchema = z.array(scoreSubmissionPayloadSchema);

type BulkResultItem =
	| { guid: string; status: 'created'; scoreId: string; chartId: string }
	| { guid: string; status: 'duplicate' }
	| { guid: string; status: 'invalid'; details: unknown }
	| { guid: string; status: 'error'; message: string };

/**
 * POST /api/scores/bulk
 *
 * Accepts an array of score submission payloads (max 500) and attempts to
 * persist each one. Results are returned per-item — failures do not abort the
 * rest of the batch.
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

	const parsed = bulkPayloadSchema.safeParse(body);
	if (!parsed.success) {
		return json(
			{ error: 'Validation failed', details: parsed.error.flatten() },
			{ status: 422 }
		);
	}

	const results: BulkResultItem[] = [];

	for (const payload of parsed.data) {
		const guid = payload.scoreData.guid;

		const itemResult = scoreSubmissionPayloadSchema.safeParse(payload);
		if (!itemResult.success) {
			results.push({ guid, status: 'invalid', details: itemResult.error.flatten() });
			continue;
		}

		try {
			const { scoreId, chartId } = await submitScore(Number(locals.user.id), itemResult.data);
			results.push({ guid, status: 'created', scoreId, chartId });
		} catch (err) {
			if (err instanceof Error && (err as Error & { code?: string }).code === 'DUPLICATE_SCORE') {
				results.push({ guid, status: 'duplicate' });
			} else {
				console.error('[POST /api/scores/bulk] error for guid', guid, err);
				results.push({
					guid,
					status: 'error',
					message: err instanceof Error ? err.message : 'Unknown error'
				});
			}
		}
	}

	return json(results);
};

