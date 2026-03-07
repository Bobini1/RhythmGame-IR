/**
 * Query functions for the flat REST API layer.
 *
 * These are kept separate from the SSR page queries in `$lib/server/scores/query.ts`
 * to avoid coupling API changes to the web UI.
 */
import { db } from '$lib/server/database/client';
import { scores, charts, scoreExtras } from '$lib/server/database/schemas/scores';
import { user } from '$lib/server/database/schemas/auth';
import {
	eq,
	desc,
	asc,
	count,
	and,
	sql,
	type SQL
} from 'drizzle-orm';
import { GRADE_THRESHOLDS, GRADE_LABELS } from '$lib/utils/grades';

// ---------------------------------------------------------------------------
// Shared SQL helpers (mirrored from scores/query.ts for independence)
// ---------------------------------------------------------------------------

const CLEAR_TYPE_PRIORITIES: Record<string, number> = {
	NOPLAY: 0,
	FAILED: 1,
	ASSIST_CLEAR: 2,
	EASY: 3,
	NORMAL: 4,
	HARD: 5,
	EXHARD: 6,
	FC: 7
};

function clearTypeCaseExpr() {
	const branches = Object.entries(CLEAR_TYPE_PRIORITIES)
		.map(([ct, p]) => sql`WHEN ${scores.clearType} = ${ct} THEN ${p}`)
		.reduce<SQL>((acc, part) => sql`${acc} ${part}`, sql``);
	return sql<number>`CASE ${branches} ELSE 0 END`;
}

function gradeCaseExpr() {
	const pct = sql`${scores.points} / NULLIF(${scores.maxPoints}, 0)`;
	const branches = GRADE_THRESHOLDS.map(
		(threshold, i) => sql`WHEN ${pct} >= ${threshold} THEN ${i}`
	).reduce<SQL>((acc, part) => sql`${acc} ${part}`, sql``);
	return sql<number>`CASE ${branches} ELSE ${GRADE_LABELS.length - 1} END`;
}

const poorPlusBad = sql<number>`(${scores.judgementCounts}->0)::int + (${scores.judgementCounts}->2)::int`;

function bestClearTypeExpr() {
	const maxPriority = sql`MAX(${clearTypeCaseExpr()})`;
	const branches = Object.entries(CLEAR_TYPE_PRIORITIES)
		.map(([ct, p]) => sql`WHEN ${maxPriority} = ${p} THEN ${ct}`)
		.reduce<SQL>((acc, part) => sql`${acc} ${part}`, sql``);
	return sql<string>`CASE ${branches} ELSE 'NOPLAY' END`;
}

// ---------------------------------------------------------------------------
// GET /api/charts/:md5 — single chart resource
// ---------------------------------------------------------------------------

export interface ApiChart {
	id: string;
	sha256: string;
	md5: string;
	title: string;
	subtitle: string;
	artist: string;
	subartist: string;
	genre: string;
	rank: number;
	total: number;
	playLevel: number;
	difficulty: number;
	keymode: number;
	normalNoteCount: number;
	scratchCount: number;
	lnCount: number;
	bssCount: number;
	mineCount: number;
	length: number;
	initialBpm: number;
	maxBpm: number;
	minBpm: number;
	mainBpm: number;
	avgBpm: number;
	peakDensity: number;
	avgDensity: number;
	endDensity: number;
	createdAt: Date;
	updatedAt: Date;
	scoreCount: number;
	playerCount: number;
}

export interface ApiChartHistogram {
	histogramData: number[][];
}

export interface ApiChartBpmChanges {
	bpmChanges: { bpm: number; offsetFromStart: number }[];
}

export async function getChartByMd5(md5: string): Promise<ApiChart | null> {
	const rows = await db
		.select({
			id: charts.id,
			sha256: charts.sha256,
			md5: charts.md5,
			title: charts.title,
			subtitle: charts.subtitle,
			artist: charts.artist,
			subartist: charts.subartist,
			genre: charts.genre,
			rank: charts.rank,
			total: charts.total,
			playLevel: charts.playLevel,
			difficulty: charts.difficulty,
			keymode: charts.keymode,
			normalNoteCount: charts.normalNoteCount,
			scratchCount: charts.scratchCount,
			lnCount: charts.lnCount,
			bssCount: charts.bssCount,
			mineCount: charts.mineCount,
			length: charts.length,
			initialBpm: charts.initialBpm,
			maxBpm: charts.maxBpm,
			minBpm: charts.minBpm,
			mainBpm: charts.mainBpm,
			avgBpm: charts.avgBpm,
			peakDensity: charts.peakDensity,
			avgDensity: charts.avgDensity,
			endDensity: charts.endDensity,
			createdAt: charts.createdAt,
			updatedAt: charts.updatedAt,
			scoreCount: sql<number>`COUNT(${scores.id})`,
			playerCount: sql<number>`COUNT(DISTINCT ${scores.userId})`
		})
		.from(charts)
		.leftJoin(scores, eq(scores.chartId, charts.id))
		.where(eq(charts.md5, md5))
		.groupBy(charts.id)
		.limit(1);
	if (!rows[0]) return null;
	return {
		...rows[0],
		scoreCount: Number(rows[0].scoreCount),
		playerCount: Number(rows[0].playerCount)
	};
}

export async function getChartHistogram(md5: string): Promise<ApiChartHistogram | null> {
	const result = await db
		.select({ histogramData: charts.histogramData })
		.from(charts)
		.where(eq(charts.md5, md5))
		.limit(1);
	return result[0] ?? null;
}

export async function getChartBpmChanges(md5: string): Promise<ApiChartBpmChanges | null> {
	const result = await db
		.select({ bpmChanges: charts.bpmChanges })
		.from(charts)
		.where(eq(charts.md5, md5))
		.limit(1);
	return result[0] ?? null;
}

// ---------------------------------------------------------------------------
// GET /api/users/:id — single user resource
// ---------------------------------------------------------------------------

export interface ApiUser {
	id: number;
	name: string;
	image: string | null;
	createdAt: Date;
	scoreCount: number;
	chartCount: number;
}

export async function getUserById(id: number): Promise<ApiUser | null> {
	const rows = await db
		.select({
			id: user.id,
			name: user.name,
			image: user.image,
			createdAt: user.createdAt,
			scoreCount: sql<number>`COUNT(${scores.id})`,
			chartCount: sql<number>`COUNT(DISTINCT ${scores.chartId})`
		})
		.from(user)
		.leftJoin(scores, eq(scores.userId, user.id))
		.where(eq(user.id, id))
		.groupBy(user.id, user.name, user.image, user.createdAt)
		.limit(1);
	if (!rows[0]) return null;
	return {
		...rows[0],
		scoreCount: Number(rows[0].scoreCount),
		chartCount: Number(rows[0].chartCount)
	};
}

// ---------------------------------------------------------------------------
// GET /api/scores/:guid — single score resource
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
	gameVersion: string;
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
		.innerJoin(charts, eq(scores.chartId, charts.id))
		.where(eq(scores.id, guid))
		.limit(1);
	if (!rows[0]) return null;
	return rows[0];
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
// GET /api/scores — scores collection
// ---------------------------------------------------------------------------

export type ScoresOrderBy = 'date' | 'score_pct' | 'grade' | 'combo' | 'clear_type';

function scoresCollectionOrder(orderBy: ScoresOrderBy, sort: 'asc' | 'desc'): SQL {
	const dir = sort === 'asc' ? asc : desc;
	const pct = sql`${scores.points} / NULLIF(${scores.maxPoints}, 0)`;
	switch (orderBy) {
		case 'score_pct':
			return dir(pct);
		case 'grade':
			return sort === 'asc'
				? sql`${gradeCaseExpr()} ASC, ${pct} ASC`
				: sql`${gradeCaseExpr()} DESC, ${pct} DESC`;
		case 'combo':
			return sql`${dir(scores.maxCombo)}, ${desc(scores.unixTimestamp)}`;
		case 'clear_type':
			return sql`${dir(clearTypeCaseExpr())}, ${desc(scores.unixTimestamp)}`;
		case 'date':
		default:
			return dir(scores.unixTimestamp);
	}
}

export interface ScoresCollectionRow {
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
	gameVersion: string;
	length: number;
	unixTimestamp: number;
	sha256: string;
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

export async function queryScores(
	filters: ScoresCollectionFilters,
	limit: number,
	offset: number,
	orderBy: ScoresOrderBy = 'date',
	sort: 'asc' | 'desc' = 'desc'
): Promise<ScoresCollectionRow[]> {
	const conditions: SQL[] = [];
	if (filters.chart) conditions.push(eq(charts.md5, filters.chart));
	if (filters.user !== undefined) conditions.push(eq(user.id, filters.user));
	if (filters.dateGte !== undefined) conditions.push(sql`${scores.unixTimestamp} >= ${filters.dateGte}`);
	if (filters.dateLte !== undefined) conditions.push(sql`${scores.unixTimestamp} <= ${filters.dateLte}`);
	if (filters.scorePctGte !== undefined) {
		conditions.push(sql`${scores.points} / NULLIF(${scores.maxPoints}, 0) >= ${filters.scorePctGte}`);
	}
	if (filters.scorePctLte !== undefined) {
		conditions.push(sql`${scores.points} / NULLIF(${scores.maxPoints}, 0) <= ${filters.scorePctLte}`);
	}
	if (filters.comboGte !== undefined) conditions.push(sql`${scores.maxCombo} >= ${filters.comboGte}`);
	if (filters.comboLte !== undefined) conditions.push(sql`${scores.maxCombo} <= ${filters.comboLte}`);

	const where = conditions.length > 0 ? and(...conditions) : undefined;

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
		.innerJoin(charts, eq(scores.chartId, charts.id))
		.where(where)
		.orderBy(scoresCollectionOrder(orderBy, sort))
		.limit(limit)
		.offset(offset);

	return rows;
}

export async function queryScoresCount(filters: ScoresCollectionFilters): Promise<number> {
	const conditions: SQL[] = [];
	if (filters.chart) conditions.push(eq(charts.md5, filters.chart));
	if (filters.user !== undefined) conditions.push(eq(user.id, filters.user));
	if (filters.dateGte !== undefined) conditions.push(sql`${scores.unixTimestamp} >= ${filters.dateGte}`);
	if (filters.dateLte !== undefined) conditions.push(sql`${scores.unixTimestamp} <= ${filters.dateLte}`);
	if (filters.scorePctGte !== undefined) {
		conditions.push(sql`${scores.points} / NULLIF(${scores.maxPoints}, 0) >= ${filters.scorePctGte}`);
	}
	if (filters.scorePctLte !== undefined) {
		conditions.push(sql`${scores.points} / NULLIF(${scores.maxPoints}, 0) <= ${filters.scorePctLte}`);
	}
	if (filters.comboGte !== undefined) conditions.push(sql`${scores.maxCombo} >= ${filters.comboGte}`);
	if (filters.comboLte !== undefined) conditions.push(sql`${scores.maxCombo} <= ${filters.comboLte}`);

	const where = conditions.length > 0 ? and(...conditions) : undefined;

	const result = await db
		.select({ count: count() })
		.from(scores)
		.innerJoin(charts, eq(scores.chartId, charts.id))
		.where(where);
	return result[0]?.count ?? 0;
}

// ---------------------------------------------------------------------------
// GET /api/charts — charts collection (with full-text search)
// ---------------------------------------------------------------------------

export type ChartsOrderBy = 'title' | 'play_count' | 'play_level' | 'score_count' | 'player_count';

export interface ChartsCollectionFilters {
	query?: string;
	keymodeGte?: number;
	keymodeLte?: number;
	playLevelGte?: number;
	playLevelLte?: number;
}

export interface ChartsCollectionRow {
	id: string;
	md5: string;
	sha256: string;
	title: string;
	subtitle: string;
	artist: string;
	subartist: string;
	genre: string;
	playLevel: number;
	difficulty: number;
	keymode: number;
	scoreCount: number;
	playerCount: number;
}

export async function queryCharts(
	filters: ChartsCollectionFilters,
	limit: number,
	offset: number,
	orderBy: ChartsOrderBy = 'player_count',
	sort: 'asc' | 'desc' = 'desc'
): Promise<ChartsCollectionRow[]> {
	const dir = sort === 'asc' ? asc : desc;
	const scoreCountExpr = sql<number>`COUNT(${scores.id})`;
	const playerCountExpr = sql<number>`COUNT(DISTINCT ${scores.userId})`;
	const mergedTitle = sql`TRIM(${charts.title} || ' ' || ${charts.subtitle})`;

	const conditions: SQL[] = [];
	if (filters.query) {
		const tsQuery = filters.query
			.trim()
			.split(/\s+/)
			.filter((w) => w.length > 0)
			.map((w) => `${w}:*`)
			.join(' & ');
		if (tsQuery) {
			conditions.push(
				sql`to_tsvector('simple', COALESCE(${charts.title}, '') || ' ' || COALESCE(${charts.subtitle}, '') || ' ' || COALESCE(${charts.artist}, '') || ' ' || COALESCE(${charts.subartist}, '') || ' ' || COALESCE(${charts.genre}, '')) @@ to_tsquery('simple', ${tsQuery})`
			);
		}
	}
	if (filters.keymodeGte !== undefined) conditions.push(sql`${charts.keymode} >= ${filters.keymodeGte}`);
	if (filters.keymodeLte !== undefined) conditions.push(sql`${charts.keymode} <= ${filters.keymodeLte}`);
	if (filters.playLevelGte !== undefined) conditions.push(sql`${charts.playLevel} >= ${filters.playLevelGte}`);
	if (filters.playLevelLte !== undefined) conditions.push(sql`${charts.playLevel} <= ${filters.playLevelLte}`);

	const where = conditions.length > 0 ? and(...conditions) : undefined;

	let orderExprs: SQL[];
	switch (orderBy) {
		case 'title':
			orderExprs = [dir(mergedTitle)];
			break;
		case 'play_level':
			orderExprs = [dir(charts.playLevel), asc(mergedTitle)];
			break;
		case 'score_count':
			orderExprs = [dir(scoreCountExpr), asc(mergedTitle)];
			break;
		case 'player_count':
		case 'play_count':
		default:
			orderExprs = [dir(playerCountExpr), asc(mergedTitle)];
			break;
	}

	const rows = await db
		.select({
			id: charts.id,
			md5: charts.md5,
			sha256: charts.sha256,
			title: charts.title,
			subtitle: charts.subtitle,
			artist: charts.artist,
			subartist: charts.subartist,
			genre: charts.genre,
			playLevel: charts.playLevel,
			difficulty: charts.difficulty,
			keymode: charts.keymode,
			scoreCount: scoreCountExpr,
			playerCount: playerCountExpr
		})
		.from(charts)
		.leftJoin(scores, eq(scores.chartId, charts.id))
		.where(where)
		.groupBy(charts.id)
		.orderBy(...orderExprs)
		.limit(limit)
		.offset(offset);

	return rows.map((r) => ({
		...r,
		scoreCount: Number(r.scoreCount),
		playerCount: Number(r.playerCount)
	}));
}

export async function queryChartsCount(filters: ChartsCollectionFilters): Promise<number> {
	const conditions: SQL[] = [];
	if (filters.query) {
		const tsQuery = filters.query
			.trim()
			.split(/\s+/)
			.filter((w) => w.length > 0)
			.map((w) => `${w}:*`)
			.join(' & ');
		if (tsQuery) {
			conditions.push(
				sql`to_tsvector('simple', COALESCE(${charts.title}, '') || ' ' || COALESCE(${charts.subtitle}, '') || ' ' || COALESCE(${charts.artist}, '') || ' ' || COALESCE(${charts.subartist}, '') || ' ' || COALESCE(${charts.genre}, '')) @@ to_tsquery('simple', ${tsQuery})`
			);
		}
	}
	if (filters.keymodeGte !== undefined) conditions.push(sql`${charts.keymode} >= ${filters.keymodeGte}`);
	if (filters.keymodeLte !== undefined) conditions.push(sql`${charts.keymode} <= ${filters.keymodeLte}`);
	if (filters.playLevelGte !== undefined) conditions.push(sql`${charts.playLevel} >= ${filters.playLevelGte}`);
	if (filters.playLevelLte !== undefined) conditions.push(sql`${charts.playLevel} <= ${filters.playLevelLte}`);

	const where = conditions.length > 0 ? and(...conditions) : undefined;

	const result = await db.select({ count: count() }).from(charts).where(where);
	return result[0]?.count ?? 0;
}

// ---------------------------------------------------------------------------
// GET /api/users — users collection
// ---------------------------------------------------------------------------

export type UsersOrderBy = 'name' | 'score_count' | 'chart_count';

export interface UsersCollectionRow {
	id: number;
	name: string;
	image: string | null;
	scoreCount: number;
	chartCount: number;
}

export async function queryUsers(
	limit: number,
	offset: number,
	orderBy: UsersOrderBy = 'score_count',
	sort: 'asc' | 'desc' = 'desc'
): Promise<UsersCollectionRow[]> {
	const dir = sort === 'asc' ? asc : desc;
	const scoreCountExpr = sql<number>`COUNT(${scores.id})`;
	const chartCountExpr = sql<number>`COUNT(DISTINCT ${scores.chartId})`;
	const orderExprs =
		orderBy === 'name'
			? [dir(user.name)]
			: orderBy === 'chart_count'
				? [dir(chartCountExpr), asc(user.name)]
				: [dir(scoreCountExpr), asc(user.name)];
	const rows = await db
		.select({
			id: user.id,
			name: user.name,
			image: user.image,
			scoreCount: scoreCountExpr,
			chartCount: chartCountExpr
		})
		.from(user)
		.leftJoin(scores, eq(scores.userId, user.id))
		.groupBy(user.id, user.name, user.image)
		.orderBy(...orderExprs)
		.limit(limit)
		.offset(offset);

	return rows.map((r) => ({
		...r,
		scoreCount: Number(r.scoreCount),
		chartCount: Number(r.chartCount)
	}));
}

export async function queryUsersCount(): Promise<number> {
	const result = await db.select({ count: count() }).from(user);
	return result[0]?.count ?? 0;
}

// ---------------------------------------------------------------------------
// GET /api/score_summaries — score summaries collection
// (best per-user aggregates on a chart)
// ---------------------------------------------------------------------------

export type ScoreSummariesOrderBy =
	| 'player'
	| 'score_pct'
	| 'grade'
	| 'combo'
	| 'combo_breaks'
	| 'clear_type'
	| 'date'
	| 'play_count';

export interface ScoreSummaryUser {
	id: number;
	name: string;
	image: string | null;
}

export interface ScoreSummaryRow {
	user: ScoreSummaryUser;
	bestPoints: number;
	maxPoints: number;
	bestCombo: number;
	maxHits: number;
	bestClearType: string;
	bestComboBreaks: number;
	latestDate: number;
	scoreCount: number;
}

function scoreSummaryOrder(orderBy: ScoreSummariesOrderBy, sort: 'asc' | 'desc'): SQL {
	const dir = sort === 'asc' ? asc : desc;
	const bestPct = sql`MAX(${scores.points} / NULLIF(${scores.maxPoints}, 0))`;
	switch (orderBy) {
		case 'player':
			return sql`${dir(user.name)}, MAX(${scores.unixTimestamp}) DESC`;
		case 'score_pct':
		case 'grade':
			return dir(bestPct);
		case 'combo':
			return sql`${dir(sql`MAX(${scores.maxCombo})`)}`;
		case 'combo_breaks':
			return sql`${dir(sql`MIN(${poorPlusBad})`)}`;
		case 'play_count':
			return sql`${dir(sql`COUNT(${scores.id})`)}`;
		case 'clear_type':
			return sql`${dir(sql`MAX(${clearTypeCaseExpr()})`)}`;
		case 'date':
			return sql`${dir(sql`MAX(${scores.unixTimestamp})`)}`;
		default:
			return sql`MAX(${scores.unixTimestamp}) DESC`;
	}
}

export async function queryScoreSummaries(
	chartMd5: string,
	limit: number,
	offset: number,
	orderBy: ScoreSummariesOrderBy = 'score_pct',
	sort: 'asc' | 'desc' = 'desc',
	search: string = ''
): Promise<ScoreSummaryRow[]> {
	const conditions: SQL[] = [eq(charts.md5, chartMd5)];
	if (search) conditions.push(sql`${user.name} ILIKE ${'%' + search + '%'}`);
	const where = and(...conditions);

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
		.innerJoin(charts, eq(scores.chartId, charts.id))
		.innerJoin(user, eq(scores.userId, user.id))
		.where(where)
		.groupBy(user.id, user.name, user.image)
		.orderBy(scoreSummaryOrder(orderBy, sort))
		.limit(limit)
		.offset(offset);

	return rows.map(({ userId, userName, userImage, ...rest }) => ({
		...rest,
		user: { id: userId, name: userName, image: userImage },
		scoreCount: Number(rest.scoreCount)
	}));
}

export async function queryScoreSummariesCount(
	chartMd5: string,
	search: string = ''
): Promise<number> {
	const conditions: SQL[] = [eq(charts.md5, chartMd5)];
	if (search) conditions.push(sql`${user.name} ILIKE ${'%' + search + '%'}`);
	const where = and(...conditions);

	const result = await db
		.select({ count: sql<number>`COUNT(DISTINCT ${scores.userId})` })
		.from(scores)
		.innerJoin(charts, eq(scores.chartId, charts.id))
		.innerJoin(user, eq(scores.userId, user.id))
		.where(where);
	return Number(result[0]?.count ?? 0);
}










