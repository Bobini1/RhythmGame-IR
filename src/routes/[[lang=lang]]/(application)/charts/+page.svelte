<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import BasePage from '$lib/components/base-page/base-page.svelte';
	import AppDataTable from '$lib/components/app-data-table/app-data-table.svelte';
	import { Input } from '$lib/components/ui/input';
	import { t } from '$lib/i18n';
	import type { ChartListRow } from '$lib/server/scores/query';
	import type { TableConfiguration } from '$lib/models/table';
	import type { ColumnDef, SortingState } from '@tanstack/table-core';
	import { renderComponent } from '$lib/components/ui/data-table';
	import ChartLinkCell from './chart-link-cell.svelte';
	import PlayLevelCell from './play-level-cell.svelte';

	let chartList = $derived<ChartListRow[]>(page.data.chartList ?? []);
	let total = $derived<number>(page.data.total ?? 0);
	let currentPage = $derived<number>(page.data.page ?? 0);
	let pageSize = $derived<number>(page.data.pageSize ?? 20);
	let sortBy = $derived<string>(page.data.sortBy ?? 'play_count');
	let sortDir = $derived<'asc' | 'desc'>(page.data.sortDir ?? 'desc');

	const columns: ColumnDef<ChartListRow>[] = [
		{
			id: 'level',
			header: 'charts.list.level',
			size: 60,
			accessorFn: (row) => row.playLevel,
			cell: ({ row }) => renderComponent(PlayLevelCell, {
				playLevel: row.original.playLevel,
				difficulty: row.original.difficulty
			}),
			enableSorting: false
		},
		{
			id: 'title',
			header: 'charts.list.title',
			size: 300,
			accessorFn: (row) => row.title,
			cell: ({ row }) => renderComponent(ChartLinkCell, {
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

	const configuration = $derived<TableConfiguration<ChartListRow>>({
		serverSide: { enabled: true, manualPagination: true, totalItems: total },
		pageSize,
		pageIndex: currentPage,
		sortingState: [{ id: sortBy, desc: sortDir === 'desc' }]
	});

	/* eslint-disable svelte/no-navigation-without-resolve */
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
		goto(url.toString(), { invalidateAll: true, keepFocus: true, noScroll: true });
	}
	/* eslint-enable svelte/no-navigation-without-resolve */

	function onSortingChanged(state: SortingState) {
		const first = state[0] ?? null;
		updateUrl({
			page: 0,
			sortBy: first?.id ?? 'play_count',
			sortDir: first ? (first.desc ? 'desc' : 'asc') : 'desc'
		});
	}

	let searchInput = $state<string>(page.data.search ?? '');
	let debounceTimer: ReturnType<typeof setTimeout>;
	function onSearchInput() {
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			updateUrl({ page: 0, search: searchInput });
		}, 300);
	}
</script>

<BasePage title="charts.list.list" description="charts.list.description">
	<AppDataTable
		{columns}
		data={chartList}
		{configuration}
		pageIndexChanged={(i) => updateUrl({ page: i, limit: pageSize })}
		pageSizeChanged={(s) => updateUrl({ page: 0, limit: s })}
		sortingChanged={onSortingChanged}
	>
		{#snippet headerLeft()}
			<Input
				type="search"
				placeholder={$t('charts.list.search_placeholder')}
				bind:value={searchInput}
				oninput={onSearchInput}
				class="max-w-xs"
			/>
		{/snippet}
	</AppDataTable>
</BasePage>
