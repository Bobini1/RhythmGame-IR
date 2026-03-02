import type { ColumnDef } from '@tanstack/table-core';
import type { ScoreRow } from '$lib/server/scores/query';
import { renderComponent } from '$lib/components/ui/data-table';
import { locale } from '$lib/i18n';
import ScoreGradeCell from './score-grade-cell.svelte';
import ScoreTitleCell from './score-title-cell.svelte';
import ClearTypeCell from '$lib/components/scores/clear-type-cell.svelte';

export const columns: ColumnDef<ScoreRow>[] = [
	{
		id: 'title',
		header: 'players.profile.score_table.title',
		size: 300,
		accessorFn: (row) =>
			row.chartSubtitle ? `${row.chartTitle} ${row.chartSubtitle}` : row.chartTitle,
		cell: ({ row }) =>
			renderComponent(ScoreTitleCell, {
				title: row.original.chartTitle,
				subtitle: row.original.chartSubtitle,
				md5: row.original.chartMd5
			}),
		enableSorting: true,
		sortDescFirst: false
	},
	{
		id: 'score_pct',
		header: 'players.profile.score_table.score',
		size: 90,
		accessorFn: (row) => (row.maxPoints > 0 ? row.points / row.maxPoints : 0),
		cell: ({ row }) => {
			const { points, maxPoints } = row.original;
			if (maxPoints <= 0) return '—';
			const pct = (points / maxPoints) * 100;
			return `${pct.toFixed(2)}%`;
		},
		enableSorting: true,
		sortDescFirst: true
	},
	{
		id: 'grade',
		header: 'players.profile.score_table.grade',
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
		header: 'players.profile.score_table.combo',
		size: 100,
		accessorFn: (row) => row.maxCombo,
		cell: ({ row }) => `${row.original.maxCombo} / ${row.original.maxHits}`,
		enableSorting: true,
		sortDescFirst: true
	},
	{
		id: 'clear_type',
		header: 'players.profile.score_table.clear_type',
		size: 90,
		accessorKey: 'clearType',
		cell: ({ row }) => renderComponent(ClearTypeCell, { value: row.original.clearType }),
		enableSorting: true,
		sortDescFirst: true
	},
	{
		id: 'date',
		header: 'players.profile.score_table.date',
		size: 110,
		accessorFn: (row) => row.unixTimestamp,
		cell: ({ row }) => {
			const ts = Number(row.original.unixTimestamp) * 1000;
			return Intl.DateTimeFormat(locale.get()).format(new Date(ts));
		},
		enableSorting: true,
		sortDescFirst: true
	}
];
