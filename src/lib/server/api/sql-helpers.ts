/**
 * Shared SQL expression helpers for the API layer.
 * Centralised here so scores/query.ts and api/queries.ts don't duplicate them.
 */
import { sql, type SQL } from 'drizzle-orm';
import { scores } from '$lib/server/database/schemas/scores';
import { GRADE_THRESHOLDS, GRADE_LABELS } from '$lib/utils/grades';

export const CLEAR_TYPE_PRIORITIES: Record<string, number> = {
	NOPLAY: 0,
	FAILED: 1,
	ASSIST_CLEAR: 2,
	EASY: 3,
	NORMAL: 4,
	HARD: 5,
	EXHARD: 6,
	FC: 7
};

export function clearTypeCaseExpr() {
	const branches = Object.entries(CLEAR_TYPE_PRIORITIES)
		.map(([ct, p]) => sql`WHEN ${scores.clearType} = ${ct} THEN ${p}`)
		.reduce<SQL>((acc, part) => sql`${acc} ${part}`, sql``);
	return sql<number>`CASE ${branches} ELSE 0 END`;
}

export function gradeCaseExpr() {
	const pct = sql`${scores.points} / NULLIF(${scores.maxPoints}, 0)`;
	const branches = GRADE_THRESHOLDS.map(
		(threshold, i) => sql`WHEN ${pct} >= ${threshold} THEN ${i}`
	).reduce<SQL>((acc, part) => sql`${acc} ${part}`, sql``);
	return sql<number>`CASE ${branches} ELSE ${GRADE_LABELS.length - 1} END`;
}

export const poorPlusBad = sql<number>`(${scores.judgementCounts}->0)::int + (${scores.judgementCounts}->2)::int`;

export function bestClearTypeExpr() {
	const maxPriority = sql`MAX(${clearTypeCaseExpr()})`;
	const branches = Object.entries(CLEAR_TYPE_PRIORITIES)
		.map(([ct, p]) => sql`WHEN ${maxPriority} = ${p} THEN ${ct}`)
		.reduce<SQL>((acc, part) => sql`${acc} ${part}`, sql``);
	return sql<string>`CASE ${branches} ELSE 'NOPLAY' END`;
}

