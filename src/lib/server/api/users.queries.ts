import { db } from '$lib/server/database/client';
import { scores } from '$lib/server/database/schemas/scores';
import { user } from '$lib/server/database/schemas/auth';
import { asc, count, desc, eq, sql, and } from 'drizzle-orm';
import { integrations } from '$lib/server/database/schemas/integrations';
import { PUBLIC_AVATAR_SEED_SALT } from '$env/static/public';

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
	tachiId: number | null;
}

export async function getUserById(id: number): Promise<ApiUser | null> {
	const rows = await db
		.select({
			id: user.id,
			name: user.name,
			// If the user has no uploaded image, return a deterministic DiceBear Adventurer avatar URL (DiceBear 9.x)
			image: sql<string>`COALESCE(${user.image}, ('https://api.dicebear.com/9.x/adventurer/svg?seed=' || ${PUBLIC_AVATAR_SEED_SALT} || ${user.id}::text))`,
			createdAt: user.createdAt,
			scoreCount: sql<number>`COUNT(${scores.guid})::int`,
			chartCount: sql<number>`COUNT(DISTINCT ${scores.md5})::int`,
			tachiId: sql<
				number | null
			>`(SELECT (${integrations.data}->>'userID')::int FROM ${integrations} WHERE ${integrations}.user_id = ${user.id} AND provider = 'tachi' LIMIT 1)`
		})
		.from(user)
		.leftJoin(scores, eq(scores.userId, user.id))
		// Only return users who have verified their email
		.where(and(eq(user.id, id), eq(user.emailVerified, true)))
		.groupBy(user.id, user.name, user.image, user.createdAt)
		.limit(1);
	if (!rows[0]) return null;
	return rows[0];
}

// ---------------------------------------------------------------------------
// GET /api/users users collection
// ---------------------------------------------------------------------------

export type UsersOrderBy = 'name' | 'score_count' | 'chart_count' | 'joined';

export async function queryUsers(
	limit?: number,
	offset?: number,
	orderBy: UsersOrderBy = 'score_count',
	sort: 'asc' | 'desc' = 'desc'
): Promise<ApiUser[]> {
	const dir = sort === 'asc' ? asc : desc;
	const scoreCountExpr = sql<number>`COUNT(${scores.guid})::int`;
	const chartCountExpr = sql<number>`COUNT(DISTINCT ${scores.md5})::int`;
	const orderExprs =
		orderBy === 'name'
			? [dir(user.name)]
			: orderBy === 'chart_count'
				? [dir(chartCountExpr), asc(user.name)]
				: orderBy === 'joined'
					? [dir(user.createdAt), asc(user.name)]
					: [dir(scoreCountExpr), asc(user.name)];

	return (
		db
			.select({
				id: user.id,
				name: user.name,
				// If no image is set, provide a deterministic DiceBear Adventurer avatar URL (DiceBear 9.x)
				image: sql<string>`COALESCE(${user.image}, ('https://api.dicebear.com/9.x/adventurer/svg?seed=' || ${PUBLIC_AVATAR_SEED_SALT} ||  ${user.id}::text))`,
				createdAt: user.createdAt,
				scoreCount: scoreCountExpr,
				chartCount: chartCountExpr,
				tachiId: sql<
					number | null
				>`(SELECT (data->>'userID')::text FROM ${integrations} WHERE ${integrations}.user_id = ${user.id} AND provider = 'tachi' LIMIT 1)`
			})
			.from(user)
			// Only include users who have verified their email
			.where(eq(user.emailVerified, true))
			.leftJoin(scores, eq(scores.userId, user.id))
			.groupBy(user.id, user.name, user.image, user.createdAt)
			.orderBy(...orderExprs)
			.limit(limit ?? Number.MAX_SAFE_INTEGER)
			.offset(offset ?? 0)
	);
}

export async function queryUsersCount(): Promise<number> {
	const result = await db.select({ count: count() }).from(user).where(eq(user.emailVerified, true));
	return result[0]?.count ?? 0;
}
