import { z } from 'zod';

// ---------------------------------------------------------------------------
// Primitive helpers
// ---------------------------------------------------------------------------

export const sha256Schema = z
	.string()
	.length(64)
	.regex(/^[0-9A-Fa-f]{64}$/, 'Must be a 64-character hex string')
	.toUpperCase();

export const md5Schema = z
	.string()
	.length(32)
	.regex(/^[0-9A-Fa-f]{32}$/, 'Must be a 32-character hex string')
	.toUpperCase();

// {8bb95133-d26f-4be2-99f2-642fde0fe215}
export const guidSchema = z
	.string()
	.refine(
		(val) =>
			/^{?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})}?$/.test(val),
		{ message: 'Invalid GUID format' }
	)
	.toLowerCase();

// ---------------------------------------------------------------------------
// BpmChange
// ---------------------------------------------------------------------------

export const bpmChangeSchema = z.object({
	bpm: z.number().nonnegative(),
	position: z.number(),
	beatPosition: z.number(),
	scroll: z.number(),
	time: z.int()
});

export function packVersion(major: number, minor: number, patch: number): number {
	return Number((BigInt(major) << 40n) | (BigInt(minor) << 20n) | BigInt(patch));
}

export function unpackVersion(version: number): { major: number; minor: number; patch: number } {
	const versionBig = BigInt(version);
	return {
		major: Number(versionBig >> 40n) & 0xfffff,
		minor: Number(versionBig >> 20n) & 0xfffff,
		patch: Number(versionBig) & 0xfffff
	};
}

// ---------------------------------------------------------------------------
// ChartSubmission
// ---------------------------------------------------------------------------

export const chartSubmissionSchema = z.object({
	title: z.string(),
	artist: z.string(),
	subtitle: z.string(),
	subartist: z.string(),
	genre: z.string(),
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
	randomSequence: z.preprocess(
		(val) => {
			if (val === undefined) return [];
			if (!Array.isArray(val)) return val;
			return val.map((v) => toBigIntPreprocess(v));
		},
		z.array(z.bigint())
	),
	keymode: z.union([z.literal(5), z.literal(7), z.literal(10), z.literal(14)]),
	initialBpm: z.number(),
	maxBpm: z.number(),
	minBpm: z.number(),
	mainBpm: z.number(),
	avgBpm: z.number(),
	peakDensity: z.number().min(0),
	avgDensity: z.number().min(0),
	endDensity: z.number().min(0),
	histogramData: z.array(z.array(z.int())),
	bpmChanges: z.array(bpmChangeSchema),
	gameVersion: z.int().min(packVersion(1, 2, 8)),
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
	key: z.int().min(-1).optional(),
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
// ScoreSubmission
// ---------------------------------------------------------------------------

export const clearTypeSchema = z.enum([
	'NOPLAY',
	'FAILED',
	'AEASY',
	'EASY',
	'NORMAL',
	'HARD',
	'EXHARD',
	'FC',
	'PERFECT',
	'MAX'
]);

export const scoreSubmissionSchema = z.object({
	guid: guidSchema,
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
	randomSequence: z.preprocess(
		(val) => {
			if (!Array.isArray(val)) return val;
			return val.map((v) => toBigIntPreprocess(v));
		},
		z.array(z.bigint())
	),
	unixTimestamp: z.int(),
	length: z.int().min(0),
	sha256: sha256Schema,
	md5: md5Schema,
	randomSeed: z.preprocess((v) => toBigIntPreprocess(v), z.bigint()),
	noteOrderAlgorithm: z.int().min(0),
	noteOrderAlgorithmP2: z.int().min(0),
	dpOptions: z.int().min(0),
	keymode: z.union([z.literal(5), z.literal(7), z.literal(10), z.literal(14)]),
	gameVersion: z.int(),
	replayData: z.array(hitEventSchema),
	gaugeHistory: z.array(gaugeGroupSchema)
});

// ---------------------------------------------------------------------------
// Full payload
// ---------------------------------------------------------------------------

export const scoreSubmissionPayloadSchema = z
	.object({
		chartData: chartSubmissionSchema,
		scoreData: scoreSubmissionSchema,
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

// Helper preprocessor: coerce numbers, bigint, or numeric strings to BigInt
const toBigIntPreprocess = (val: unknown) => {
	if (typeof val === 'bigint') return val;
	if (typeof val === 'number') {
		if (!Number.isInteger(val)) throw new Error('Expected integer value for bigint');
		return BigInt(val);
	}
	return val; // let inner schema reject it
};
