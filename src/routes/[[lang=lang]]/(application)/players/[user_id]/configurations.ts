import type { ColumnDef } from '@tanstack/table-core';
import type { ScoreRow } from '$lib/server/scores/query';
import { renderComponent } from '$lib/components/ui/data-table';
import { locale } from '$lib/i18n';
import ScoreGradeCell from './score-grade-cell.svelte';
import ScoreTitleCell from './score-title-cell.svelte';

export const columns: ColumnDef<ScoreRow>[] = [
	{
		id: 'title',
		header: 'players.profile.score_table.title',
		cell: ({ row }) =>
			renderComponent(ScoreTitleCell, {
				title: row.original.chartTitle,
				subtitle: row.original.chartSubtitle
			}),
		enableSorting: false
	},
	{
		id: 'score_pct',
		header: 'players.profile.score_table.score',
		cell: ({ row }) => {
			const { points, maxPoints } = row.original;
			if (maxPoints <= 0) return '—';
			const pct = (points / maxPoints) * 100;
			return `${pct.toFixed(2)}%`;
		},
		enableSorting: false
	},
	{
		id: 'grade',
		header: 'players.profile.score_table.grade',
		cell: ({ row }) =>
			renderComponent(ScoreGradeCell, {
				points: row.original.points,
				maxPoints: row.original.maxPoints
			}),
		enableSorting: false
	},
	{
		id: 'combo',
		header: 'players.profile.score_table.combo',
		cell: ({ row }) => `${row.original.maxCombo} / ${row.original.maxHits}`,
		enableSorting: false
	},
	{
		id: 'clear_type',
		header: 'players.profile.score_table.clear_type',
		accessorKey: 'clearType',
		enableSorting: false
	},
	{
		id: 'date',
		header: 'players.profile.score_table.date',
		cell: ({ row }) => {
			const ts = Number(row.original.unixTimestamp) * 1000;
			return Intl.DateTimeFormat(locale.get()).format(new Date(ts));
		},
		enableSorting: false
	}
];

export const tableConfiguration = {
	serverSide: {
		enabled: true,
		manualPagination: true
	},
	pageSize: 20
};


