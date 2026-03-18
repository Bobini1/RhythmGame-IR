import { db } from '$lib/server/database/client';
import { scores } from '$lib/server/database/schemas/scores';
import { charts } from '$lib/server/database/schemas/charts';
import { user } from '$lib/server/database/schemas/auth';
import { eq, asc, desc, and, sql, type SQL } from 'drizzle-orm';
import { poorPlusBad, clearTypeCaseExpr } from './sql-helpers';

// ---------------------------------------------------------------------------
// GET /api/score_summaries score summaries collection
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
	md5: string;
	bestPoints: number;
	maxPoints: number;
	bestCombo: number;
	maxHits: number;
	bestClearType: string;
	bestComboBreaks: number;
	latestDate: number;
	scoreCount: number;
	// GUIDs for the scores that produced the "best" values above
	bestPointsGuid: string;
	bestComboGuid: string;
	bestComboBreaksGuid: string;
	bestClearTypeGuid: string;
	latestDateGuid: string;
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
			return sql`${dir(sql`COUNT(${scores.guid})::int`)}`;
		case 'clear_type':
			return sql`${dir(sql`MAX(${clearTypeCaseExpr()})`)}`;
		case 'date':
			return sql`${dir(sql`MAX(${scores.unixTimestamp})`)}`;
		default:
			return sql`MAX(${scores.unixTimestamp}) DESC`;
	}
}

export interface ScoreSummaryFilters {
	md5?: string;
	user?: number;
	lastPlayedGte?: number;
	lastPlayedLte?: number;
	scorePctGte?: number;
	scorePctLte?: number;
	comboGte?: number;
	comboLte?: number;
	missCountGte?: number;
	missCountLte?: number;
}

function buildWhereConditions(filters: ScoreSummaryFilters): SQL[] {
	const conditions: SQL[] = [];
	if (filters.md5) conditions.push(eq(charts.md5, filters.md5.toUpperCase()));
	if (filters.user !== undefined) conditions.push(eq(scores.userId, filters.user));
	return conditions;
}

function buildHavingConditions(filters: ScoreSummaryFilters): SQL[] {
	const conditions: SQL[] = [];
	if (filters.lastPlayedGte !== undefined)
		conditions.push(sql`MAX(${scores.unixTimestamp}) >= ${filters.lastPlayedGte}`);
	if (filters.lastPlayedLte !== undefined)
		conditions.push(sql`MAX(${scores.unixTimestamp}) <= ${filters.lastPlayedLte}`);
	if (filters.scorePctGte !== undefined)
		conditions.push(
			sql`MAX(${scores.points} / NULLIF(${scores.maxPoints}, 0)) >= ${filters.scorePctGte}`
		);
	if (filters.scorePctLte !== undefined)
		conditions.push(
			sql`MIN(${scores.points} / NULLIF(${scores.maxPoints}, 0)) <= ${filters.scorePctLte}`
		);
	if (filters.comboGte !== undefined)
		conditions.push(sql`MAX(${scores.maxCombo}) >= ${filters.comboGte}`);
	if (filters.comboLte !== undefined)
		conditions.push(sql`MIN(${scores.maxCombo}) <= ${filters.comboLte}`);
	if (filters.missCountGte !== undefined)
		conditions.push(sql`MIN(${poorPlusBad}) >= ${filters.missCountGte}`);
	if (filters.missCountLte !== undefined)
		conditions.push(sql`MAX(${poorPlusBad}) <= ${filters.missCountLte}`);
	return conditions;
}

export async function queryScoreSummaries(
	filters: ScoreSummaryFilters,
	limit?: number,
	offset?: number,
	orderBy: ScoreSummariesOrderBy = 'score_pct',
	sort: 'asc' | 'desc' = 'desc',
	search: string = ''
): Promise<ScoreSummaryRow[]> {
	const whereConditions = buildWhereConditions(filters);
	const havingConditions = buildHavingConditions(filters);
	if (search) whereConditions.push(sql`${user.name} ILIKE ${'%' + search + '%'}`);

	// Build base query and apply limit/offset only when provided
	const query = db
		.select({
			userId: user.id,
			userName: user.name,
			userImage: user.image,
			md5: charts.md5,
			bestPoints: sql<number>`(ARRAY_AGG(${scores.points} ORDER BY ${scores.points} DESC, ${scores.unixTimestamp} DESC))[1]`,
			maxPoints: sql<number>`(ARRAY_AGG(${scores.maxPoints} ORDER BY ${scores.points} DESC, ${scores.unixTimestamp} DESC))[1]`,
			bestCombo: sql<number>`(ARRAY_AGG(${scores.maxCombo} ORDER BY ${scores.maxCombo} DESC, ${scores.unixTimestamp} DESC))[1]`,
			maxHits: sql<number>`(ARRAY_AGG(${scores.maxHits} ORDER BY ${scores.maxCombo} DESC, ${scores.unixTimestamp} DESC))[1]`,
			bestComboBreaks: sql<number>`(ARRAY_AGG(${poorPlusBad} ORDER BY ${poorPlusBad} ASC, ${scores.unixTimestamp} DESC))[1]`,
			bestClearType: sql<string>`(ARRAY_AGG(${scores.clearType} ORDER BY ${clearTypeCaseExpr()} DESC, ${scores.unixTimestamp} DESC))[1]`,
			latestDate: sql<number>`MAX(${scores.unixTimestamp})`,
			scoreCount: sql<number>`COUNT(${scores.guid})::int`,
			latestDateGuid: sql<string>`(ARRAY_AGG(${scores.guid} ORDER BY ${scores.unixTimestamp} DESC))[1]`,
			bestPointsGuid: sql<string>`(ARRAY_AGG(${scores.guid} ORDER BY ${scores.points} DESC, ${scores.unixTimestamp} DESC))[1]`,
			bestComboGuid: sql<string>`(ARRAY_AGG(${scores.guid} ORDER BY ${scores.maxCombo} DESC, ${scores.unixTimestamp} DESC))[1]`,
			bestComboBreaksGuid: sql<string>`(ARRAY_AGG(${scores.guid} ORDER BY ${poorPlusBad} ASC, ${scores.unixTimestamp} DESC))[1]`,
			bestClearTypeGuid: sql<string>`(ARRAY_AGG(${scores.guid} ORDER BY ${clearTypeCaseExpr()} DESC, ${scores.unixTimestamp} DESC))[1]`
		})
		.from(scores)
		.innerJoin(charts, eq(scores.md5, charts.md5))
		.innerJoin(user, eq(scores.userId, user.id))
		.where(whereConditions.length > 0 ? and(...whereConditions) : undefined)
		.groupBy(user.id, user.name, user.image, charts.md5)
		.having(havingConditions.length > 0 ? and(...havingConditions) : undefined)
		.orderBy(scoreSummaryOrder(orderBy, sort));

	const limitedQuery = limit !== undefined ? query.limit(limit) : query;
	const finalQuery = offset !== undefined ? limitedQuery.offset(offset) : limitedQuery;

	const rows = await finalQuery;

	return rows.map(({ userId, userName, userImage, ...rest }) => ({
		user: { id: Number(userId), name: userName, image: userImage },
		...rest
	}));
}

export async function queryScoreSummariesCount(
	filters: ScoreSummaryFilters,
	search: string = ''
): Promise<number> {
	const whereConditions = buildWhereConditions(filters);
	const havingConditions = buildHavingConditions(filters);
	if (search) whereConditions.push(sql`${user.name} ILIKE ${'%' + search + '%'}`);

	// Create a subquery that matches the main query's filtering logic
	const subquery = db
		.select({
			userId: scores.userId
		})
		.from(scores)
		.innerJoin(charts, eq(scores.md5, charts.md5))
		.innerJoin(user, eq(scores.userId, user.id))
		.where(whereConditions.length > 0 ? and(...whereConditions) : undefined)
		.groupBy(scores.userId, charts.md5)
		.having(havingConditions.length > 0 ? and(...havingConditions) : undefined);

	// Count distinct users from the filtered subquery
	const result = await db
		.select({ count: sql<number>`COUNT(DISTINCT ${scores.userId})::int` })
		.from(subquery.as('filtered_users'));

	return Number(result[0]?.count ?? 0);
}
