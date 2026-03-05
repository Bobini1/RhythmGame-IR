/**
 * GraphQL schema — types, queries, and mutations.
 *
 * All query logic is self-contained here using drizzle directly.
 * Types are imported from modular files in ./types/.
 */
import builder from './builder';
import { db } from '$lib/server/database/client';
import { scores, charts } from '$lib/server/database/schemas/scores';
import { user } from '$lib/server/database/schemas/auth';
import { eq, desc, asc, count, and, sql, type SQL } from 'drizzle-orm';
import { submitScore } from '$lib/server/scores/service';
import { scoreSubmissionPayloadSchema } from '$lib/server/scores/validation';
import { getUserScoreGuids, getScoresByIds } from '$lib/server/scores/query';

// Import modular types (side-effect: registers them with the builder)
import { UserType, type UserShape } from './types/user';
import { ChartType, type ChartShape } from './types/chart';
import { ScoreType, type ScoreShape } from './types/score';
import { ScoreSummaryType, type ScoreSummaryShape } from './types/score-summary';
import { PageInfoType } from './types/pagination';
import {
	clearTypeCaseExpr,
	gradeCaseExpr,
	poorPlusBad,
	bestClearTypeExpr
} from './types/helpers';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

const ScoresOrderByEnum = builder.enumType('ScoresOrderBy', {
	values: ['date', 'score_pct', 'grade', 'combo', 'clear_type'] as const
});
const ChartsOrderByEnum = builder.enumType('ChartsOrderBy', {
	values: ['title', 'play_count', 'play_level'] as const
});
const UsersOrderByEnum = builder.enumType('UsersOrderBy', {
	values: ['name', 'score_count'] as const
});
const ScoreSummariesOrderByEnum = builder.enumType('ScoreSummariesOrderBy', {
	values: ['player', 'score_pct', 'grade', 'combo', 'combo_breaks', 'clear_type', 'date', 'play_count'] as const
});
const SortDirEnum = builder.enumType('SortDir', {
	values: ['asc', 'desc'] as const
});

// ---------------------------------------------------------------------------
// Paginated wrapper types
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makePaginatedType<T>(name: string, itemType: any) {
	return builder
		.objectRef<{ items: T[]; totalCount: number; offset: number; limit: number }>(
			`Paginated${name}`
		)
		.implement({
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			fields: (t: any) => ({
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				items: t.field({ type: [itemType], resolve: (p: any) => p.items }),
				pageInfo: t.field({
					type: PageInfoType,
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					resolve: (p: any) => ({
						totalCount: p.totalCount,
						hasNextPage: p.offset + p.limit < p.totalCount,
						hasPreviousPage: p.offset > 0
					})
				})
			})
		});
}

const PaginatedUsers = makePaginatedType<UserShape>('Users', UserType);
const PaginatedCharts = makePaginatedType<ChartShape>('Charts', ChartType);
const PaginatedScores = makePaginatedType<ScoreShape>('Scores', ScoreType);
const PaginatedScoreSummaries = makePaginatedType<ScoreSummaryShape>('ScoreSummaries', ScoreSummaryType);

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

const ScoreFiltersInput = builder.inputType('ScoreFilters', {
	fields: (t) => ({
		chart: t.string(),
		user: t.int(),
		dateGte: t.int(),
		dateLte: t.int(),
		scorePctGte: t.float(),
		scorePctLte: t.float(),
		comboGte: t.int(),
		comboLte: t.int()
	})
});

const ChartFiltersInput = builder.inputType('ChartFilters', {
	fields: (t) => ({
		query: t.string(),
		keymodeGte: t.int(),
		keymodeLte: t.int(),
		playLevelGte: t.int(),
		playLevelLte: t.int()
	})
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

builder.queryFields((t) => ({
	// --- Single resources ---

	user: t.field({
		type: UserType,
		nullable: true,
		args: { id: t.arg.int({ required: true }) },
		resolve: async (_root, args) => {
			const rows = await db.select().from(user).where(eq(user.id, args.id)).limit(1);
			return (rows[0] as UserShape) ?? null;
		}
	}),

	chart: t.field({
		type: ChartType,
		nullable: true,
		args: { md5: t.arg.string({ required: true }) },
		resolve: async (_root, args) => {
			const rows = await db.select().from(charts).where(eq(charts.md5, args.md5)).limit(1);
			if (!rows[0]) return null;
			return { ...rows[0], length: Number(rows[0].length) } as ChartShape;
		}
	}),

	score: t.field({
		type: ScoreType,
		nullable: true,
		args: { guid: t.arg.string({ required: true }) },
		resolve: async (_root, args) => {
			const rows = await db.select().from(scores).where(eq(scores.id, args.guid)).limit(1);
			if (!rows[0]) return null;
			return {
				...rows[0],
				length: Number(rows[0].length),
				unixTimestamp: Number(rows[0].unixTimestamp)
			} as ScoreShape;
		}
	}),

	// --- Collections ---

	users: t.field({
		type: PaginatedUsers,
		args: {
			limit: t.arg.int({ defaultValue: 20 }),
			offset: t.arg.int({ defaultValue: 0 }),
			orderBy: t.arg({ type: UsersOrderByEnum, defaultValue: 'score_count' }),
			sort: t.arg({ type: SortDirEnum, defaultValue: 'desc' })
		},
		resolve: async (_root, args) => {
			const limit = Math.min(100, Math.max(1, args.limit ?? 20));
			const offset = Math.max(0, args.offset ?? 0);
			const dir = args.sort === 'asc' ? asc : desc;
			const scoreCountExpr = sql<number>`COUNT(${scores.id})`;
			const orderExprs =
				args.orderBy === 'name'
					? [dir(user.name)]
					: [dir(scoreCountExpr), asc(user.name)];

			const [rows, totalResult] = await Promise.all([
				db
					.select({
						id: user.id,
						name: user.name,
						email: user.email,
						image: user.image,
						createdAt: user.createdAt
					})
					.from(user)
					.leftJoin(scores, eq(scores.userId, user.id))
					.groupBy(user.id, user.name, user.email, user.image, user.createdAt)
					.orderBy(...orderExprs)
					.limit(limit)
					.offset(offset),
				db.select({ count: count() }).from(user)
			]);

			return {
				items: rows as UserShape[],
				totalCount: totalResult[0]?.count ?? 0,
				offset,
				limit
			};
		}
	}),

	charts: t.field({
		type: PaginatedCharts,
		args: {
			limit: t.arg.int({ defaultValue: 20 }),
			offset: t.arg.int({ defaultValue: 0 }),
			orderBy: t.arg({ type: ChartsOrderByEnum, defaultValue: 'play_count' }),
			sort: t.arg({ type: SortDirEnum, defaultValue: 'desc' }),
			filters: t.arg({ type: ChartFiltersInput })
		},
		resolve: async (_root, args) => {
			const limit = Math.min(100, Math.max(1, args.limit ?? 20));
			const offset = Math.max(0, args.offset ?? 0);
			const dir = args.sort === 'asc' ? asc : desc;
			const playCountExpr = sql<number>`COUNT(DISTINCT ${scores.userId})`;
			const mergedTitle = sql`TRIM(${charts.title} || ' ' || ${charts.subtitle})`;

			const conditions: SQL[] = [];
			const f = args.filters;
			if (f?.query) {
				const tsQuery = f.query
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
			if (f?.keymodeGte != null) conditions.push(sql`${charts.keymode} >= ${f.keymodeGte}`);
			if (f?.keymodeLte != null) conditions.push(sql`${charts.keymode} <= ${f.keymodeLte}`);
			if (f?.playLevelGte != null) conditions.push(sql`${charts.playLevel} >= ${f.playLevelGte}`);
			if (f?.playLevelLte != null) conditions.push(sql`${charts.playLevel} <= ${f.playLevelLte}`);

			const where = conditions.length > 0 ? and(...conditions) : undefined;

			let orderExprs: SQL[];
			switch (args.orderBy) {
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

			const [rows, totalResult] = await Promise.all([
				db
					.select({
						id: charts.id,
						md5: charts.md5,
						sha256: charts.sha256,
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
						histogramData: charts.histogramData,
						bpmChanges: charts.bpmChanges,
						createdAt: charts.createdAt
					})
					.from(charts)
					.leftJoin(scores, eq(scores.chartId, charts.id))
					.where(where)
					.groupBy(charts.id)
					.orderBy(...orderExprs)
					.limit(limit)
					.offset(offset),
				db.select({ count: count() }).from(charts).where(where)
			]);

			return {
				items: rows.map((r) => ({ ...r, length: Number(r.length) })) as ChartShape[],
				totalCount: totalResult[0]?.count ?? 0,
				offset,
				limit
			};
		}
	}),

	scores: t.field({
		type: PaginatedScores,
		args: {
			limit: t.arg.int({ defaultValue: 20 }),
			offset: t.arg.int({ defaultValue: 0 }),
			orderBy: t.arg({ type: ScoresOrderByEnum, defaultValue: 'date' }),
			sort: t.arg({ type: SortDirEnum, defaultValue: 'desc' }),
			filters: t.arg({ type: ScoreFiltersInput })
		},
		resolve: async (_root, args) => {
			const limit = Math.min(100, Math.max(1, args.limit ?? 20));
			const offset = Math.max(0, args.offset ?? 0);
			const dir = args.sort === 'asc' ? asc : desc;
			const pct = sql`${scores.points} / NULLIF(${scores.maxPoints}, 0)`;

			const conditions: SQL[] = [];
			const f = args.filters;
			if (f?.chart) conditions.push(eq(charts.md5, f.chart));
			if (f?.user != null) conditions.push(eq(user.id, f.user));
			if (f?.dateGte != null) conditions.push(sql`${scores.unixTimestamp} >= ${f.dateGte}`);
			if (f?.dateLte != null) conditions.push(sql`${scores.unixTimestamp} <= ${f.dateLte}`);
			if (f?.scorePctGte != null) conditions.push(sql`${pct} >= ${f.scorePctGte}`);
			if (f?.scorePctLte != null) conditions.push(sql`${pct} <= ${f.scorePctLte}`);
			if (f?.comboGte != null) conditions.push(sql`${scores.maxCombo} >= ${f.comboGte}`);
			if (f?.comboLte != null) conditions.push(sql`${scores.maxCombo} <= ${f.comboLte}`);

			const where = conditions.length > 0 ? and(...conditions) : undefined;

			let orderExpr: SQL;
			switch (args.orderBy) {
				case 'score_pct':
					orderExpr = dir(pct);
					break;
				case 'grade':
					orderExpr =
						args.sort === 'asc'
							? sql`${gradeCaseExpr()} ASC, ${pct} ASC`
							: sql`${gradeCaseExpr()} DESC, ${pct} DESC`;
					break;
				case 'combo':
					orderExpr = sql`${dir(scores.maxCombo)}, ${desc(scores.unixTimestamp)}`;
					break;
				case 'clear_type':
					orderExpr = sql`${dir(clearTypeCaseExpr())}, ${desc(scores.unixTimestamp)}`;
					break;
				case 'date':
				default:
					orderExpr = dir(scores.unixTimestamp);
					break;
			}

			const [rows, totalResult] = await Promise.all([
				db
					.select({
						id: scores.id,
						userId: scores.userId,
						chartId: scores.chartId,
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
						unixTimestamp: scores.unixTimestamp
					})
					.from(scores)
					.innerJoin(charts, eq(scores.chartId, charts.id))
					.innerJoin(user, eq(scores.userId, user.id))
					.where(where)
					.orderBy(orderExpr)
					.limit(limit)
					.offset(offset),
				db
					.select({ count: count() })
					.from(scores)
					.innerJoin(charts, eq(scores.chartId, charts.id))
					.innerJoin(user, eq(scores.userId, user.id))
					.where(where)
			]);

			return {
				items: rows.map((r) => ({
					...r,
					length: Number(r.length),
					unixTimestamp: Number(r.unixTimestamp)
				})) as ScoreShape[],
				totalCount: totalResult[0]?.count ?? 0,
				offset,
				limit
			};
		}
	}),

	scoreSummaries: t.field({
		type: PaginatedScoreSummaries,
		args: {
			chartMd5: t.arg.string({ required: true }),
			limit: t.arg.int({ defaultValue: 20 }),
			offset: t.arg.int({ defaultValue: 0 }),
			orderBy: t.arg({ type: ScoreSummariesOrderByEnum, defaultValue: 'score_pct' }),
			sort: t.arg({ type: SortDirEnum, defaultValue: 'desc' }),
			search: t.arg.string({ defaultValue: '' })
		},
		resolve: async (_root, args) => {
			const limit = Math.min(100, Math.max(1, args.limit ?? 20));
			const offset = Math.max(0, args.offset ?? 0);
			const dir = args.sort === 'asc' ? asc : desc;
			const bestPct = sql`MAX(${scores.points} / NULLIF(${scores.maxPoints}, 0))`;

			const conditions: SQL[] = [eq(charts.md5, args.chartMd5)];
			if (args.search) conditions.push(sql`${user.name} ILIKE ${'%' + args.search + '%'}`);
			const where = and(...conditions);

			let orderExpr: SQL;
			switch (args.orderBy) {
				case 'player':
					orderExpr = sql`${dir(user.name)}, MAX(${scores.unixTimestamp}) DESC`;
					break;
				case 'score_pct':
				case 'grade':
					orderExpr = dir(bestPct);
					break;
				case 'combo':
					orderExpr = sql`${dir(sql`MAX(${scores.maxCombo})`)}`;
					break;
				case 'combo_breaks':
					orderExpr = sql`${dir(sql`MIN(${poorPlusBad})`)}`;
					break;
				case 'play_count':
					orderExpr = sql`${dir(sql`COUNT(${scores.id})`)}`;
					break;
				case 'clear_type':
					orderExpr = sql`${dir(sql`MAX(${clearTypeCaseExpr()})`)}`;
					break;
				case 'date':
					orderExpr = sql`${dir(sql`MAX(${scores.unixTimestamp})`)}`;
					break;
				default:
					orderExpr = sql`MAX(${scores.unixTimestamp}) DESC`;
					break;
			}

			const [rows, totalResult] = await Promise.all([
				db
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
					.orderBy(orderExpr)
					.limit(limit)
					.offset(offset),
				db
					.select({ count: sql<number>`COUNT(DISTINCT ${scores.userId})` })
					.from(scores)
					.innerJoin(charts, eq(scores.chartId, charts.id))
					.innerJoin(user, eq(scores.userId, user.id))
					.where(where)
			]);

			return {
				items: rows.map((r) => ({
					...r,
					latestDate: Number(r.latestDate),
					scoreCount: Number(r.scoreCount)
				})) as ScoreSummaryShape[],
				totalCount: Number(totalResult[0]?.count ?? 0),
				offset,
				limit
			};
		}
	})
}));

// ---------------------------------------------------------------------------
// Score download type (for missingScores mutation)
// ---------------------------------------------------------------------------

import type { ScoreDownloadRow } from '$lib/server/scores/query';

const ScoreDownloadScoreDataType = builder
	.objectRef<ScoreDownloadRow['scoreData']>('ScoreDownloadScoreData')
	.implement({
		fields: (t) => ({
			guid: t.exposeString('guid'),
			points: t.exposeFloat('points'),
			maxPoints: t.exposeFloat('maxPoints'),
			maxCombo: t.exposeInt('maxCombo'),
			maxHits: t.exposeInt('maxHits'),
			judgementCounts: t.intList({ resolve: (s) => s.judgementCounts }),
			mineHits: t.exposeInt('mineHits'),
			normalNoteCount: t.exposeInt('normalNoteCount'),
			scratchCount: t.exposeInt('scratchCount'),
			lnCount: t.exposeInt('lnCount'),
			bssCount: t.exposeInt('bssCount'),
			mineCount: t.exposeInt('mineCount'),
			clearType: t.exposeString('clearType'),
			randomSequence: t.intList({ resolve: (s) => s.randomSequence }),
			randomSeed: t.exposeString('randomSeed'),
			noteOrderAlgorithm: t.exposeInt('noteOrderAlgorithm'),
			noteOrderAlgorithmP2: t.exposeInt('noteOrderAlgorithmP2'),
			dpOptions: t.exposeInt('dpOptions'),
			gameVersion: t.exposeString('gameVersion'),
			length: t.int({ resolve: (s) => s.length }),
			unixTimestamp: t.string({ resolve: (s) => String(s.unixTimestamp) }),
			sha256: t.exposeString('sha256'),
			md5: t.exposeString('md5')
		})
	});

const ScoreDownloadType = builder
	.objectRef<ScoreDownloadRow>('ScoreDownload')
	.implement({
		fields: (t) => ({
			scoreData: t.field({
				type: ScoreDownloadScoreDataType,
				resolve: (row) => row.scoreData
			}),
			replayData: t.string({
				description: 'JSON-encoded replay data (array of HitEvent)',
				resolve: (row) => JSON.stringify(row.replayData)
			}),
			gaugeHistory: t.string({
				description: 'JSON-encoded gauge history (array of GaugeHistoryGroup)',
				resolve: (row) => JSON.stringify(row.gaugeHistory)
			})
		})
	});

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

const SubmitScoreResult = builder
	.objectRef<{ scoreId: string; chartId: string }>('SubmitScoreResult')
	.implement({
		fields: (t) => ({
			scoreId: t.exposeString('scoreId'),
			chartId: t.exposeString('chartId')
		})
	});

const BulkSubmitItem = builder
	.objectRef<{
		index: number;
		scoreId: string | null;
		chartId: string | null;
		error: string | null;
	}>('BulkSubmitItem')
	.implement({
		fields: (t) => ({
			index: t.exposeInt('index'),
			scoreId: t.string({ nullable: true, resolve: (r) => r.scoreId }),
			chartId: t.string({ nullable: true, resolve: (r) => r.chartId }),
			error: t.string({ nullable: true, resolve: (r) => r.error })
		})
	});

builder.mutationFields((t) => ({
	submitScore: t.field({
		type: SubmitScoreResult,
		authScopes: { isAuthenticated: true },
		args: {
			input: t.arg({
				type: 'String',
				required: true,
				description: 'JSON-encoded ScoreSubmissionPayload'
			})
		},
		resolve: async (_root, args, ctx) => {
			const body = JSON.parse(args.input);
			const parsed = scoreSubmissionPayloadSchema.safeParse(body);
			if (!parsed.success) {
				throw new Error(`Validation failed: ${JSON.stringify(parsed.error.flatten())}`);
			}
			const { scoreId, chartId } = await submitScore(Number(ctx.user!.id), parsed.data);
			return { scoreId, chartId };
		}
	}),

	submitScoresBulk: t.field({
		type: [BulkSubmitItem],
		authScopes: { isAuthenticated: true },
		args: {
			inputs: t.arg({
				type: ['String'],
				required: true,
				description: 'Array of JSON-encoded ScoreSubmissionPayload'
			})
		},
		resolve: async (_root, args, ctx) => {
			const results: {
				index: number;
				scoreId: string | null;
				chartId: string | null;
				error: string | null;
			}[] = [];
			for (let i = 0; i < args.inputs.length; i++) {
				try {
					const body = JSON.parse(args.inputs[i]);
					const parsed = scoreSubmissionPayloadSchema.safeParse(body);
					if (!parsed.success) {
						results.push({
							index: i,
							scoreId: null,
							chartId: null,
							error: `Validation: ${JSON.stringify(parsed.error.flatten())}`
						});
						continue;
					}
					const { scoreId, chartId } = await submitScore(
						Number(ctx.user!.id),
						parsed.data
					);
					results.push({ index: i, scoreId, chartId, error: null });
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					results.push({ index: i, scoreId: null, chartId: null, error: message });
				}
			}
			return results;
		}
	}),

	/**
	 * Preflight for bulk upload. The client sends GUIDs it wants to upload;
	 * the server returns the subset it does not already have.
	 */
	unknownScores: t.field({
		type: ['String'],
		authScopes: { isAuthenticated: true },
		args: {
			guids: t.arg({
				type: ['String'],
				required: true,
				description: 'GUIDs the client wants to upload'
			})
		},
		resolve: async (_root, args, ctx) => {
			const serverGuids = new Set(await getUserScoreGuids(Number(ctx.user!.id)));
			return args.guids.filter((guid) => !serverGuids.has(guid));
		}
	}),

	/**
	 * The client sends GUIDs it already has locally. The server returns
	 * full payloads for scores the client is missing.
	 */
	missingScores: t.field({
		type: [ScoreDownloadType],
		authScopes: { isAuthenticated: true },
		args: {
			guids: t.arg({
				type: ['String'],
				required: true,
				description: 'GUIDs the client already has locally'
			})
		},
		resolve: async (_root, args, ctx) => {
			const localSet = new Set(args.guids);
			const allGuids = await getUserScoreGuids(Number(ctx.user!.id));
			const missingGuids = allGuids.filter((guid) => !localSet.has(guid));
			return getScoresByIds(Number(ctx.user!.id), missingGuids);
		}
	})
}));

// ---------------------------------------------------------------------------
// Export schema
// ---------------------------------------------------------------------------

export const schema = builder.toSchema();

