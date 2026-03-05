/**
 * GraphQL type definitions for ScoreSummary (best-per-user aggregates on a chart).
 */
import builder from '../builder';
import { UserType, type UserShape } from './user';
import { db } from '$lib/server/database/client';
import { user } from '$lib/server/database/schemas/auth';
import { eq } from 'drizzle-orm';
import { computeGrade } from './helpers';

export interface ScoreSummaryShape {
	userId: number;
	userName: string;
	userImage: string | null;
	bestPoints: number;
	maxPoints: number;
	bestCombo: number;
	maxHits: number;
	bestClearType: string;
	bestComboBreaks: number;
	latestDate: number;
	scoreCount: number;
}

export const ScoreSummaryType = builder
	.objectRef<ScoreSummaryShape>('ScoreSummary')
	.implement({
		fields: (t) => ({
			bestPoints: t.exposeFloat('bestPoints'),
			maxPoints: t.exposeFloat('maxPoints'),
			bestCombo: t.exposeInt('bestCombo'),
			maxHits: t.exposeInt('maxHits'),
			bestClearType: t.exposeString('bestClearType'),
			bestComboBreaks: t.exposeInt('bestComboBreaks'),
			latestDate: t.string({ resolve: (s) => String(s.latestDate) }),
			scoreCount: t.exposeInt('scoreCount'),
			scorePct: t.float({
				resolve: (s) => (s.maxPoints === 0 ? 0 : s.bestPoints / s.maxPoints)
			}),
			grade: t.string({
				resolve: (s) => computeGrade(s.bestPoints, s.maxPoints)
			}),
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
			})
		})
	});
