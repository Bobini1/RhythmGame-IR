import { db } from '$lib/server/database/client';
import { scores, scoreExtras } from '$lib/server/database/schemas/scores';
import { charts } from '$lib/server/database/schemas/charts';
import { eq, asc, desc, count, and, sql, type SQL } from 'drizzle-orm';
import { clearTypeCaseExpr, gradeCaseExpr } from './sql-helpers';

// ---------------------------------------------------------------------------
// GET /api/scores/:guid  Esingle score resource
// ---------------------------------------------------------------------------

export interface ApiScore {
	id: string;
	userId: number;
	chartMd5: string;
	chartTitle: string;
	chartSubtitle: string;
	playLevel: number;
	difficulty: number;
	points: number;
	maxPoints: number;
	maxCombo: number;
	maxHits: number;
	judgementCounts: number[];
	mineHits: number;
	normalNoteCount: number;
	scratchCount: number;
	lnCount: number;
	bssCount: number;
	mineCount: number;
	clearType: string;
	randomSequence: number[];
	randomSeed: string;
	noteOrderAlgorithm: number;
	noteOrderAlgorithmP2: number;
	dpOptions: number;
	gameVersion: number;
	length: number;
	unixTimestamp: number;
	sha256: string;
}

export interface ApiScoreReplay {
	replayData: {
		offsetFromStart: number;
		points: { value: number; judgement: number; deviation: number } | null;
		column: number;
		noteIndex: number;
		action: number;
		noteRemoved: boolean;
	}[];
}

export interface ApiScoreGauge {
	gaugeHistory: {
		name: string;
		maxGauge: number;
		threshold: number;
		courseGauge: boolean;
		gaugeHistory: { offsetFromStart: number; gauge: number }[];
	}[];
}

export async function getScoreByGuid(guid: string): Promise<ApiScore | null> {
	const rows = await db
		.select({
			id: scores.id,
			userId: scores.userId,
			chartMd5: charts.md5,
			chartTitle: charts.title,
			chartSubtitle: charts.subtitle,
			playLevel: charts.playLevel,
			difficulty: charts.difficulty,
			points: scores.points,
			maxPoints: scores.maxPoints,
			maxCombo: scores.maxCombo,
			maxHits: scores.maxHits,
			judgementCounts: scores.judgementCounts,
			mineHits: scores.mineHits,
			normalNoteCount: scores.normalNoteCount,
			scratchCount: scores.scratchCount,
			lnCount: scores.lnCount,
			bssCount: scores.bssCount,
			mineCount: scores.mineCount,
			clearType: scores.clearType,
			randomSequence: scores.randomSequence,
			randomSeed: scores.randomSeed,
			noteOrderAlgorithm: scores.noteOrderAlgorithm,
			noteOrderAlgorithmP2: scores.noteOrderAlgorithmP2,
			dpOptions: scores.dpOptions,
			gameVersion: scores.gameVersion,
			length: scores.length,
			unixTimestamp: scores.unixTimestamp,
			sha256: charts.sha256
		})
		.from(scores)
		.innerJoin(charts, eq(scores.chartMd5, charts.md5))
		.where(eq(scores.id, guid))
		.limit(1);
	return rows[0] ?? null;
}

export async function getScoreReplay(guid: string): Promise<ApiScoreReplay | null> {
	const rows = await db
		.select({ replayData: scoreExtras.replayData })
		.from(scoreExtras)
		.where(eq(scoreExtras.scoreId, guid))
		.limit(1);
	return rows[0] ?? null;
}

export async function getScoreGauge(guid: string): Promise<ApiScoreGauge | null> {
	const rows = await db
		.select({ gaugeHistory: scoreExtras.gaugeHistory })
		.from(scoreExtras)
		.where(eq(scoreExtras.scoreId, guid))
		.limit(1);
	return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// GET /api/scores  Escores collection
// ---------------------------------------------------------------------------

export type ScoresOrderBy = 'date' | 'score_pct' | 'grade' | 'combo' | 'clear_type';

function scoresCollectionOrder(orderBy: ScoresOrderBy, sort: 'asc' | 'desc'): SQL {
	const dir = sort === 'asc' ? asc : desc;
	const pct = sql`${scores.points} / NULLIF(${scores.maxPoints}, 0)`;
	switch (orderBy) {
		case 'score_pct':  return dir(pct);
		case 'grade':
			return sort === 'asc'
				? sql`${gradeCaseExpr()} ASC, ${pct} ASC`
				: sql`${gradeCaseExpr()} DESC, ${pct} DESC`;
		case 'combo':      return sql`${dir(scores.maxCombo)}, ${desc(scores.unixTimestamp)}`;
		case 'clear_type': return sql`${dir(clearTypeCaseExpr())}, ${desc(scores.unixTimestamp)}`;
		case 'date':
		default:           return dir(scores.unixTimestamp);
	}
}

export interface ScoresCollectionFilters {
	chart?: string;
	user?: number;
	dateGte?: number;
	dateLte?: number;
	scorePctGte?: number;
	scorePctLte?: number;
	comboGte?: number;
	comboLte?: number;
}

function buildScoresConditions(filters: ScoresCollectionFilters): SQL[] {
	const conditions: SQL[] = [];
	if (filters.chart) conditions.push(eq(charts.md5, filters.chart));
	if (filters.user !== undefined) conditions.push(eq(scores.userId, filters.user));
	if (filters.dateGte !== undefined) conditions.push(sql`${scores.unixTimestamp} >= ${filters.dateGte}`);
	if (filters.dateLte !== undefined) conditions.push(sql`${scores.unixTimestamp} <= ${filters.dateLte}`);
	if (filters.scorePctGte !== undefined) conditions.push(sql`${scores.points} / NULLIF(${scores.maxPoints}, 0) >= ${filters.scorePctGte}`);
	if (filters.scorePctLte !== undefined) conditions.push(sql`${scores.points} / NULLIF(${scores.maxPoints}, 0) <= ${filters.scorePctLte}`);
	if (filters.comboGte !== undefined) conditions.push(sql`${scores.maxCombo} >= ${filters.comboGte}`);
	if (filters.comboLte !== undefined) conditions.push(sql`${scores.maxCombo} <= ${filters.comboLte}`);
	return conditions;
}

export async function queryScores(
	filters: ScoresCollectionFilters,
	limit: number,
	offset: number,
	orderBy: ScoresOrderBy = 'date',
	sort: 'asc' | 'desc' = 'desc'
): Promise<ApiScore[]> {
	const conditions = buildScoresConditions(filters);
	const where = conditions.length > 0 ? and(...conditions) : undefined;

	return db
		.select({
			id: scores.id,
			userId: scores.userId,
			chartMd5: charts.md5,
			chartTitle: charts.title,
			chartSubtitle: charts.subtitle,
			playLevel: charts.playLevel,
			difficulty: charts.difficulty,
			points: scores.points,
			maxPoints: scores.maxPoints,
			maxCombo: scores.maxCombo,
			maxHits: scores.maxHits,
			judgementCounts: scores.judgementCounts,
			mineHits: scores.mineHits,
			normalNoteCount: scores.normalNoteCount,
			scratchCount: scores.scratchCount,
			lnCount: scores.lnCount,
			bssCount: scores.bssCount,
			mineCount: scores.mineCount,
			clearType: scores.clearType,
			randomSequence: scores.randomSequence,
			randomSeed: scores.randomSeed,
			noteOrderAlgorithm: scores.noteOrderAlgorithm,
			noteOrderAlgorithmP2: scores.noteOrderAlgorithmP2,
			dpOptions: scores.dpOptions,
			gameVersion: scores.gameVersion,
			length: scores.length,
			unixTimestamp: scores.unixTimestamp,
			sha256: charts.sha256
		})
		.from(scores)
		.innerJoin(charts, eq(scores.chartMd5, charts.md5))
		.where(where)
		.orderBy(scoresCollectionOrder(orderBy, sort))
		.limit(limit)
		.offset(offset);
}

export async function queryScoresCount(filters: ScoresCollectionFilters): Promise<number> {
	const conditions = buildScoresConditions(filters);
	const where = conditions.length > 0 ? and(...conditions) : undefined;
	const result = await db
		.select({ count: count() })
		.from(scores)
		.innerJoin(charts, eq(scores.chartMd5, charts.md5))
		.where(where);
	return result[0]?.count ?? 0;
}
