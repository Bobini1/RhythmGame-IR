import { db } from '$lib/server/database/client';
import { scores } from '$lib/server/database/schemas/scores';
import { charts } from '$lib/server/database/schemas/charts';
import { DrizzleQueryError } from 'drizzle-orm';
import { type ScoreSubmissionPayloadOutput } from '../scores/validation';

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
			const anyError = error.cause as any; // I don't want to deal with a direct dependency on pg
			if (anyError.code === "23505") {
				throw new Error('DUPLICATE_SCORE');
			}
		}

		throw error;
	}
}
