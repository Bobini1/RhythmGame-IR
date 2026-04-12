import { db } from '$lib/server/database/client';
import { scores } from '$lib/server/database/schemas/scores';
import { charts } from '$lib/server/database/schemas/charts';
import { DrizzleQueryError } from 'drizzle-orm';
import { type ScoreSubmissionPayloadOutput, packVersion } from '../scores/validation';

/**
 * Persists a full score submission (chart upsert + score insert + extras) in a
 * single database transaction.
 *
 * @throws Error with `code === 'DUPLICATE_SCORE'` if the score guid already exists.
 */
export async function submitScore(userId: number, payload: ScoreSubmissionPayloadOutput) {
	const { chartData, scoreData } = payload;

	try {
		await db.transaction(async (tx) => {
			const rankToStore =
				chartData.gameVersion < packVersion(1, 3, 6)
					? (() => {
						  switch (chartData.rank) {
							  case 0:
								  return 25;
							  case 1:
								  return 50;
							  case 2:
								  return 75;
							  case 3:
								  return 100;
								case 4:
									return 75;
							  default:
								  return chartData.rank;
						  }
					  })()
					: chartData.rank;

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
					rank: rankToStore,
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
				keymode: scoreData.keymode,
				gameVersion: scoreData.gameVersion,
				length: scoreData.length,
				unixTimestamp: scoreData.unixTimestamp,
				replayData: scoreData.replayData,
				gaugeHistory: scoreData.gaugeHistory
			});
		});
	} catch (error) {
		if (error instanceof DrizzleQueryError) {
			// Keep a lightweight, typed access to the underlying DB error code
			// without pulling in a pg dependency or using `any`.
			const anyError = error.cause as { code?: string } | undefined;
			if (anyError?.code === '23505') {
				throw new Error('DUPLICATE_SCORE');
			}
		}

		throw error;
	}
}
