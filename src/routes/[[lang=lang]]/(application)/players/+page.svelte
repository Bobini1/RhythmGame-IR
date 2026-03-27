<script lang="ts">
	import { page } from '$app/state';
	import { t } from '$lib/i18n';
	import BasePage from '$lib/components/base-page/base-page.svelte';
	import AppDataTable from '$lib/components/app-data-table/app-data-table.svelte';
	import { Input } from '$lib/components/ui/input';
	import type { UserListRow } from '$lib/server/scores/query';
	import type { TableConfiguration } from '$lib/models/table';
	import type { ColumnDef, SortingState } from '@tanstack/table-core';
	import { renderComponent } from '$lib/components/ui/data-table';
	import PlayerLinkCell from '$lib/components/table-cells/player-link-cell.svelte';
	import { langGoto } from '$lib/utils';
	import { JsonLd } from 'svelte-meta-tags';

	let { data } = $props();
	let { users, total, page: currentPage, pageSize, sortBy, sortDir, search: initialSearch, jsonLd } = $derived(data);

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
			id: 'joined',
			header: 'players.list.joined',
			size: 160,
			accessorFn: (row) => row.createdAt,
			cell: ({ row }) => {
				const d = new Date(row.original.createdAt as unknown as string);
				return d && !isNaN(d.getTime()) ? d.toLocaleDateString() : '';
			},
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

	function updateUrl(params: { page?: number; limit?: number; sortBy?: string; sortDir?: string; search?: string }) {
		const url = new URL(page.url);
		if (params.page !== undefined) url.searchParams.set('page', String(params.page));
		if (params.limit !== undefined) url.searchParams.set('limit', String(params.limit));
		if (params.sortBy !== undefined) url.searchParams.set('sortBy', params.sortBy);
		if (params.sortDir !== undefined) url.searchParams.set('sortDir', params.sortDir);
		if (params.search !== undefined) {
			if (params.search) url.searchParams.set('search', params.search);
			else url.searchParams.delete('search');
		}
		langGoto(url.toString(), { invalidateAll: true, keepFocus: true, noScroll: true });
	}

	function onSortingChanged(state: SortingState) {
		const first = state[0] ?? null;
		updateUrl({
			page: 0,
			sortBy: first?.id ?? 'score_count',
			sortDir: first ? (first.desc ? 'desc' : 'asc') : 'desc'
		});
	}

	// svelte-ignore state_referenced_locally
	let searchInput = $state<string>(initialSearch ?? '');
	let debounceTimer: ReturnType<typeof setTimeout>;

	function onSearchInput() {
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			updateUrl({ page: 0, search: searchInput });
		}, 300);
	}

</script>

<BasePage>
	<h2 class="text-xl font-semibold mb-6">{$t('players.list.title')}</h2>
	<AppDataTable
		{columns}
		data={users}
		{configuration}
		pageIndexChanged={(i) => updateUrl({ page: i, limit: pageSize })}
		pageSizeChanged={(s) => updateUrl({ page: 0, limit: s })}
		sortingChanged={onSortingChanged}
	>
		{#snippet headerLeft()}
			<Input
				type="search"
				placeholder={$t('players.list.search_placeholder')}
				bind:value={searchInput}
				oninput={onSearchInput}
				class="max-w-xs"
			/>
		{/snippet}
	</AppDataTable>
</BasePage>

<JsonLd schema={jsonLd} />