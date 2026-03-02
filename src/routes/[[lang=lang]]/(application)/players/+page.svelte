<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import BasePage from '$lib/components/base-page/base-page.svelte';
	import AppDataTable from '$lib/components/app-data-table/app-data-table.svelte';
	import type { UserListRow } from '$lib/server/scores/query';
	import type { TableConfiguration } from '$lib/models/table';
	import type { ColumnDef, SortingState } from '@tanstack/table-core';
	import { renderComponent } from '$lib/components/ui/data-table';
	import PlayerLinkCell from './player-link-cell.svelte';

	let users = $derived<UserListRow[]>(page.data.users ?? []);
	let total = $derived<number>(page.data.total ?? 0);
	let currentPage = $derived<number>(page.data.page ?? 0);
	let pageSize = $derived<number>(page.data.pageSize ?? 20);
	let sortBy = $derived<string>(page.data.sortBy ?? 'score_count');
	let sortDir = $derived<'asc' | 'desc'>(page.data.sortDir ?? 'desc');

	const columns: ColumnDef<UserListRow>[] = [
		{
			id: 'player',
			header: 'players.list.player',
			size: 250,
			accessorFn: (row) => row.name,
			cell: ({ row }) => renderComponent(PlayerLinkCell, {
				userId: row.original.id,
				name: row.original.name,
				image: row.original.image
			}),
			enableSorting: true
		},
		{
			id: 'score_count',
			header: 'players.list.score_count',
			size: 120,
			accessorFn: (row) => row.scoreCount,
			cell: ({ row }) => row.original.scoreCount,
			enableSorting: true
		}
	];

	const configuration = $derived<TableConfiguration<UserListRow>>({
		serverSide: { enabled: true, manualPagination: true, totalItems: total },
		pageSize,
		pageIndex: currentPage,
		sortingState: [{ id: sortBy, desc: sortDir === 'desc' }]
	});

	function updateUrl(params: { page?: number; limit?: number; sortBy?: string; sortDir?: string }) {
		const url = new URL(page.url);
		if (params.page !== undefined) url.searchParams.set('page', String(params.page));
		if (params.limit !== undefined) url.searchParams.set('limit', String(params.limit));
		if (params.sortBy !== undefined) url.searchParams.set('sortBy', params.sortBy);
		if (params.sortDir !== undefined) url.searchParams.set('sortDir', params.sortDir);
		goto(url.toString(), { invalidateAll: true, keepFocus: true, noScroll: true });
	}

	function onSortingChanged(state: SortingState) {
		const first = state[0] ?? null;
		updateUrl({
			page: 0,
			sortBy: first?.id ?? 'score_count',
			sortDir: first ? (first.desc ? 'desc' : 'asc') : 'desc'
		});
	}
</script>

<BasePage title="players.list.title" description="players.list.description">
	<AppDataTable
		{columns}
		data={users}
		{configuration}
		pageIndexChanged={(i) => updateUrl({ page: i, limit: pageSize })}
		pageSizeChanged={(s) => updateUrl({ page: 0, limit: s })}
		sortingChanged={onSortingChanged}
	/>
</BasePage>

