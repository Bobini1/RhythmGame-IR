import { db } from '$lib/server/database/client';
import { scores } from '$lib/server/database/schemas/scores';
import { charts } from '$lib/server/database/schemas/charts';
import { eq, or } from 'drizzle-orm';
import { packVersion, type ScoreSubmissionPayloadOutput } from './validation';

/**
 * Persists a full score submission (chart upsert + score insert + extras) in a
 * single database transaction.
 *
 * @throws Error with `code === 'DUPLICATE_SCORE'` if the score guid already exists.
 */
export async function submitScore(
	userId: number,
	payload: ScoreSubmissionPayloadOutput
): Promise<{ scoreId: string; md5: string }> {
	const { chartData, scoreData } = payload;

	return await db.transaction(async (tx) => {
		// ------------------------------------------------------------------
		// 1. Upsert chart with proper conflict avoidance
		// ------------------------------------------------------------------
		// First, try to find existing chart by md5 or sha256
		const existingChart = await tx
			.select({
				md5: charts.md5,
				sha256: charts.sha256,
				gameVersion: charts.gameVersion
			})
			.from(charts)
			.where(or(eq(charts.md5, chartData.md5), eq(charts.sha256, chartData.sha256)))
			.limit(1);

		if (existingChart.length > 0) {
			const existing = existingChart[0];

			const shouldUpdate = existing.gameVersion === packVersion(1, 2, 8);

			if (shouldUpdate) {
					await tx
						.update(charts)
						.set({
							md5: chartData.md5,
							sha256: chartData.sha256,
							title: chartData.title,
							artist: chartData.artist,
							subtitle: chartData.subtitle,
							subartist: chartData.subartist,
							genre: chartData.genre,
							rank: chartData.rank,
							total: chartData.total,
							playLevel: chartData.playLevel,
							difficulty: chartData.difficulty,
							keymode: chartData.keymode,
							normalNoteCount: chartData.normalNoteCount,
							scratchCount: chartData.scratchCount,
							lnCount: chartData.lnCount,
							bssCount: chartData.bssCount,
							mineCount: chartData.mineCount,
							length: chartData.length,
							initialBpm: chartData.initialBpm,
							maxBpm: chartData.maxBpm,
							minBpm: chartData.minBpm,
							mainBpm: chartData.mainBpm,
							avgBpm: chartData.avgBpm,
							peakDensity: chartData.peakDensity,
							avgDensity: chartData.avgDensity,
							endDensity: chartData.endDensity,
							histogramData: chartData.histogramData,
							bpmChanges: chartData.bpmChanges,
							gameVersion: chartData.gameVersion
						})
						.where(eq(charts.md5, chartData.md5));
			}
		} else {
				await tx
					.insert(charts)
					.values({
						sha256: chartData.sha256,
						md5: chartData.md5,
						title: chartData.title,
						artist: chartData.artist,
						subtitle: chartData.subtitle,
						subartist: chartData.subartist,
						genre: chartData.genre,
						rank: chartData.rank,
						total: chartData.total,
						playLevel: chartData.playLevel,
						difficulty: chartData.difficulty,
						keymode: chartData.keymode,
						normalNoteCount: chartData.normalNoteCount,
						scratchCount: chartData.scratchCount,
						lnCount: chartData.lnCount,
						bssCount: chartData.bssCount,
						mineCount: chartData.mineCount,
						length: chartData.length,
						initialBpm: chartData.initialBpm,
						maxBpm: chartData.maxBpm,
						minBpm: chartData.minBpm,
						mainBpm: chartData.mainBpm,
						avgBpm: chartData.avgBpm,
						peakDensity: chartData.peakDensity,
						avgDensity: chartData.avgDensity,
						endDensity: chartData.endDensity,
						histogramData: chartData.histogramData,
						bpmChanges: chartData.bpmChanges,
						gameVersion: chartData.gameVersion
					})
					.onConflictDoNothing();
		}

		// ------------------------------------------------------------------
		// 2. Check for duplicate score
		// ------------------------------------------------------------------
		const existing = await tx
			.select({ id: scores.guid })
			.from(scores)
			.where(eq(scores.guid, scoreData.guid))
			.limit(1);

		if (existing.length > 0) {
			const err = new Error(`Score with guid ${scoreData.guid} already exists`) as Error & {
				code: string;
			};
			err.code = 'DUPLICATE_SCORE';
			throw err;
		}

		// ------------------------------------------------------------------
		// 3. Insert score (with replay and gauge data)
		// ------------------------------------------------------------------
		await tx.insert(scores).values({
			guid: scoreData.guid,
			userId,
			md5: chartData.md5,
			points: scoreData.points,
			maxPoints: scoreData.maxPoints,
			maxCombo: scoreData.maxCombo,
			maxHits: scoreData.maxHits,
			judgementCounts: scoreData.judgementCounts,
			mineHits: scoreData.mineHits,
			normalNoteCount: scoreData.normalNoteCount,
			scratchCount: scoreData.scratchCount,
			lnCount: scoreData.lnCount,
			bssCount: scoreData.bssCount,
			mineCount: scoreData.mineCount,
			clearType: scoreData.clearType,
			randomSequence: scoreData.randomSequence,
			randomSeed: scoreData.randomSeed,
			noteOrderAlgorithm: scoreData.noteOrderAlgorithm,
			noteOrderAlgorithmP2: scoreData.noteOrderAlgorithmP2,
			dpOptions: scoreData.dpOptions,
			gameVersion: scoreData.gameVersion,
			length: scoreData.length,
			unixTimestamp: scoreData.unixTimestamp,
			replayData: scoreData.replayData,
			gaugeHistory: scoreData.gaugeHistory
		});

		return { scoreId: scoreData.guid, md5: chartData.md5 };
	});
}
