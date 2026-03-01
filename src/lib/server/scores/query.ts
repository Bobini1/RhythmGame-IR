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
	chartSha256: string;
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
			chartSha256: charts.sha256
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
