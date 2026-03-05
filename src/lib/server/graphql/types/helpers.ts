/**
 * Shared helpers for GraphQL types.
 */
import { sql, type SQL } from 'drizzle-orm';
import { scores } from '$lib/server/database/schemas/scores';
import { GRADE_THRESHOLDS, GRADE_LABELS } from '$lib/utils/grades';

export const RANK_NAMES: Record<number, string> = {
	0: 'Very Hard',
	1: 'Hard',
	2: 'Normal',
	3: 'Easy'
};

export const CLEAR_TYPE_PRIORITIES: Record<string, number> = {
	NOPLAY: 0,
	FAILED: 1,
	AEASY: 2,
	EASY: 3,
	NORMAL: 4,
	HARD: 5,
	EXHARD: 6,
	FC: 7,
	PERFECT: 8,
	MAX: 9
};

/** SQL CASE expression mapping clearType string to numeric priority. */
export function clearTypeCaseExpr(): SQL<number> {
	const branches = Object.entries(CLEAR_TYPE_PRIORITIES)
		.map(([ct, p]) => sql`WHEN ${scores.clearType} = ${ct} THEN ${p}`)
		.reduce<SQL>((acc, part) => sql`${acc} ${part}`, sql``);
	return sql<number>`CASE ${branches} ELSE 0 END`;
}

/** SQL CASE expression mapping score percentage to grade index (lower = better). */
export function gradeCaseExpr(): SQL<number> {
	const pct = sql`${scores.points} / NULLIF(${scores.maxPoints}, 0)`;
	const branches = GRADE_THRESHOLDS.map(
		(threshold, i) => sql`WHEN ${pct} >= ${threshold} THEN ${i}`
	).reduce<SQL>((acc, part) => sql`${acc} ${part}`, sql``);
	return sql<number>`CASE ${branches} ELSE ${GRADE_LABELS.length - 1} END`;
}

/** SQL expression for poor + bad count (combo breaks). */
export const poorPlusBad = sql<number>`(${scores.judgementCounts}->0)::int + (${scores.judgementCounts}->2)::int`;

/** SQL expression to get the best clear type string from aggregated rows. */
export function bestClearTypeExpr(): SQL<string> {
	const maxPriority = sql`MAX(${clearTypeCaseExpr()})`;
	const branches = Object.entries(CLEAR_TYPE_PRIORITIES)
		.map(([ct, p]) => sql`WHEN ${maxPriority} = ${p} THEN ${ct}`)
		.reduce<SQL>((acc, part) => sql`${acc} ${part}`, sql``);
	return sql<string>`CASE ${branches} ELSE 'NOPLAY' END`;
}

export function computeGrade(points: number, maxPoints: number): string {
	if (maxPoints === 0) return GRADE_LABELS[GRADE_LABELS.length - 1];
	const pct = points / maxPoints;
	for (let i = 0; i < GRADE_THRESHOLDS.length; i++) {
		if (pct >= GRADE_THRESHOLDS[i]) return GRADE_LABELS[i];
	}
	return GRADE_LABELS[GRADE_LABELS.length - 1];
}

