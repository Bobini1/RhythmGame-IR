import { pgTable, text, integer, doublePrecision, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { randomUUID } from 'crypto';

export const charts = pgTable('charts', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => randomUUID()),
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
	length: integer('length').notNull(),
	initialBpm: doublePrecision('initial_bpm').notNull().default(0),
	maxBpm: doublePrecision('max_bpm').notNull().default(0),
	minBpm: doublePrecision('min_bpm').notNull().default(0),
	mainBpm: doublePrecision('main_bpm').notNull().default(0),
	avgBpm: doublePrecision('avg_bpm').notNull().default(0),
	peakDensity: doublePrecision('peak_density').notNull().default(0),
	avgDensity: doublePrecision('avg_density').notNull().default(0),
	endDensity: doublePrecision('end_density').notNull().default(0),
	/**
	 * Array of arrays of note counts, one sub-array per HistogramNoteType:
	 * [Normal, Scratch, LongNote, BssNote, Landmine, Invisible]
	 */
	histogramData: jsonb('histogram_data').$type<number[][]>().notNull().default([]),
	/** Array of { bpm: number; offsetFromStart: number } */
	bpmChanges: jsonb('bpm_changes')
		.$type<{ bpm: number; offsetFromStart: number }[]>()
		.notNull()
		.default([]),
	createdAt: timestamp('created_at').defaultNow().notNull(),
	updatedAt: timestamp('updated_at')
		.defaultNow()
		.$onUpdate(() => new Date())
		.notNull()
});

export type Chart = typeof charts.$inferSelect;
export type ChartInsert = typeof charts.$inferInsert;
