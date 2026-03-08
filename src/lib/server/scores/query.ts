import { db } from '$lib/server/database/client';
import { scores, scoreExtras } from '$lib/server/database/schemas/scores';
import { charts } from '$lib/server/database/schemas/charts';
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
	unixTimestamp: number;
	chartTitle: string;
	chartSubtitle: string;
	chartMd5: string;
	playLevel: number;
	difficulty: number;
}

export interface UserProfileData {
	id: number;
	name: string;
	image: string | null;
}

export async function getUserScoreGuids(userId: number): Promise<string[]> {
	const rows = await db
		.select({ id: scores.id })
		.from(scores)
		.where(eq(scores.userId, userId));
	return rows.map((r) => r.id);
}

export async function getUserProfile(userId: number): Promise<UserProfileData | null> {
	const result = await db
		.select({ id: user.id, name: user.name, image: user.image })
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);
	return result[0] ?? null;
}

import {
	clearTypeCaseExpr,
	gradeCaseExpr,
	poorPlusBad,
	bestClearTypeExpr
} from '$lib/server/api/sql-helpers';

export type SortableColumn = 'title' | 'score_pct' | 'grade' | 'combo' | 'clear_type' | 'date';

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
	userId: number,
	limit: number,
	offset: number,
	sortBy: SortableColumn | null = null,
	sortDir: 'asc' | 'desc' = 'desc',
	search: string = ''
): Promise<ScoreRow[]> {
	const searchFilter = search
		? sql`TRIM(${charts.title} || ' ' || ${charts.subtitle}) ILIKE ${'%' + search + '%'}`
		: undefined;

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
			chartMd5: charts.md5,
			playLevel: charts.playLevel,
			difficulty: charts.difficulty
		})
		.from(scores)
		.innerJoin(charts, eq(scores.chartMd5, charts.md5))
		.where(searchFilter ? and(eq(scores.userId, userId), searchFilter) : eq(scores.userId, userId))
		.orderBy(getOrderBy(sortBy, sortDir))
		.limit(limit)
		.offset(offset);

	return rows;
}

export async function getUserScoreCount(userId: number, search: string = ''): Promise<number> {
	const searchFilter = search
		? sql`TRIM(${charts.title} || ' ' || ${charts.subtitle}) ILIKE ${'%' + search + '%'}`
		: undefined;

	const result = await db
		.select({ count: count() })
		.from(scores)
		.innerJoin(charts, eq(scores.chartMd5, charts.md5))
		.where(searchFilter ? and(eq(scores.userId, userId), searchFilter) : eq(scores.userId, userId));
	return result[0]?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Latest scores (homepage)
// ---------------------------------------------------------------------------

export interface LatestScoreRow {
	id: string;
	points: number;
	maxPoints: number;
	maxCombo: number;
	maxHits: number;
	clearType: string;
	unixTimestamp: number;
	userId: number;
	userName: string;
	userImage: string | null;
	chartTitle: string;
	chartSubtitle: string;
	chartMd5: string;
	playLevel: number;
	difficulty: number;
}

export async function getLatestScores(limit: number, offset: number): Promise<LatestScoreRow[]> {
	const rows = await db
		.select({
			id: scores.id,
			points: scores.points,
			maxPoints: scores.maxPoints,
			maxCombo: scores.maxCombo,
			maxHits: scores.maxHits,
			clearType: scores.clearType,
			unixTimestamp: scores.unixTimestamp,
			userId: user.id,
			userName: user.name,
			userImage: user.image,
			chartTitle: charts.title,
			chartSubtitle: charts.subtitle,
			chartMd5: charts.md5,
			playLevel: charts.playLevel,
			difficulty: charts.difficulty
		})
		.from(scores)
		.innerJoin(charts, eq(scores.chartMd5, charts.md5))
		.innerJoin(user, eq(scores.userId, user.id))
		.orderBy(desc(scores.unixTimestamp))
		.limit(limit)
		.offset(offset);

	return rows;
}

export async function getLatestScoreCount(): Promise<number> {
	const result = await db.select({ count: count() }).from(scores);
	return result[0]?.count ?? 0;
}

export type ChartData = typeof charts.$inferSelect;

export async function getChartByMd5(md5: string): Promise<ChartData | null> {
	const result = await db
		.select()
		.from(charts)
		.where(eq(charts.md5, md5))
		.limit(1);
	if (!result[0]) return null;
	return result[0];
}

export interface ChartScoreRow {
	userId: number;
	userName: string;
	userImage: string | null;
	bestPoints: number;
	maxPoints: number;
	bestCombo: number;
	maxHits: number;
	bestClearType: string;
	bestComboBreaks: number;
	latestDate: number;
	scoreCount: number;
}

export type ChartSortableColumn = 'player' | 'score_pct' | 'grade' | 'combo' | 'combo_breaks' | 'clear_type' | 'date' | 'play_count';


function getChartOrderBy(sortBy: ChartSortableColumn | null, sortDir: 'asc' | 'desc'): SQL {
	const dir = sortDir === 'asc' ? asc : desc;
	const bestPct = sql`MAX(${scores.points} / NULLIF(${scores.maxPoints}, 0))`;
	switch (sortBy) {
		case 'player':       return sql`${dir(user.name)}, MAX(${scores.unixTimestamp}) DESC`;
		case 'score_pct':
		case 'grade':        return dir(bestPct);
		case 'combo':        return sql`${dir(sql`MAX(${scores.maxCombo})`)}`;
		case 'combo_breaks': return sql`${dir(sql`MIN(${poorPlusBad})`)}`;
		case 'play_count':   return sql`${dir(sql`COUNT(${scores.id})`)}`;
		case 'clear_type':   return sql`${dir(sql`MAX(${clearTypeCaseExpr()})`)}`;
		case 'date':         return sql`${dir(sql`MAX(${scores.unixTimestamp})`)}`;
		default:             return sql`MAX(${scores.unixTimestamp}) DESC`;
	}
}

export async function getChartScores(
	chartMd5: string,
	limit: number,
	offset: number,
	sortBy: ChartSortableColumn | null = null,
	sortDir: 'asc' | 'desc' = 'desc',
	search: string = ''
): Promise<ChartScoreRow[]> {
	const searchFilter = search
		? sql`${user.name} ILIKE ${'%' + search + '%'}`
		: undefined;
	const baseFilter = eq(charts.md5, chartMd5);
	const whereClause = searchFilter ? and(baseFilter, searchFilter) : baseFilter;

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
			latestDate: sql<number>`MAX(${scores.unixTimestamp})`,
			scoreCount: sql<number>`COUNT(${scores.id})`
		})
		.from(scores)
		.innerJoin(charts, eq(scores.chartMd5, charts.md5))
		.innerJoin(user, eq(scores.userId, user.id))
		.where(whereClause)
		.groupBy(user.id, user.name, user.image)
		.orderBy(getChartOrderBy(sortBy, sortDir))
		.limit(limit)
		.offset(offset);

	return rows.map((r) => ({ ...r, scoreCount: Number(r.scoreCount) }));
}

export async function getChartScoreCount(chartMd5: string, search: string = ''): Promise<number> {
	const searchFilter = search
		? sql`${user.name} ILIKE ${'%' + search + '%'}`
		: undefined;
	const baseFilter = eq(charts.md5, chartMd5);
	const whereClause = searchFilter ? and(baseFilter, searchFilter) : baseFilter;

	const result = await db
		.select({ count: sql<number>`COUNT(DISTINCT ${scores.userId})` })
		.from(scores)
		.innerJoin(charts, eq(scores.chartMd5, charts.md5))
		.innerJoin(user, eq(scores.userId, user.id))
		.where(whereClause);
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
	userId: number,
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
		.innerJoin(charts, eq(scores.chartMd5, charts.md5))
		.where(and(eq(charts.md5, chartMd5), eq(scores.userId, userId)))
		.orderBy(getChartUserOrderBy(sortBy, sortDir))
		.limit(limit)
		.offset(offset);

	return rows;
}

export async function getChartUserScoreCount(chartMd5: string, userId: number): Promise<number> {
	const result = await db
		.select({ count: count() })
		.from(scores)
		.innerJoin(charts, eq(scores.chartMd5, charts.md5))
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
	userId: number,
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
		.innerJoin(charts, eq(scores.chartMd5, charts.md5))
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
			length: r.length,
			unixTimestamp: r.unixTimestamp,
			sha256: r.sha256,
			md5: r.md5
		},
		replayData: r.replayData,
		gaugeHistory: r.gaugeHistory
	}));
}

// ---------------------------------------------------------------------------
// Scores for chart grouped by user (for game client download)
// ---------------------------------------------------------------------------

export interface UserScoreGroup {
	profile: {
		id: number;
		username: string;
		avatarUrl: string;
		profileUrl: string;
	};
	scores: ScoreDownloadRow[];
}

export async function getScoresForChartMd5(md5: string): Promise<UserScoreGroup[]> {
	const rows = await db
		.select({
			userId: user.id,
			userName: user.name,
			userImage: user.image,
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
			chartMd5: charts.md5,
			replayData: scoreExtras.replayData,
			gaugeHistory: scoreExtras.gaugeHistory
		})
		.from(scores)
		.innerJoin(charts, eq(scores.chartMd5, charts.md5))
		.innerJoin(scoreExtras, eq(scoreExtras.scoreId, scores.id))
		.innerJoin(user, eq(scores.userId, user.id))
		.where(eq(charts.md5, md5))
		.orderBy(asc(user.id), desc(scores.unixTimestamp));

	// Group by user id
	const groupMap = new Map<number, UserScoreGroup>();
	for (const r of rows) {
		if (!groupMap.has(r.userId)) {
			groupMap.set(r.userId, {
				profile: {
					id: r.userId,
					username: r.userName,
					avatarUrl: r.userImage ?? '',
					profileUrl: `/players/${r.userId}`
				},
				scores: []
			});
		}
		groupMap.get(r.userId)!.scores.push({
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
			length: r.length,
			unixTimestamp: r.unixTimestamp,
			sha256: r.sha256,
			md5: r.chartMd5
		},
		replayData: r.replayData,
		gaugeHistory: r.gaugeHistory
	});
	}

	return Array.from(groupMap.values());
}

// ---------------------------------------------------------------------------
// Users list
// ---------------------------------------------------------------------------

export interface UserListRow {
	id: number;
	name: string;
	image: string | null;
	scoreCount: number;
}

export type UserListSortColumn = 'name' | 'score_count';

export async function getUserList(
	limit: number,
	offset: number,
	sortBy: UserListSortColumn = 'score_count',
	sortDir: 'asc' | 'desc' = 'desc'
): Promise<UserListRow[]> {
	const dir = sortDir === 'asc' ? asc : desc;
	const scoreCountExpr = sql<number>`COUNT(${scores.id})`;
	const orderExprs =
		sortBy === 'name' ? [dir(user.name)] : [dir(scoreCountExpr), asc(user.name)];
	const rows = await db
		.select({
			id: user.id,
			name: user.name,
			image: user.image,
			scoreCount: scoreCountExpr
		})
		.from(user)
		.leftJoin(scores, eq(scores.userId, user.id))
		.groupBy(user.id, user.name, user.image)
		.orderBy(...orderExprs)
		.limit(limit)
		.offset(offset);
	return rows.map((r) => ({ ...r, scoreCount: Number(r.scoreCount) }));
}

export async function getUserListCount(): Promise<number> {
	const result = await db.select({ count: count() }).from(user);
	return result[0]?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Charts list
// ---------------------------------------------------------------------------

export type ChartListSortColumn = 'title' | 'play_count' | 'artist';

export interface ChartListRow {
	id: number;
	md5: string;
	title: string;
	subtitle: string;
	artist: string;
	subartist: string;
	playLevel: number;
	difficulty: number;
	keymode: number;
	playCount: number;
}

export async function getChartList(
	limit: number,
	offset: number,
	sortBy: ChartListSortColumn = 'play_count',
	sortDir: 'asc' | 'desc' = 'desc',
	search: string = ''
): Promise<ChartListRow[]> {
	const dir = sortDir === 'asc' ? asc : desc;
	const playCountExpr = sql<number>`COUNT(DISTINCT ${scores.userId})`;
	const mergedTitle = sql`TRIM(${charts.title} || ' ' || ${charts.subtitle})`;
	const mergedArtist = sql`TRIM(${charts.artist} || ' ' || ${charts.subartist})`;
	const orderExprs =
		sortBy === 'title'
			? [dir(mergedTitle)]
			: sortBy === 'artist'
				? [dir(mergedArtist), asc(mergedTitle)]
				: [dir(playCountExpr), asc(mergedTitle)];
	const searchFilter = search
		? sql`(${mergedTitle} ILIKE ${'%' + search + '%'} OR ${mergedArtist} ILIKE ${'%' + search + '%'})`
		: undefined;
	const rows = await db
		.select({
			id: charts.id,
			md5: charts.md5,
			title: charts.title,
			subtitle: charts.subtitle,
			artist: charts.artist,
			subartist: charts.subartist,
			playLevel: charts.playLevel,
			difficulty: charts.difficulty,
			keymode: charts.keymode,
			playCount: playCountExpr
		})
		.from(charts)
		.leftJoin(scores, eq(scores.chartMd5, charts.md5))
		.where(searchFilter)
		.groupBy(charts.id)
		.orderBy(...orderExprs)
		.limit(limit)
		.offset(offset);
	return rows.map((r) => ({ ...r, playCount: Number(r.playCount) }));
}

export async function getChartListCount(search: string = ''): Promise<number> {
	const mergedTitle = sql`TRIM(${charts.title} || ' ' || ${charts.subtitle})`;
	const mergedArtist = sql`TRIM(${charts.artist} || ' ' || ${charts.subartist})`;
	const searchFilter = search
		? sql`(${mergedTitle} ILIKE ${'%' + search + '%'} OR ${mergedArtist} ILIKE ${'%' + search + '%'})`
		: undefined;
	const result = await db.select({ count: count() }).from(charts).where(searchFilter);
	return result[0]?.count ?? 0;
}

