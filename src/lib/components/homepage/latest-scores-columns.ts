import type { ColumnDef } from '@tanstack/table-core';
import type { LatestScoreRow } from '$lib/server/scores/query';
import { renderComponent } from '$lib/components/ui/data-table';
import { locale } from '$lib/i18n';
import ScoreGradeCell from '../../../routes/[[lang=lang]]/(application)/players/[user_id]/score-grade-cell.svelte';
import ClearTypeCell from '$lib/components/scores/clear-type-cell.svelte';
import LatestScoreTitleCell from './latest-score-title-cell.svelte';
import LatestScorePlayerCell from './latest-score-player-cell.svelte';

export const latestScoresColumns: ColumnDef<LatestScoreRow>[] = [
	{
		id: 'title',
		header: 'homepage.latest_scores.title',
		size: 260,
		accessorFn: (row) =>
			row.chartSubtitle ? `${row.chartTitle} ${row.chartSubtitle}` : row.chartTitle,
		cell: ({ row }) =>
			renderComponent(LatestScoreTitleCell, {
				title: row.original.chartTitle,
				subtitle: row.original.chartSubtitle,
				md5: row.original.chartMd5
			}),
		enableSorting: false
	},
	{
		id: 'player',
		header: 'homepage.latest_scores.player',
		size: 150,
		accessorFn: (row) => row.userName,
		cell: ({ row }) =>
			renderComponent(LatestScorePlayerCell, {
				userId: row.original.userId,
				name: row.original.userName,
				image: row.original.userImage
			}),
		enableSorting: false
	},
	{
		id: 'score_pct',
		header: 'homepage.latest_scores.score',
		size: 90,
		accessorFn: (row) => (row.maxPoints > 0 ? row.points / row.maxPoints : 0),
		cell: ({ row }) => {
			const { points, maxPoints } = row.original;
			if (maxPoints <= 0) return '—';
			return `${((points / maxPoints) * 100).toFixed(2)}%`;
		},
		enableSorting: false
	},
	{
		id: 'grade',
		header: 'homepage.latest_scores.grade',
		size: 70,
		accessorFn: (row) => (row.maxPoints > 0 ? row.points / row.maxPoints : 0),
		cell: ({ row }) =>
			renderComponent(ScoreGradeCell, {
				points: row.original.points,
				maxPoints: row.original.maxPoints
			}),
		enableSorting: false
	},
	{
		id: 'combo',
		header: 'homepage.latest_scores.combo',
		size: 90,
		accessorFn: (row) => row.maxCombo,
		cell: ({ row }) => `${row.original.maxCombo} / ${row.original.maxHits}`,
		enableSorting: false
	},
	{
		id: 'clear_type',
		header: 'homepage.latest_scores.clear_type',
		size: 80,
		accessorKey: 'clearType',
		cell: ({ row }) => renderComponent(ClearTypeCell, { value: row.original.clearType }),
		enableSorting: false
	},
	{
		id: 'date',
		header: 'homepage.latest_scores.date',
		size: 110,
		accessorFn: (row) => row.unixTimestamp,
		cell: ({ row }) =>
			Intl.DateTimeFormat(locale.get()).format(new Date(row.original.unixTimestamp * 1000)),
		enableSorting: false
	}
];


