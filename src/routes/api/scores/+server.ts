import { json, type RequestHandler } from '@sveltejs/kit';
import {
	queryScores,
	queryScoresCount,
	type ScoresOrderBy,
	type ScoresCollectionFilters
} from '$lib/server/api/scores.queries';
import {
	parsePagination,
	parseSorting,
	collectionHeaders,
	scoreLinks,
	parseFields,
	pickFields
} from '$lib/server/api/utils';
import { scoreSubmissionPayloadSchema } from '$lib/server/scores/validation';
import { submitScore } from '$lib/server/api/service';
import { parseBigIntJson, bigIntJsonResponse } from '$lib/server/api/json-bigint';

// ---------------------------------------------------------------------------
// GET /api/scores — scores collection
// ---------------------------------------------------------------------------

const VALID_ORDER_BY = new Set<ScoresOrderBy>([
	'date',
	'score_pct',
	'grade',
	'combo',
	'clear_type'
]);

export const GET: RequestHandler = async ({ url }) => {
	const { limit, offset } = parsePagination(url);
	const { orderBy, sort } = parseSorting(url, VALID_ORDER_BY, 'date');
	const fields = parseFields(url);

	const filters: ScoresCollectionFilters = {};
	const md5 = url.searchParams.get('md5');
	const userParam = url.searchParams.get('user');
	if (md5) filters.md5 = md5;
	if (userParam !== null && !isNaN(Number(userParam))) filters.user = Number(userParam);

	const dateGte = url.searchParams.get('date_gte');
	const dateLte = url.searchParams.get('date_lte');
	if (dateGte !== null && !isNaN(Number(dateGte))) filters.dateGte = Number(dateGte);
	if (dateLte !== null && !isNaN(Number(dateLte))) filters.dateLte = Number(dateLte);

	const scorePctGte = url.searchParams.get('score_pct_gte');
	const scorePctLte = url.searchParams.get('score_pct_lte');
	if (scorePctGte !== null && !isNaN(Number(scorePctGte))) filters.scorePctGte = Number(scorePctGte);
	if (scorePctLte !== null && !isNaN(Number(scorePctLte))) filters.scorePctLte = Number(scorePctLte);

	const comboGte = url.searchParams.get('combo_gte');
	const comboLte = url.searchParams.get('combo_lte');
	if (comboGte !== null && !isNaN(Number(comboGte))) filters.comboGte = Number(comboGte);
	if (comboLte !== null && !isNaN(Number(comboLte))) filters.comboLte = Number(comboLte);

	try {
		const [rows, total] = await Promise.all([
			queryScores(filters, limit, offset, orderBy, sort),
			queryScoresCount(filters)
		]);

		const baseUrl = new URL(url.protocol + '//' + url.host);
		const data = rows.map((r) =>
			pickFields({ ...r, _links: scoreLinks(baseUrl, r.guid, r.md5, r.userId) }, fields)
		);

		return bigIntJsonResponse(data, {
			headers: collectionHeaders(url, total, limit, offset)
		});
	} catch (err) {
		console.error('[GET /api/scores]', err);
		return json({ error: 'Internal server error' }, { status: 500 });
	}
};

// ---------------------------------------------------------------------------
// POST /api/scores — single score submission (auth required)
// ---------------------------------------------------------------------------

export const POST: RequestHandler = async ({ request, locals }) => {
	const session = locals.session;
	if (!session) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	let body: unknown;
	try {
		body = parseBigIntJson(await request.text());
	} catch (err) {
		console.error('[POST /api/scores] Invalid JSON body', err);
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	const parsed = scoreSubmissionPayloadSchema.safeParse(body);
	if (!parsed.success) {
		return json(
			{ error: 'Validation failed', details: parsed.error.flatten() },
			{ status: 422 }
		);
	}

	try {
		await submitScore(Number(locals.user.id), parsed.data);
		return json({ message: 'Score submitted successfully' }, { status: 201 });
	} catch (err) {
		if (err instanceof Error && (err as Error & { message?: string }).message === 'DUPLICATE_SCORE') {
			return json({ error: 'Score already exists' }, { status: 409 });
		}
		console.error('[POST /api/scores]', err);
		return json({ error: 'Internal server error' }, { status: 500 });
	}
};
