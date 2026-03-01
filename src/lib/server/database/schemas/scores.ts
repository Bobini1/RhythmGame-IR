import {
	pgTable,
	text,
	integer,
	bigint,
	doublePrecision,
	timestamp,
	jsonb
} from 'drizzle-orm/pg-core';
import { user } from './auth';

// ---------------------------------------------------------------------------
// charts
// ---------------------------------------------------------------------------

export const charts = pgTable('charts', {
	id: text('id').primaryKey(),
	sha256: text('sha256').notNull().unique(),
	md5: text('md5').notNull().unique(),
	title: text('title').notNull(),
	artist: text('artist').notNull().default(''),
	subtitle: text('subtitle').notNull().default(''),
	subartist: text('subartist').notNull().default(''),
	genre: text('genre').notNull().default(''),
	rank: integer('rank').notNull().default(2),
	total: doublePrecision('total').notNull().default(160),
	playLevel: integer('play_level').notNull().default(0),
	difficulty: integer('difficulty').notNull().default(0),
	/** 5 | 7 | 10 | 14 */
	keymode: integer('keymode').notNull(),
	normalNoteCount: integer('normal_note_count').notNull().default(0),
	scratchCount: integer('scratch_count').notNull().default(0),
	lnCount: integer('ln_count').notNull().default(0),
	bssCount: integer('bss_count').notNull().default(0),
	mineCount: integer('mine_count').notNull().default(0),
	/** Duration in nanoseconds */
	length: bigint('length', { mode: 'bigint' }).notNull(),
	initialBpm: doublePrecision('initial_bpm').notNull().default(0),
	maxBpm: doublePrecision('max_bpm').notNull().default(0),
	minBpm: doublePrecision('min_bpm').notNull().default(0),
	mainBpm: doublePrecision('main_bpm').notNull().default(0),
	avgBpm: doublePrecision('avg_bpm').notNull().default(0),
	peakDensity: doublePrecision('peak_density').notNull().default(0),
	avgDensity: doublePrecision('avg_density').notNull().default(0),
	endDensity: doublePrecision('end_density').notNull().default(0),
	/**
	 * Array of arrays of nanosecond offsets, one sub-array per HistogramNoteType:
	 * [Normal, Scratch, LongNote, BssNote, Landmine, Invisible]
	 */
	histogramData: jsonb('histogram_data').$type<number[][]>().notNull().default([]),
	/** Array of { bpm: number; offsetFromStart: number } */
	bpmChanges: jsonb('bpm_changes').$type<{ bpm: number; offsetFromStart: number }[]>().notNull().default([]),
	createdAt: timestamp('created_at').defaultNow().notNull(),
	updatedAt: timestamp('updated_at')
		.defaultNow()
		.$onUpdate(() => new Date())
		.notNull()
});

export type Chart = typeof charts.$inferSelect;
export type ChartInsert = typeof charts.$inferInsert;

// ---------------------------------------------------------------------------
// scores
// ---------------------------------------------------------------------------

export const scores = pgTable(
	'scores',
	{
		/** Game-generated GUID – used as PK to deduplicate submissions */
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		chartId: text('chart_id')
			.notNull()
			.references(() => charts.id, { onDelete: 'cascade' }),
		points: doublePrecision('points').notNull(),
		maxPoints: doublePrecision('max_points').notNull(),
		maxCombo: integer('max_combo').notNull().default(0),
		maxHits: integer('max_hits').notNull(),
		judgementCounts: jsonb('judgement_counts').$type<number[]>().notNull().default([]),
		mineHits: integer('mine_hits').notNull().default(0),
		normalNoteCount: integer('normal_note_count').notNull().default(0),
		scratchCount: integer('scratch_count').notNull().default(0),
		lnCount: integer('ln_count').notNull().default(0),
		bssCount: integer('bss_count').notNull().default(0),
		mineCount: integer('mine_count').notNull().default(0),
		clearType: text('clear_type').notNull(),
		randomSequence: jsonb('random_sequence').$type<number[]>().notNull().default([]),
		/** Stored as string to preserve uint64 precision */
		randomSeed: text('random_seed').notNull().default('0'),
		noteOrderAlgorithm: integer('note_order_algorithm').notNull().default(0),
		noteOrderAlgorithmP2: integer('note_order_algorithm_p2').notNull().default(0),
		dpOptions: integer('dp_options').notNull().default(0),
		/** Stored as string to preserve uint64 precision */
		gameVersion: text('game_version').notNull().default('0'),
		/** Duration in nanoseconds */
		length: bigint('length', { mode: 'bigint' }).notNull(),
		/** Unix timestamp (seconds) when the score was set */
		unixTimestamp: bigint('unix_timestamp', { mode: 'bigint' }).notNull(),
		createdAt: timestamp('created_at').defaultNow().notNull()
	}
);

export type Score = typeof scores.$inferSelect;
export type ScoreInsert = typeof scores.$inferInsert;

// ---------------------------------------------------------------------------
// score_extras  (replay + gauge – kept separate to avoid loading large data
//               when only the score row is needed)
// ---------------------------------------------------------------------------

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

