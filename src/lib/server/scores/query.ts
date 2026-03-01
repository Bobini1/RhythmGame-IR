import { db } from '$lib/server/database/client';
import { scores, charts } from '$lib/server/database/schemas/scores';
import { user } from '$lib/server/database/schemas/auth';
import { eq, desc, count } from 'drizzle-orm';

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

export async function getUserProfile(userId: string): Promise<UserProfileData | null> {
	const result = await db
		.select({ id: user.id, name: user.name, image: user.image })
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);
	return result[0] ?? null;
}

export async function getUserScores(
	userId: string,
	limit: number,
	offset: number
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
		.orderBy(desc(scores.createdAt))
		.limit(limit)
		.offset(offset);

	// Convert unixTimestamp (bigint) to number for JSON serialization.
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
