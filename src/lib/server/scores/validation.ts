import { z } from 'zod';

// ---------------------------------------------------------------------------
// Primitive helpers
// ---------------------------------------------------------------------------

const sha256Schema = z
	.string()
	.length(64)
	.regex(/^[0-9A-Fa-f]{64}$/, 'Must be a 64-character hex string');

const md5Schema = z
	.string()
	.length(32)
	.regex(/^[0-9A-Fa-f]{32}$/, 'Must be a 32-character hex string');

// {8bb95133-d26f-4be2-99f2-642fde0fe215}
const guidSchema = z
	.string()
	.refine(
		(val) =>
			/^{([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})}$/.test(
				val
			),
		{ message: 'Invalid GUID format' }
	);

const uint64StringSchema = z
	.string()
	.regex(/^\d+$/, 'Must be a non-negative integer string');

// ---------------------------------------------------------------------------
// BpmChange
// ---------------------------------------------------------------------------

export const bpmChangeSchema = z.object({
	bpm: z.number().positive(),
	position: z.number(),
	time: z.int()
});

// ---------------------------------------------------------------------------
// ChartSubmission
// ---------------------------------------------------------------------------

export const chartSubmissionSchema = z.object({
	title: z.string(),
	artist: z.string().default(''),
	subtitle: z.string().default(''),
	subartist: z.string().default(''),
	genre: z.string().default(''),
	rank: z.int(),
	total: z.number(),
	playLevel: z.int().min(0),
	difficulty: z.int().min(0),
	normalNoteCount: z.int().min(0),
	scratchCount: z.int().min(0),
	lnCount: z.int().min(0),
	bssCount: z.int().min(0),
	mineCount: z.int().min(0),
	length: z.int().min(0),
	sha256: sha256Schema,
	md5: md5Schema,
	isRandom: z.boolean(),
	randomSequence: z.array(z.int()).default([]),
	keymode: z.union([z.literal(5), z.literal(7), z.literal(10), z.literal(14)]),
	initialBpm: z.number(),
	maxBpm: z.number(),
	minBpm: z.number(),
	mainBpm: z.number(),
	avgBpm: z.number(),
	peakDensity: z.number().min(0),
	avgDensity: z.number().min(0),
	endDensity: z.number().min(0),
	histogramData: z.array(z.array(z.int())).default([]),
	bpmChanges: z.array(bpmChangeSchema).default([])
});

// ---------------------------------------------------------------------------
// ScoreSubmission
// ---------------------------------------------------------------------------

export const clearTypeSchema = z.enum([
	'NOPLAY',
	'FAILED',
	'ASSIST_CLEAR',
	'EASY',
	'NORMAL',
	'HARD',
	'EXHARD',
	'FC'
]);

export const scoreSubmissionSchema = z.object({
	maxPoints: z.number(),
	maxHits: z.int().min(0),
	normalNoteCount: z.int().min(0),
	scratchCount: z.int().min(0),
	lnCount: z.int().min(0),
	bssCount: z.int().min(0),
	mineCount: z.int().min(0),
	points: z.number().min(0),
	maxCombo: z.int().min(0),
	judgementCounts: z.array(z.int().min(0)),
	mineHits: z.int().min(0),
	clearType: clearTypeSchema,
	randomSequence: z.array(z.int()).default([]),
	unixTimestamp: z.int(),
	length: z.int().min(0),
	guid: guidSchema,
	sha256: sha256Schema,
	md5: md5Schema,
	randomSeed: uint64StringSchema,
	noteOrderAlgorithm: z.int().min(0),
	noteOrderAlgorithmP2: z.int().min(0),
	dpOptions: z.int().min(0),
	gameVersion: uint64StringSchema
});

// ---------------------------------------------------------------------------
// BmsPoints
// ---------------------------------------------------------------------------

export const bmsPointsSchema = z.object({
	value: z.number(),
	judgement: z.int().min(0),
	/** Nanoseconds deviation from perfect hit time */
	deviation: z.int()
});

// ---------------------------------------------------------------------------
// HitEvent
// ---------------------------------------------------------------------------

export const hitEventSchema = z.object({
	offsetFromStart: z.int(),
	points: bmsPointsSchema.nullable(),
	column: z.int().min(0),
	noteIndex: z.int().min(-1),
	/** 0=None 1=Press 2=Release */
	action: z.union([z.literal(0), z.literal(1), z.literal(2)]),
	noteRemoved: z.boolean()
});

// ---------------------------------------------------------------------------
// GaugeHistoryEntry
// ---------------------------------------------------------------------------

export const gaugeHistoryEntrySchema = z.object({
	offsetFromStart: z.int(),
	gauge: z.number()
});

// ---------------------------------------------------------------------------
// GaugeHistoryGroup
// ---------------------------------------------------------------------------

export const gaugeGroupSchema = z.object({
	name: z.string(),
	maxGauge: z.number(),
	threshold: z.number(),
	courseGauge: z.boolean(),
	gaugeHistory: z.array(gaugeHistoryEntrySchema)
});

// ---------------------------------------------------------------------------
// Full payload
// ---------------------------------------------------------------------------

export const scoreSubmissionPayloadSchema = z
	.object({
		chartData: chartSubmissionSchema,
		scoreData: scoreSubmissionSchema,
		replayData: z.array(hitEventSchema),
		gaugeHistory: z.array(gaugeGroupSchema)
	})
	.refine((data) => data.chartData.sha256 === data.scoreData.sha256, {
		message: 'chartData.sha256 must match scoreData.sha256',
		path: ['scoreData', 'sha256']
	})
	.refine((data) => data.chartData.md5 === data.scoreData.md5, {
		message: 'chartData.md5 must match scoreData.md5',
		path: ['scoreData', 'md5']
	});

export type ScoreSubmissionPayloadOutput = z.output<typeof scoreSubmissionPayloadSchema>;

