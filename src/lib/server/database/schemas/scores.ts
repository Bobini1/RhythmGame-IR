import {
	pgTable,
	text,
	integer,
	doublePrecision,
	timestamp,
	jsonb
} from 'drizzle-orm/pg-core';
import { user } from './auth';
import { charts } from '$lib/server/database/schemas/charts';

export const scores = pgTable('scores', {
	/** Game-generated GUID – used as PK to deduplicate submissions */
	id: text('id').primaryKey(),
	userId: integer('user_id')
		.notNull()
		.references(() => user.id, { onDelete: 'cascade' }),
	chartId: text('chart_id')
		.notNull()
		.references(() => charts.id, { onDelete: 'cascade' }),
	points: doublePrecision('points').notNull(),
	maxPoints: doublePrecision('max_points').notNull(),
	maxCombo: integer('max_combo').notNull(),
	maxHits: integer('max_hits').notNull(),
	judgementCounts: jsonb('judgement_counts').$type<number[]>().notNull().default([]),
	mineHits: integer('mine_hits').notNull(),
	normalNoteCount: integer('normal_note_count').notNull(),
	scratchCount: integer('scratch_count').notNull(),
	lnCount: integer('ln_count').notNull(),
	bssCount: integer('bss_count').notNull(),
	mineCount: integer('mine_count').notNull(),
	clearType: text('clear_type').notNull(),
	randomSequence: jsonb('random_sequence').$type<number[]>().notNull().default([]),
	/** Stored as string to preserve uint64 precision */
	randomSeed: text('random_seed').notNull().default('0'),
	noteOrderAlgorithm: integer('note_order_algorithm').notNull(),
	noteOrderAlgorithmP2: integer('note_order_algorithm_p2').notNull(),
	dpOptions: integer('dp_options').notNull(),
	gameVersion: integer('game_version').notNull(),
	/** Duration in nanoseconds */
	length: integer('length').notNull(),
	/** Unix timestamp (seconds) when the score was set */
	unixTimestamp: integer('unix_timestamp').notNull(),
	createdAt: timestamp('created_at').defaultNow().notNull()
});

export type Score = typeof scores.$inferSelect;
export type ScoreInsert = typeof scores.$inferInsert;

export const scoreExtras = pgTable('score_extras', {
	id: text('id').primaryKey(),
	scoreId: text('score_id')
		.notNull()
		.unique()
		.references(() => scores.id, { onDelete: 'cascade' }),
	/**
	 * Array of HitEvent objects:
	 * { offsetFromStart, points, column, noteIndex, action, noteRemoved }
	 */
	replayData: jsonb('replay_data')
		.$type<{
			offsetFromStart: number;
			points: { value: number; judgement: number; deviation: number } | null;
			column: number;
			noteIndex: number;
			action: number; // 0=None 1=Press 2=Release
			noteRemoved: boolean;
		}[]>()
		.notNull()
		.default([]),
	/**
	 * Array of GaugeHistoryGroup objects:
	 * { name, maxGauge, threshold, courseGauge, gaugeHistory: [{ offsetFromStart, gauge }] }
	 */
	gaugeHistory: jsonb('gauge_history')
		.$type<{
			name: string;
			maxGauge: number;
			threshold: number;
			courseGauge: boolean;
			gaugeHistory: { offsetFromStart: number; gauge: number }[];
		}[]>()
		.notNull()
		.default([])
});

export type ScoreExtras = typeof scoreExtras.$inferSelect;
export type ScoreExtrasInsert = typeof scoreExtras.$inferInsert;

