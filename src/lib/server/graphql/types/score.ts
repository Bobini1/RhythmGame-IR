/**
 * GraphQL type definitions for Score.
 */
import builder from '../builder';
import { db } from '$lib/server/database/client';
import { charts } from '$lib/server/database/schemas/scores';
import { user } from '$lib/server/database/schemas/auth';
import { eq } from 'drizzle-orm';
import { UserType, type UserShape } from './user';
import { ChartType, type ChartShape } from './chart';
import { computeGrade } from './helpers';

export interface ScoreShape {
	id: string;
	userId: number;
	chartId: string;
	points: number;
	maxPoints: number;
	maxCombo: number;
	maxHits: number;
	judgementCounts: number[];
	mineHits: number;
	normalNoteCount: number;
	scratchCount: number;
	lnCount: number;
	bssCount: number;
	mineCount: number;
	clearType: string;
	randomSequence: number[];
	randomSeed: string;
	noteOrderAlgorithm: number;
	noteOrderAlgorithmP2: number;
	dpOptions: number;
	gameVersion: string;
	length: number;
	unixTimestamp: number;
}

export const ScoreType = builder.objectRef<ScoreShape>('Score').implement({
	fields: (t) => ({
		id: t.exposeString('id'),
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
		length: t.exposeInt('length'),
		unixTimestamp: t.string({
			description: 'Unix timestamp as a string (too large for JSON int)',
			resolve: (s) => String(s.unixTimestamp)
		}),
		scorePct: t.float({
			description: 'Score percentage (points / maxPoints)',
			resolve: (s) => (s.maxPoints === 0 ? 0 : s.points / s.maxPoints)
		}),
		grade: t.string({
			resolve: (s) => computeGrade(s.points, s.maxPoints)
		}),

		// Relations — resolved lazily
		user: t.field({
			type: UserType,
			resolve: async (parent) => {
				const rows = await db
					.select()
					.from(user)
					.where(eq(user.id, parent.userId))
					.limit(1);
				return rows[0] as UserShape;
			}
		}),
		chart: t.field({
			type: ChartType,
			resolve: async (parent) => {
				const rows = await db
					.select()
					.from(charts)
					.where(eq(charts.id, parent.chartId))
					.limit(1);
				const row = rows[0];
				return { ...row, length: Number(row.length) } as ChartShape;
			}
		})
	})
});
