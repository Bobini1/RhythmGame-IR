import type { ChartListRow } from '$lib/server/scores/query';
import type { ColumnDef } from '@tanstack/table-core';
import { renderComponent } from '$lib/components/ui/data-table';
import ChartLinkCell from '$lib/components/table-cells/chart-link-cell.svelte';
import PlayLevelCell from '$lib/components/table-cells/play-level-cell.svelte';

export const columns: ColumnDef<ChartListRow>[] = [
	{
		id: 'level',
		header: 'charts.list.level',
		maxSize: 60,
		size: 40,
		accessorFn: (row) => row.playLevel,
		cell: ({ row }) =>
			renderComponent(PlayLevelCell, {
				playLevel: row.original.playLevel,
				difficulty: row.original.difficulty
			}),
		enableSorting: false
	},
	{
		id: 'title',
		header: 'charts.list.title_col',
		maxSize: 300,
		size: 240,
		accessorFn: (row) => row.title,
		cell: ({ row }) =>
			renderComponent(ChartLinkCell, {
				md5: row.original.md5,
				title: row.original.title,
				subtitle: row.original.subtitle
			}),
		enableSorting: true
	},
	{
		id: 'artist',
		header: 'charts.list.artist',
		size: 200,
		accessorFn: (row) => row.artist,
		cell: ({ row }) => {
			const a = row.original.artist;
			const sa = row.original.subartist;
			return sa ? `${a} ${sa}` : a;
		},
		enableSorting: true
	},
	{
		id: 'play_count',
		header: 'charts.list.play_count',
		size: 100,
		accessorFn: (row) => row.playCount,
		cell: ({ row }) => row.original.playCount,
		enableSorting: true
	}
];