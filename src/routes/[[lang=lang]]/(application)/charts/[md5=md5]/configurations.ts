import type { ColumnDef } from '@tanstack/table-core';
import type { ChartScoreRow } from '$lib/server/scores/query';
import { renderComponent } from '$lib/components/ui/data-table';
import { locale } from '$lib/i18n';
import ScoreGradeCell from '$lib/components/table-cells/score-grade-cell.svelte';
import PlayerCell from '$lib/components/table-cells/player-cell.svelte';
import ClearTypeCell from '$lib/components/table-cells/clear-type-cell.svelte';

export const columns: ColumnDef<ChartScoreRow>[] = [
	{
		id: 'player',
		header: 'charts.score_table.player',
		size: 180,
		accessorFn: (row) => row.userName,
		cell: ({ row }) =>
			renderComponent(PlayerCell, {
				userId: row.original.userId,
				name: row.original.userName,
				image: row.original.userImage
			}),
		enableSorting: true,
		sortDescFirst: false
	},
	{
		id: 'score_pct',
		header: 'charts.score_table.score',
		size: 90,
		accessorFn: (row) => (row.maxPoints > 0 ? row.bestPoints / row.maxPoints : 0),
		cell: ({ row }) => {
			const { bestPoints, maxPoints } = row.original;
			if (maxPoints <= 0) return '—';
			return `${((bestPoints / maxPoints) * 100).toFixed(2)}%`;
		},
		enableSorting: true,
		sortDescFirst: true
	},
	{
		id: 'grade',
		header: 'charts.score_table.grade',
		size: 70,
		accessorFn: (row) => (row.maxPoints > 0 ? row.bestPoints / row.maxPoints : 0),
		cell: ({ row }) =>
			renderComponent(ScoreGradeCell, {
				points: row.original.bestPoints,
				maxPoints: row.original.maxPoints
			}),
		enableSorting: true,
		sortDescFirst: true
	},
	{
		id: 'combo',
		header: 'charts.score_table.combo',
		size: 90,
		accessorFn: (row) => row.bestCombo,
		cell: ({ row }) => `${row.original.bestCombo} / ${row.original.maxHits}`,
		enableSorting: true,
		sortDescFirst: true
	},
	{
		id: 'combo_breaks',
		header: 'charts.score_table.combo_breaks',
		size: 90,
		accessorFn: (row) => row.bestComboBreaks,
		cell: ({ row }) => row.original.bestComboBreaks,
		enableSorting: true,
		sortDescFirst: false
	},
	{
		id: 'play_count',
		header: 'charts.score_table.play_count',
		size: 70,
		accessorFn: (row) => row.scoreCount,
		cell: ({ row }) => row.original.scoreCount,
		enableSorting: true,
		sortDescFirst: true
	},
	{
		id: 'clear_type',
		header: 'charts.score_table.clear_type',
		size: 80,
		accessorFn: (row) => row.bestClearType,
		cell: ({ row }) => renderComponent(ClearTypeCell, { value: row.original.bestClearType }),
		enableSorting: true,
		sortDescFirst: true
	},
	{
		id: 'date',
		header: 'charts.score_table.date',
		size: 110,
		accessorFn: (row) => row.latestDate,
		cell: ({ row }) => {
			const ts = row.original.latestDate * 1000;
			return Intl.DateTimeFormat(locale.get()).format(new Date(ts));
		},
		enableSorting: true,
		sortDescFirst: true
	}
];
