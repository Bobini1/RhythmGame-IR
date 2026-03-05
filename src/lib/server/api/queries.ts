/**
 * Query functions for the flat REST API layer.
 *
 * These are kept separate from the SSR page queries in `$lib/server/scores/query.ts`
 * to avoid coupling API changes to the web UI.
 */
import { db } from '$lib/server/database/client';
import { scores, charts } from '$lib/server/database/schemas/scores';
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

export type ApiChart = Omit<typeof charts.$inferSelect, 'length'> & { length: number };

export async function getChartByMd5(md5: string): Promise<ApiChart | null> {
	const result = await db.select().from(charts).where(eq(charts.md5, md5)).limit(1);
	if (!result[0]) return null;
	return { ...result[0], length: Number(result[0].length) };
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
}

export async function getUserById(id: number): Promise<ApiUser | null> {
	const rows = await db
		.select({
			id: user.id,
			name: user.name,
			image: user.image,
			createdAt: user.createdAt,
			scoreCount: sql<number>`COUNT(${scores.id})`
		})
		.from(user)
		.leftJoin(scores, eq(scores.userId, user.id))
		.where(eq(user.id, id))
		.groupBy(user.id, user.name, user.image, user.createdAt)
		.limit(1);
	if (!rows[0]) return null;
	return { ...rows[0], scoreCount: Number(rows[0].scoreCount) };
}

// ---------------------------------------------------------------------------
// GET /api/scores/:guid — single score resource
// ---------------------------------------------------------------------------

export interface ApiScore {
	id: string;
	userPublicId: number;
	userName: string;
	chartTitle: string;
	chartSubtitle: string;
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
	md5: string;
}

export async function getScoreByGuid(guid: string): Promise<ApiScore | null> {
	const rows = await db
		.select({
			id: scores.id,
			userPublicId: user.id,
			userName: user.name,
			chartTitle: charts.title,
			chartSubtitle: charts.subtitle,
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
			md5: charts.md5
		})
		.from(scores)
		.innerJoin(charts, eq(scores.chartId, charts.id))
		.innerJoin(user, eq(scores.userId, user.id))
		.where(eq(scores.id, guid))
		.limit(1);
	if (!rows[0]) return null;
	return { ...rows[0], length: Number(rows[0].length), unixTimestamp: Number(rows[0].unixTimestamp) };
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
	userPublicId: number;
	userName: string;
	chartMd5: string;
	chartTitle: string;
	chartSubtitle: string;
	playLevel: number;
	difficulty: number;
	points: number;
	maxPoints: number;
	maxCombo: number;
	maxHits: number;
	clearType: string;
	unixTimestamp: number;
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
			userPublicId: user.id,
			userName: user.name,
			userImage: user.image,
			chartMd5: charts.md5,
			chartTitle: charts.title,
			chartSubtitle: charts.subtitle,
			playLevel: charts.playLevel,
			difficulty: charts.difficulty,
			points: scores.points,
			maxPoints: scores.maxPoints,
			maxCombo: scores.maxCombo,
			maxHits: scores.maxHits,
			clearType: scores.clearType,
			unixTimestamp: scores.unixTimestamp
		})
		.from(scores)
		.innerJoin(charts, eq(scores.chartId, charts.id))
		.innerJoin(user, eq(scores.userId, user.id))
		.where(where)
		.orderBy(scoresCollectionOrder(orderBy, sort))
		.limit(limit)
		.offset(offset);

	return rows.map((r) => ({ ...r, unixTimestamp: Number(r.unixTimestamp) }));
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
		.innerJoin(user, eq(scores.userId, user.id))
		.where(where);
	return result[0]?.count ?? 0;
}

// ---------------------------------------------------------------------------
// GET /api/charts — charts collection (with full-text search)
// ---------------------------------------------------------------------------

export type ChartsOrderBy = 'title' | 'play_count' | 'play_level';

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
	playCount: number;
}

export async function queryCharts(
	filters: ChartsCollectionFilters,
	limit: number,
	offset: number,
	orderBy: ChartsOrderBy = 'play_count',
	sort: 'asc' | 'desc' = 'desc'
): Promise<ChartsCollectionRow[]> {
	const dir = sort === 'asc' ? asc : desc;
	const playCountExpr = sql<number>`COUNT(DISTINCT ${scores.userId})`;
	const mergedTitle = sql`TRIM(${charts.title} || ' ' || ${charts.subtitle})`;

	const conditions: SQL[] = [];
	if (filters.query) {
		// Use PostgreSQL full-text search with simple config (works with non-English titles)
		// Convert the user query into a tsquery: split words, add :* for prefix matching
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
		case 'play_count':
		default:
			orderExprs = [dir(playCountExpr), asc(mergedTitle)];
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
			playCount: playCountExpr
		})
		.from(charts)
		.leftJoin(scores, eq(scores.chartId, charts.id))
		.where(where)
		.groupBy(charts.id)
		.orderBy(...orderExprs)
		.limit(limit)
		.offset(offset);

	return rows.map((r) => ({ ...r, playCount: Number(r.playCount) }));
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

	const result = await db
		.select({ count: count() })
		.from(charts)
		.where(where);
	return result[0]?.count ?? 0;
}

// ---------------------------------------------------------------------------
// GET /api/users — users collection
// ---------------------------------------------------------------------------

export type UsersOrderBy = 'name' | 'score_count';

export interface UsersCollectionRow {
	id: number;
	name: string;
	image: string | null;
	scoreCount: number;
}

export async function queryUsers(
	limit: number,
	offset: number,
	orderBy: UsersOrderBy = 'score_count',
	sort: 'asc' | 'desc' = 'desc'
): Promise<UsersCollectionRow[]> {
	const dir = sort === 'asc' ? asc : desc;
	const scoreCountExpr = sql<number>`COUNT(${scores.id})`;
	const orderExprs =
		orderBy === 'name' ? [dir(user.name)] : [dir(scoreCountExpr), asc(user.name)];

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

export interface ScoreSummaryRow {
	userPublicId: number;
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
			userPublicId: user.id,
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

	return rows.map((r) => ({
		...r,
		latestDate: Number(r.latestDate),
		scoreCount: Number(r.scoreCount)
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



