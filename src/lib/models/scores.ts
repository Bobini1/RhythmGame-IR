// ---------------------------------------------------------------------------
// Enums (mirror the C++ enums)
// ---------------------------------------------------------------------------

export enum Keymode {
	K5 = 5,
	K7 = 7,
	K10 = 10,
	K14 = 14
}

export enum HistogramNoteType {
	Normal = 0,
	Scratch = 1,
	LongNote = 2,
	BssNote = 3,
	Landmine = 4,
	Invisible = 5
}

export enum HitAction {
	None = 0,
	Press = 1,
	Release = 2
}

export type ClearType =
	| 'NOPLAY'
	| 'FAILED'
	| 'ASSIST_CLEAR'
	| 'EASY'
	| 'NORMAL'
	| 'HARD'
	| 'EXHARD'
	| 'FC';

// ---------------------------------------------------------------------------
// Sub-types
// ---------------------------------------------------------------------------

export interface BpmChange {
	bpm: number;
	offsetFromStart: number;
}

export interface BmsPoints {
	value: number;
	judgement: number;
	/** Nanoseconds deviation from perfect hit time */
	deviation: number;
}

export interface HitEvent {
	/** Nanoseconds from chart start */
	offsetFromStart: number;
	/** Points awarded for this hit; null if no note was hit */
	points: BmsPoints | null;
	column: number;
	/** Index in BmsNotes::notes; -1 if no note was hit */
	noteIndex: number;
	action: HitAction;
	noteRemoved: boolean;
}

export interface GaugeHistoryEntry {
	/** Nanoseconds from chart start */
	offsetFromStart: number;
	gauge: number;
}

export interface GaugeHistoryGroup {
	name: string;
	maxGauge: number;
	threshold: number;
	courseGauge: boolean;
	gaugeHistory: GaugeHistoryEntry[];
}

// ---------------------------------------------------------------------------
// Submission payloads
// ---------------------------------------------------------------------------

/**
 * Chart metadata sent with a score submission.
 * File-system paths are intentionally excluded.
 */
export interface ChartSubmission {
	title: string;
	artist: string;
	subtitle: string;
	subartist: string;
	genre: string;
	rank: number;
	total: number;
	playLevel: number;
	difficulty: number;
	normalNoteCount: number;
	scratchCount: number;
	lnCount: number;
	bssCount: number;
	mineCount: number;
	/** Duration in nanoseconds */
	length: number;
	/** SHA-256 hex (upper-case, 64 chars) */
	sha256: string;
	/** MD5 hex (upper-case, 32 chars) */
	md5: string;
	isRandom: boolean;
	randomSequence: number[];
	keymode: Keymode;
	initialBpm: number;
	maxBpm: number;
	minBpm: number;
	mainBpm: number;
	avgBpm: number;
	peakDensity: number;
	avgDensity: number;
	endDensity: number;
	/**
	 * Histogram data grouped by HistogramNoteType.
	 * Each sub-array corresponds to one note type.
	 */
	histogramData: number[][];
	bpmChanges: BpmChange[];
}

/**
 * Score data (BmsResult) sent with a score submission.
 */
export interface ScoreSubmission {
	maxPoints: number;
	maxHits: number;
	normalNoteCount: number;
	scratchCount: number;
	lnCount: number;
	bssCount: number;
	mineCount: number;
	points: number;
	maxCombo: number;
	judgementCounts: number[];
	mineHits: number;
	clearType: ClearType;
	randomSequence: number[];
	/** Unix timestamp in seconds */
	unixTimestamp: number;
	/** Duration in nanoseconds */
	length: number;
	/** GUID uniquely identifying this score instance */
	guid: string;
	/** SHA-256 hex (upper-case, 64 chars) – must match chartData.sha256 */
	sha256: string;
	/** MD5 hex (upper-case, 32 chars) – must match chartData.md5 */
	md5: string;
	/** uint64 serialized as string */
	randomSeed: string;
	/** Integer value of NoteOrderAlgorithm enum */
	noteOrderAlgorithm: number;
	/** Integer value of NoteOrderAlgorithm enum (P2 side for DP) */
	noteOrderAlgorithmP2: number;
	/** Integer flags of DpOptions */
	dpOptions: number;
	/** uint64 serialized as string */
	gameVersion: string;
}

/**
 * Full score submission payload sent by the game client.
 */
export interface ScoreSubmissionPayload {
	chartData: ChartSubmission;
	scoreData: ScoreSubmission;
	replayData: HitEvent[];
	gaugeHistory: GaugeHistoryGroup[];
}
