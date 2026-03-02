import { db } from '$lib/server/database/client';
import { scores, charts, scoreExtras } from '$lib/server/database/schemas/scores';
import { user } from '$lib/server/database/schemas/auth';
import { eq, desc, asc, count, inArray, and, sql, type SQL } from 'drizzle-orm';
import type {
	GaugeHistoryGroup,
	HitEvent,
	ScoreSubmission
} from '$lib/models/scores';

export interface ScoreRow {
	id: string;
	points: number;
	maxPoints: number;
	maxCombo: number;
	maxHits: number;
	clearType: string;
	unixTimestamp: number; // converted from bigint to a JS number for JSON serialization
	chartTitle: string;
	chartSubtitle: string;
	chartMd5: string;
}

export interface UserProfileData {
	id: string;
	name: string;
	image: string | null;
}

export async function getUserScoreGuids(userId: string): Promise<string[]> {
	const rows = await db
		.select({ id: scores.id })
		.from(scores)
		.where(eq(scores.userId, userId));
	return rows.map((r) => r.id);
}

export async function getUserProfile(userId: string): Promise<UserProfileData | null> {
	const result = await db
		.select({ id: user.id, name: user.name, image: user.image })
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);
	return result[0] ?? null;
}

import { GRADE_THRESHOLDS, GRADE_LABELS } from '$lib/utils/grades';

export type SortableColumn = 'title' | 'score_pct' | 'grade' | 'combo' | 'clear_type' | 'date';

// Ordered from worst to best so ASC = worst first, DESC = best first.
const CLEAR_TYPE_PRIORITIES: Record<string, number> = {
	NOPLAY:      0,
	FAILED:      1,
	ASSIST_CLEAR: 2,
	EASY:        3,
	NORMAL:      4,
	HARD:        5,
	EXHARD:      6,
	FC:          7
};

function clearTypeCaseExpr() {
	// Builds: CASE clear_type WHEN 'NOPLAY' THEN 0 WHEN 'FAILED' THEN 1 ... ELSE 0 END
	const branches = Object.entries(CLEAR_TYPE_PRIORITIES)
		.map(([ct, p]) => sql`WHEN ${scores.clearType} = ${ct} THEN ${p}`)
		.reduce<SQL>((acc, part) => sql`${acc} ${part}`, sql``);
	return sql<number>`CASE ${branches} ELSE 0 END`;
}

function gradeCaseExpr() {
	// Maps points/maxPoints ratio to a grade priority (0=MAX best, 12=F worst).
	// Mirrors the GRADE_THRESHOLDS logic in grades.ts.
	const pct = sql`${scores.points} / NULLIF(${scores.maxPoints}, 0)`;
	// Build WHEN ratio >= threshold THEN priority, from highest threshold down.
	const branches = GRADE_THRESHOLDS.map(
		(threshold, i) => sql`WHEN ${pct} >= ${threshold} THEN ${i}`
	).reduce<SQL>((acc, part) => sql`${acc} ${part}`, sql``);
	return sql<number>`CASE ${branches} ELSE ${GRADE_LABELS.length - 1} END`;
}

function getOrderBy(sortBy: SortableColumn | null, sortDir: 'asc' | 'desc'): SQL {
	const dir = sortDir === 'asc' ? asc : desc;
	const pct = sql`${scores.points} / NULLIF(${scores.maxPoints}, 0)`;
	const mergedTitle = sql`TRIM(${charts.title} || ' ' || ${charts.subtitle})`;
	switch (sortBy) {
		case 'title':
			return sql`${dir(mergedTitle)}, ${desc(scores.unixTimestamp)}`;
		case 'score_pct':
			return dir(pct);
		case 'grade':
			return sortDir === 'asc'
				? sql`${gradeCaseExpr()} ASC, ${pct} ASC`
				: sql`${gradeCaseExpr()} DESC, ${pct} DESC`;
		case 'combo':
			return sql`${dir(scores.maxCombo)}, ${desc(scores.unixTimestamp)}`;
		case 'clear_type':
			return sql`${dir(clearTypeCaseExpr())}, ${desc(scores.unixTimestamp)}`;
		case 'date':
			return dir(scores.unixTimestamp);
		default:
			return desc(scores.createdAt);
	}
}

export async function getUserScores(
	userId: string,
	limit: number,
	offset: number,
	sortBy: SortableColumn | null = null,
	sortDir: 'asc' | 'desc' = 'desc'
): Promise<ScoreRow[]> {
	const rows = await db
		.select({
			id: scores.id,
			points: scores.points,
			maxPoints: scores.maxPoints,
			maxCombo: scores.maxCombo,
			maxHits: scores.maxHits,
			clearType: scores.clearType,
			unixTimestamp: scores.unixTimestamp,
			chartTitle: charts.title,
			chartSubtitle: charts.subtitle,
			chartMd5: charts.md5
		})
		.from(scores)
		.innerJoin(charts, eq(scores.chartId, charts.id))
		.where(eq(scores.userId, userId))
		.orderBy(getOrderBy(sortBy, sortDir))
		.limit(limit)
		.offset(offset);

	return rows.map((r) => ({
		...r,
		unixTimestamp: Number(r.unixTimestamp)
	}));
}

export async function getUserScoreCount(userId: string): Promise<number> {
	const result = await db
		.select({ count: count() })
		.from(scores)
		.where(eq(scores.userId, userId));
	return result[0]?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Chart queries
// ---------------------------------------------------------------------------

export type ChartData = Omit<typeof charts.$inferSelect, 'length'> & { length: number };

export async function getChartByMd5(md5: string): Promise<ChartData | null> {
	const result = await db
		.select()
		.from(charts)
		.where(eq(charts.md5, md5))
		.limit(1);
	if (!result[0]) return null;
	return { ...result[0], length: Number(result[0].length) };
}

export interface ChartScoreRow {
	userId: string;
	userName: string;
	userImage: string | null;
	bestPoints: number;
	maxPoints: number;
	bestCombo: number;
	maxHits: number;
	bestClearType: string;
	/** Poor (index 0) + Bad (index 2) combined, from the score with fewest combo breaks */
	bestComboBreaks: number;
	/** Unix timestamp (seconds) of the most recent score by this player */
	latestDate: number;
}

export type ChartSortableColumn = 'player' | 'score_pct' | 'grade' | 'combo' | 'combo_breaks' | 'clear_type' | 'date';

// Poor = judgementCounts[0], Bad = judgementCounts[2]
const poorPlusBad = sql<number>`(${scores.judgementCounts}->0)::int + (${scores.judgementCounts}->2)::int`;

function clearTypePriorityCaseExpr() {
	const branches = Object.entries(CLEAR_TYPE_PRIORITIES)
		.map(([ct, p]) => sql`WHEN ${scores.clearType} = ${ct} THEN ${p}`)
		.reduce<SQL>((acc, part) => sql`${acc} ${part}`, sql``);
	return sql<number>`CASE ${branches} ELSE 0 END`;
}

// Returns the clear type string corresponding to the highest priority among grouped rows.
function bestClearTypeExpr() {
	const maxPriority = sql`MAX(${clearTypePriorityCaseExpr()})`;
	const branches = Object.entries(CLEAR_TYPE_PRIORITIES)
		.map(([ct, p]) => sql`WHEN ${maxPriority} = ${p} THEN ${ct}`)
		.reduce<SQL>((acc, part) => sql`${acc} ${part}`, sql``);
	return sql<string>`CASE ${branches} ELSE 'NOPLAY' END`;
}

function getChartOrderBy(sortBy: ChartSortableColumn | null, sortDir: 'asc' | 'desc'): SQL {
	const dir = sortDir === 'asc' ? asc : desc;
	const bestPct = sql`MAX(${scores.points} / NULLIF(${scores.maxPoints}, 0))`;
	switch (sortBy) {
		case 'player':       return sql`${dir(user.name)}, MAX(${scores.unixTimestamp}) DESC`;
		case 'score_pct':
		case 'grade':        return dir(bestPct);
		case 'combo':        return sql`${dir(sql`MAX(${scores.maxCombo})`)}`;
		case 'combo_breaks': return sql`${dir(sql`MIN(${poorPlusBad})`)}`;
		case 'clear_type':   return sql`${dir(sql`MAX(${clearTypePriorityCaseExpr()})`)}`;
		case 'date':         return sql`${dir(sql`MAX(${scores.unixTimestamp})`)}`;
		default:             return sql`MAX(${scores.unixTimestamp}) DESC`;
	}
}

export async function getChartScores(
	chartMd5: string,
	limit: number,
	offset: number,
	sortBy: ChartSortableColumn | null = null,
	sortDir: 'asc' | 'desc' = 'desc'
): Promise<ChartScoreRow[]> {
	const rows = await db
		.select({
			userId: user.id,
			userName: user.name,
			userImage: user.image,
			bestPoints: sql<number>`MAX(${scores.points})`,
			maxPoints: sql<number>`MAX(${scores.maxPoints})`,
			bestCombo: sql<number>`MAX(${scores.maxCombo})`,
			maxHits: sql<number>`MAX(${scores.maxHits})`,
			bestComboBreaks: sql<number>`MIN(${poorPlusBad})`,
			bestClearType: bestClearTypeExpr(),
			latestDate: sql<number>`MAX(${scores.unixTimestamp})`
		})
		.from(scores)
		.innerJoin(charts, eq(scores.chartId, charts.id))
		.innerJoin(user, eq(scores.userId, user.id))
		.where(eq(charts.md5, chartMd5))
		.groupBy(user.id, user.name, user.image)
		.orderBy(getChartOrderBy(sortBy, sortDir))
		.limit(limit)
		.offset(offset);

	return rows.map((r) => ({ ...r, latestDate: Number(r.latestDate) }));
}

export async function getChartScoreCount(chartMd5: string): Promise<number> {
	// Count distinct players, not total scores
	const result = await db
		.select({ count: sql<number>`COUNT(DISTINCT ${scores.userId})` })
		.from(scores)
		.innerJoin(charts, eq(scores.chartId, charts.id))
		.where(eq(charts.md5, chartMd5));
	return Number(result[0]?.count ?? 0);
}

// ---------------------------------------------------------------------------
// Per-user scores on a specific chart
// ---------------------------------------------------------------------------

export interface ChartUserScoreRow {
	id: string;
	points: number;
	maxPoints: number;
	maxCombo: number;
	maxHits: number;
	clearType: string;
	judgementCounts: number[];
	unixTimestamp: number;
}

export type ChartUserSortableColumn =
	| 'score_pct'
	| 'grade'
	| 'combo'
	| 'clear_type'
	| 'date'
	| 'poor'
	| 'empty_poor'
	| 'bad'
	| 'good'
	| 'great'
	| 'perfect'
	| 'mine_hit';

function getChartUserOrderBy(sortBy: ChartUserSortableColumn | null, sortDir: 'asc' | 'desc'): SQL {
	const dir = sortDir === 'asc' ? asc : desc;
	const pct = sql`${scores.points} / NULLIF(${scores.maxPoints}, 0)`;
	const jCol = (i: number) => sql`(${scores.judgementCounts}->${sql.raw(String(i))})::int`;
	switch (sortBy) {
		case 'score_pct':  return dir(pct);
		case 'grade':
			return sortDir === 'asc'
				? sql`${gradeCaseExpr()} ASC, ${pct} ASC`
				: sql`${gradeCaseExpr()} DESC, ${pct} DESC`;
		case 'combo':      return sql`${dir(scores.maxCombo)}, ${desc(scores.unixTimestamp)}`;
		case 'clear_type': return sql`${dir(clearTypeCaseExpr())}, ${desc(scores.unixTimestamp)}`;
		case 'date':       return dir(scores.unixTimestamp);
		case 'poor':       return sql`${dir(jCol(0))}, ${desc(scores.unixTimestamp)}`;
		case 'empty_poor': return sql`${dir(jCol(1))}, ${desc(scores.unixTimestamp)}`;
		case 'bad':        return sql`${dir(jCol(2))}, ${desc(scores.unixTimestamp)}`;
		case 'good':       return sql`${dir(jCol(3))}, ${desc(scores.unixTimestamp)}`;
		case 'great':      return sql`${dir(jCol(4))}, ${desc(scores.unixTimestamp)}`;
		case 'perfect':    return sql`${dir(jCol(5))}, ${desc(scores.unixTimestamp)}`;
		case 'mine_hit':   return sql`${dir(jCol(6))}, ${desc(scores.unixTimestamp)}`;
		default:           return desc(scores.unixTimestamp);
	}
}

export async function getChartUserScores(
	chartMd5: string,
	userId: string,
	limit: number,
	offset: number,
	sortBy: ChartUserSortableColumn | null = null,
	sortDir: 'asc' | 'desc' = 'desc'
): Promise<ChartUserScoreRow[]> {
	const rows = await db
		.select({
			id: scores.id,
			points: scores.points,
			maxPoints: scores.maxPoints,
			maxCombo: scores.maxCombo,
			maxHits: scores.maxHits,
			clearType: scores.clearType,
			judgementCounts: scores.judgementCounts,
			unixTimestamp: scores.unixTimestamp
		})
		.from(scores)
		.innerJoin(charts, eq(scores.chartId, charts.id))
		.where(and(eq(charts.md5, chartMd5), eq(scores.userId, userId)))
		.orderBy(getChartUserOrderBy(sortBy, sortDir))
		.limit(limit)
		.offset(offset);

	return rows.map((r) => ({ ...r, unixTimestamp: Number(r.unixTimestamp) }));
}

export async function getChartUserScoreCount(chartMd5: string, userId: string): Promise<number> {
	const result = await db
		.select({ count: count() })
		.from(scores)
		.innerJoin(charts, eq(scores.chartId, charts.id))
		.where(and(eq(charts.md5, chartMd5), eq(scores.userId, userId)));
	return result[0]?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Full score download (score + extras)
// ---------------------------------------------------------------------------

export type ScoreDownloadRow = {
	scoreData: ScoreSubmission;
	replayData: HitEvent[];
	gaugeHistory: GaugeHistoryGroup[];
};

export async function getScoresByIds(
	userId: string,
	guids: string[]
): Promise<ScoreDownloadRow[]> {
	if (guids.length === 0) return [];

	const rows = await db
		.select({
			guid: scores.id,
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
			sha256: charts.sha256,
			md5: charts.md5,
			replayData: scoreExtras.replayData,
			gaugeHistory: scoreExtras.gaugeHistory
		})
		.from(scores)
		.innerJoin(charts, eq(scores.chartId, charts.id))
		.innerJoin(scoreExtras, eq(scoreExtras.scoreId, scores.id))
		.where(and(inArray(scores.id, guids), eq(scores.userId, userId)));

	return rows.map((r) => ({
		scoreData: {
			guid: r.guid,
			points: r.points,
			maxPoints: r.maxPoints,
			maxCombo: r.maxCombo,
			maxHits: r.maxHits,
			judgementCounts: r.judgementCounts,
			mineHits: r.mineHits,
			normalNoteCount: r.normalNoteCount,
			scratchCount: r.scratchCount,
			lnCount: r.lnCount,
			bssCount: r.bssCount,
			mineCount: r.mineCount,
			clearType: r.clearType as ScoreSubmission['clearType'],
			randomSequence: r.randomSequence,
			randomSeed: r.randomSeed,
			noteOrderAlgorithm: r.noteOrderAlgorithm,
			noteOrderAlgorithmP2: r.noteOrderAlgorithmP2,
			dpOptions: r.dpOptions,
			gameVersion: r.gameVersion,
			length: Number(r.length),
			unixTimestamp: Number(r.unixTimestamp),
			sha256: r.sha256,
			md5: r.md5
		},
		replayData: r.replayData,
		gaugeHistory: r.gaugeHistory
	}));
}
