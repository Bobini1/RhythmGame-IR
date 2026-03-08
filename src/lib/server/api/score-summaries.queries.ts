import { db } from '$lib/server/database/client';
import { scores } from '$lib/server/database/schemas/scores';
import { charts } from '$lib/server/database/schemas/charts';
import { user } from '$lib/server/database/schemas/auth';
import { eq, asc, desc, and, sql, type SQL } from 'drizzle-orm';
import { poorPlusBad, clearTypeCaseExpr, bestClearTypeExpr } from './sql-helpers';

// ---------------------------------------------------------------------------
// GET /api/score_summaries  Escore summaries collection
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
		.innerJoin(charts, eq(scores.chartMd5, charts.md5))
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
		.innerJoin(charts, eq(scores.chartMd5, charts.md5))
		.innerJoin(user, eq(scores.userId, user.id))
		.where(where);
	return Number(result[0]?.count ?? 0);
}
