import { db } from '$lib/server/database/client';
import { scores } from '$lib/server/database/schemas/scores';
import { charts } from '$lib/server/database/schemas/charts';
import { eq, asc, desc, count, and, sql, type SQL } from 'drizzle-orm';

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
	gameVersion: number;
	createdAt: Date;
	updatedAt: Date;
	scoreCount: number;
	playerCount: number;
}

export interface ApiChartHistogram {
	histogramData: number[][];
}

export interface ApiChartBpmChanges {
	bpmChanges: { bpm: number; time: number; position: number }[];
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
			playerCount: sql<number>`COUNT(DISTINCT ${scores.userId})`,
			gameVersion: charts.gameVersion
		})
		.from(charts)
		.leftJoin(scores, eq(scores.chartId, charts.id))
		.where(eq(charts.md5, md5))
		.groupBy(charts.id)
		.limit(1);
	if (!rows[0]) return null;
	return rows[0];
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
// GET /api/charts — charts collection
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

function buildChartsConditions(filters: ChartsCollectionFilters): SQL[] {
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
	return conditions;
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

	const conditions = buildChartsConditions(filters);
	const where = conditions.length > 0 ? and(...conditions) : undefined;

	let orderExprs: SQL[];
	switch (orderBy) {
		case 'title':      orderExprs = [dir(mergedTitle)]; break;
		case 'play_level': orderExprs = [dir(charts.playLevel), asc(mergedTitle)]; break;
		case 'score_count':  orderExprs = [dir(scoreCountExpr), asc(mergedTitle)]; break;
		case 'player_count':
		case 'play_count':
		default:           orderExprs = [dir(playerCountExpr), asc(mergedTitle)]; break;
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
	const conditions = buildChartsConditions(filters);
	const where = conditions.length > 0 ? and(...conditions) : undefined;
	const result = await db.select({ count: count() }).from(charts).where(where);
	return result[0]?.count ?? 0;
}

