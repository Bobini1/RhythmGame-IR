import type { ColumnDef } from '@tanstack/table-core';
import type { ChartUserScoreRow } from '$lib/server/scores/query';
import { renderComponent } from '$lib/components/ui/data-table';
import { locale } from '$lib/i18n';
import ScoreGradeCell from '$lib/components/table-cells/score-grade-cell.svelte';
import ClearTypeCell from '$lib/components/table-cells/clear-type-cell.svelte';

const J = {
	Poor: 0, EmptyPoor: 1, Bad: 2, Good: 3, Great: 4,
	Perfect: 5, MineHit: 6
} as const;

function j(row: ChartUserScoreRow, index: number): number {
	return row.judgementCounts?.[index] ?? 0;
}

export const columns: ColumnDef<ChartUserScoreRow>[] = [
	{
		id: 'score_pct',
		header: 'charts.score_table.score',
		size: 70,
		accessorFn: (row) => (row.maxPoints > 0 ? row.points / row.maxPoints : 0),
		cell: ({ row }) => {
			const { points, maxPoints } = row.original;
			if (maxPoints <= 0) return '—';
			return `${((points / maxPoints) * 100).toFixed(2)}%`;
		},
		enableSorting: true,
		sortDescFirst: true
	},
	{
		id: 'grade',
		header: 'charts.score_table.grade',
		size: 70,
		accessorFn: (row) => (row.maxPoints > 0 ? row.points / row.maxPoints : 0),
		cell: ({ row }) =>
			renderComponent(ScoreGradeCell, {
				points: row.original.points,
				maxPoints: row.original.maxPoints
			}),
		enableSorting: true,
		sortDescFirst: true
	},
	{
		id: 'combo',
		header: 'charts.score_table.combo',
		size: 90,
		accessorFn: (row) => row.maxCombo,
		cell: ({ row }) => `${row.original.maxCombo} / ${row.original.maxHits}`,
		enableSorting: true,
		sortDescFirst: true
	},
	{
		id: 'clear_type',
		header: 'charts.score_table.clear_type',
		size: 80,
		accessorKey: 'clearType',
		cell: ({ row }) => renderComponent(ClearTypeCell, { value: row.original.clearType }),
		enableSorting: true,
		sortDescFirst: true
	},
	{
		id: 'poor',
		header: 'charts.score_table.poor',
		size: 60,
		accessorFn: (row) => j(row, J.Poor),
		cell: ({ row }) => j(row.original, J.Poor),
		enableSorting: true,
		sortDescFirst: false
	},
	{
		id: 'empty_poor',
		header: 'charts.score_table.empty_poor',
		size: 75,
		accessorFn: (row) => j(row, J.EmptyPoor),
		cell: ({ row }) => j(row.original, J.EmptyPoor),
		enableSorting: true,
		sortDescFirst: false
	},
	{
		id: 'bad',
		header: 'charts.score_table.bad',
		size: 55,
		accessorFn: (row) => j(row, J.Bad),
		cell: ({ row }) => j(row.original, J.Bad),
		enableSorting: true,
		sortDescFirst: false
	},
	{
		id: 'good',
		header: 'charts.score_table.good',
		size: 60,
		accessorFn: (row) => j(row, J.Good),
		cell: ({ row }) => j(row.original, J.Good),
		enableSorting: true,
		sortDescFirst: true
	},
	{
		id: 'great',
		header: 'charts.score_table.great',
		size: 60,
		accessorFn: (row) => j(row, J.Great),
		cell: ({ row }) => j(row.original, J.Great),
		enableSorting: true,
		sortDescFirst: true
	},
	{
		id: 'perfect',
		header: 'charts.score_table.perfect',
		size: 65,
		accessorFn: (row) => j(row, J.Perfect),
		cell: ({ row }) => j(row.original, J.Perfect),
		enableSorting: true,
		sortDescFirst: true
	},
	{
		id: 'mine_hit',
		header: 'charts.score_table.mine_hit',
		size: 70,
		accessorFn: (row) => j(row, J.MineHit),
		cell: ({ row }) => j(row.original, J.MineHit),
		enableSorting: true,
		sortDescFirst: false
	},
	{
		id: 'date',
		header: 'charts.score_table.date',
		size: 110,
		accessorFn: (row) => row.unixTimestamp,
		cell: ({ row }) => {
			const ts = row.original.unixTimestamp * 1000;
			return Intl.DateTimeFormat(locale.get()).format(new Date(ts));
		},
		enableSorting: true,
		sortDescFirst: true
	}
];
