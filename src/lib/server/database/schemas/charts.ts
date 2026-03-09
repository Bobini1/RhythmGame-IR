import {
	pgTable,
	text,
	integer,
	doublePrecision,
	timestamp,
	jsonb,
	bigint
} from 'drizzle-orm/pg-core';

// autoincrement
export const charts = pgTable('charts', {
	id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
	sha256: text('sha256').notNull().unique(),
	md5: text('md5').notNull().unique(),
	title: text('title').notNull(),
	artist: text('artist').notNull().default(''),
	subtitle: text('subtitle').notNull().default(''),
	subartist: text('subartist').notNull().default(''),
	genre: text('genre').notNull().default(''),
	rank: integer('rank').notNull().default(2),
	total: doublePrecision('total').notNull().default(160),
	playLevel: integer('play_level').notNull(),
	difficulty: integer('difficulty').notNull(),
	/** 5 | 7 | 10 | 14 */
	keymode: integer('keymode').notNull(),
	normalNoteCount: integer('normal_note_count').notNull(),
	scratchCount: integer('scratch_count').notNull(),
	lnCount: integer('ln_count').notNull(),
	bssCount: integer('bss_count').notNull(),
	mineCount: integer('mine_count').notNull(),
	/** Duration in nanoseconds */
	length: bigint('length', { mode: 'number' }).notNull(),
	initialBpm: doublePrecision('initial_bpm').notNull(),
	maxBpm: doublePrecision('max_bpm').notNull(),
	minBpm: doublePrecision('min_bpm').notNull(),
	mainBpm: doublePrecision('main_bpm').notNull(),
	avgBpm: doublePrecision('avg_bpm').notNull(),
	peakDensity: doublePrecision('peak_density').notNull(),
	avgDensity: doublePrecision('avg_density').notNull(),
	endDensity: doublePrecision('end_density').notNull(),
	gameVersion: bigint('game_version', { mode: 'number' }).notNull(),
	/**
	 * Array of arrays of note counts, one sub-array per HistogramNoteType:
	 * [Normal, Scratch, LongNote, BssNote, Landmine, Invisible]
	 */
	histogramData: jsonb('histogram_data').$type<number[][]>().notNull().default([]),
	/** Array of { bpm: number; position: number; time: number } */
	bpmChanges: jsonb('bpm_changes')
		.$type<{ bpm: number; time: number; position: number }[]>()
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
