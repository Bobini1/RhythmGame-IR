<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import BasePage from '$lib/components/base-page/base-page.svelte';
	import AppDataTable from '$lib/components/app-data-table/app-data-table.svelte';
	import { Input } from '$lib/components/ui/input';
	import { t } from '$lib/i18n';
	import type { ChartListRow } from '$lib/server/scores/query';
	import type { TableConfiguration } from '$lib/models/table';
	import type { SortingState } from '@tanstack/table-core';
	import { columns } from './configurations';

	let { data } = $props();
	let { chartList, total, page: currentPage, pageSize, sortBy, sortDir, search: initialSearch } = $derived(data);

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

	let searchInput = $state<string>(initialSearch ?? '');
	let debounceTimer: ReturnType<typeof setTimeout>;
	function onSearchInput() {
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			updateUrl({ page: 0, search: searchInput });
		}, 300);
	}
</script>

<BasePage title="charts.list.title" description="charts.list.description">
	<h2 class="text-xl font-semibold">{$t('charts.list.title')}</h2>
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
