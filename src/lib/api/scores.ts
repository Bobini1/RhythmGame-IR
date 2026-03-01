import { POST } from '$lib/api/helpers/request';
import type { ScoreSubmissionPayload } from '$lib/models/scores';

const Scores = '/api/scores';

export interface ScoreSubmitResponse {
	id: string;
	chartId: string;
}

/**
 * Submit a score to the internet ranking.
 *
 * @throws On network errors or non-2xx responses.
 */
export const submitScore = (
	payload: ScoreSubmissionPayload,
	options?: { fetch?: typeof fetch }
): Promise<ScoreSubmitResponse> => {
	return POST<ScoreSubmissionPayload, ScoreSubmitResponse>(Scores, payload, {
		fetch: options?.fetch
	});
};


