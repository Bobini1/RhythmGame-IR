/**
 * GraphQL type definitions for Chart.
 */
import builder from '../builder';
import { db } from '$lib/server/database/client';
import { scores } from '$lib/server/database/schemas/scores';
import { eq, sql } from 'drizzle-orm';
import { RANK_NAMES } from './helpers';

export interface ChartShape {
	id: string;
	sha256: string;
	md5: string;
	title: string;
	artist: string;
	subtitle: string;
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
	histogramData: number[][];
	bpmChanges: { bpm: number; offsetFromStart: number }[];
	createdAt: Date;
}

export const ChartType = builder.objectRef<ChartShape>('Chart').implement({
	fields: (t) => ({
		id: t.exposeString('id'),
		sha256: t.exposeString('sha256'),
		md5: t.exposeString('md5'),
		title: t.exposeString('title'),
		artist: t.exposeString('artist'),
		subtitle: t.exposeString('subtitle'),
		subartist: t.exposeString('subartist'),
		genre: t.exposeString('genre'),
		rank: t.exposeInt('rank'),
		rankName: t.string({ resolve: (c) => RANK_NAMES[c.rank] ?? 'Unknown' }),
		total: t.exposeFloat('total'),
		playLevel: t.exposeInt('playLevel'),
		difficulty: t.exposeInt('difficulty'),
		keymode: t.exposeInt('keymode'),
		normalNoteCount: t.exposeInt('normalNoteCount'),
		scratchCount: t.exposeInt('scratchCount'),
		lnCount: t.exposeInt('lnCount'),
		bssCount: t.exposeInt('bssCount'),
		mineCount: t.exposeInt('mineCount'),
		totalNoteCount: t.int({
			resolve: (c) => c.normalNoteCount + c.scratchCount + c.lnCount + c.bssCount
		}),
		length: t.exposeInt('length'),
		initialBpm: t.exposeFloat('initialBpm'),
		maxBpm: t.exposeFloat('maxBpm'),
		minBpm: t.exposeFloat('minBpm'),
		mainBpm: t.exposeFloat('mainBpm'),
		avgBpm: t.exposeFloat('avgBpm'),
		peakDensity: t.exposeFloat('peakDensity'),
		avgDensity: t.exposeFloat('avgDensity'),
		endDensity: t.exposeFloat('endDensity'),
		createdAt: t.string({ resolve: (c) => c.createdAt.toISOString() }),
		playCount: t.int({
			description: 'Number of unique players who have played this chart',
			resolve: async (parent) => {
				const result = await db
					.select({ count: sql<number>`COUNT(DISTINCT ${scores.userId})` })
					.from(scores)
					.where(eq(scores.chartId, parent.id));
				return Number(result[0]?.count ?? 0);
			}
		})
	})
});
