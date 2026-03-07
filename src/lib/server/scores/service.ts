import { db } from '$lib/server/database/client';
import { charts, scores, scoreExtras } from '$lib/server/database/schemas/scores';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import type { ScoreSubmissionPayloadOutput } from './validation';

/**
 * Persists a full score submission (chart upsert + score insert + extras) in a
 * single database transaction.
 *
 * @throws Error with `code === 'DUPLICATE_SCORE'` if the score guid already exists.
 */
export async function submitScore(
	userId: number,
	payload: ScoreSubmissionPayloadOutput
): Promise<{ scoreId: string; chartId: string }> {
	const { chartData, scoreData, replayData, gaugeHistory } = payload;

	return await db.transaction(async (tx) => {
		// ------------------------------------------------------------------
		// 1. Upsert chart by sha256
		// ------------------------------------------------------------------
		const inserted = await (tx
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
				bpmChanges: chartData.bpmChanges
			} as unknown as typeof charts.$inferInsert)
			.onConflictDoNothing()
			.returning({ id: charts.id }));

		const resolvedChartId =
			inserted.length > 0
				? inserted[0].id
				: (
						await tx
							.select({ id: charts.id })
							.from(charts)
							.where(eq(charts.sha256, chartData.sha256))
							.limit(1)
					)[0].id;

		// ------------------------------------------------------------------
		// 2. Check for duplicate score
		// ------------------------------------------------------------------
		const existing = await tx
			.select({ id: scores.id })
			.from(scores)
			.where(eq(scores.id, scoreData.guid))
			.limit(1);

		if (existing.length > 0) {
			const err = new Error(`Score with guid ${scoreData.guid} already exists`) as Error & {
				code: string;
			};
			err.code = 'DUPLICATE_SCORE';
			throw err;
		}

		// ------------------------------------------------------------------
		// 3. Insert score
		// ------------------------------------------------------------------
		await tx.insert(scores).values({
			id: scoreData.guid,
			userId,
			chartId: resolvedChartId,
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
			unixTimestamp: scoreData.unixTimestamp
		});

		// ------------------------------------------------------------------
		// 4. Insert score extras (replay + gauge)
		// ------------------------------------------------------------------
		await tx.insert(scoreExtras).values({
			id: randomUUID(),
			scoreId: scoreData.guid,
			replayData,
			gaugeHistory
		});

		return { scoreId: scoreData.guid, chartId: resolvedChartId };
	});
}

