import { json, type RequestHandler } from '@sveltejs/kit';
import { auth } from '$lib/server/auth/config';
import { scoreSubmissionPayloadSchema } from '$lib/server/scores/validation';
import { submitScore } from '$lib/server/scores/service';

export const POST: RequestHandler = async ({ request }) => {
	// -----------------------------------------------------------------------
	// Authentication
	// -----------------------------------------------------------------------
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	// -----------------------------------------------------------------------
	// Parse & validate body
	// -----------------------------------------------------------------------
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	const result = scoreSubmissionPayloadSchema.safeParse(body);
	if (!result.success) {
		return json(
			{ error: 'Validation failed', details: result.error.flatten() },
			{ status: 422 }
		);
	}

	// -----------------------------------------------------------------------
	// Persist
	// -----------------------------------------------------------------------
	try {
		const { scoreId, chartId } = await submitScore(session.user.id, result.data);
		return json({ id: scoreId, chartId }, { status: 201 });
	} catch (err) {
		if (err instanceof Error && (err as Error & { code?: string }).code === 'DUPLICATE_SCORE') {
			return json({ error: 'Score already submitted' }, { status: 409 });
		}
		console.error('[POST /api/scores]', err);
		return json({ error: 'Internal server error' }, { status: 500 });
	}
};

