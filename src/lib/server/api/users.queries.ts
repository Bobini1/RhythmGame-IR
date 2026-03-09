import { db } from '$lib/server/database/client';
import { scores } from '$lib/server/database/schemas/scores';
import { user } from '$lib/server/database/schemas/auth';
import { asc, count, desc, eq, sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// GET /api/users/:id single user resource
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
			scoreCount: sql<number>`COUNT(${scores.guid})`,
			chartCount: sql<number>`COUNT(DISTINCT ${scores.md5})`
		})
		.from(user)
		.leftJoin(scores, eq(scores.userId, user.id))
		.where(eq(user.id, id))
		.groupBy(user.id, user.name, user.image, user.createdAt)
		.limit(1);
	if (!rows[0]) return null;
	return rows[0];
}

// ---------------------------------------------------------------------------
// GET /api/users users collection
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
	limit?: number,
	offset?: number,
	orderBy: UsersOrderBy = 'score_count',
	sort: 'asc' | 'desc' = 'desc'
): Promise<UsersCollectionRow[]> {
	const dir = sort === 'asc' ? asc : desc;
	const scoreCountExpr = sql<number>`COUNT(${scores.guid})`;
	const chartCountExpr = sql<number>`COUNT(DISTINCT ${scores.md5})`;
	const orderExprs =
		orderBy === 'name'
			? [dir(user.name)]
			: orderBy === 'chart_count'
				? [dir(chartCountExpr), asc(user.name)]
				: [dir(scoreCountExpr), asc(user.name)];

	return db
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
		.limit(limit ?? Number.MAX_SAFE_INTEGER)
		.offset(offset ?? 0);
}

export async function queryUsersCount(): Promise<number> {
	const result = await db.select({ count: count() }).from(user);
	return result[0]?.count ?? 0;
}

