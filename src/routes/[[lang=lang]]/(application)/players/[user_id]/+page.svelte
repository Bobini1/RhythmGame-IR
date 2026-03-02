<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import BasePage from '$lib/components/base-page/base-page.svelte';
	import Avatar from '$lib/components/avatar/avatar.svelte';
	import AppDataTable from '$lib/components/app-data-table/app-data-table.svelte';
	import { Input } from '$lib/components/ui/input';
	import { t } from '$lib/i18n';
	import type { ScoreRow } from '$lib/server/scores/query';
	import type { TableConfiguration } from '$lib/models/table';
	import type { SortingState } from '@tanstack/table-core';
	import { columns } from './configurations';

	let profile = $derived(page.data.profile);
	let scores = $derived<ScoreRow[]>(page.data.scores ?? []);
	let total = $derived<number>(page.data.total ?? 0);
	let currentPage = $derived<number>(page.data.page ?? 0);
	let pageSize = $derived<number>(page.data.pageSize ?? 20);
	let sortBy = $derived<string | null>(page.data.sortBy ?? null);
	let sortDir = $derived<'asc' | 'desc'>(page.data.sortDir ?? 'desc');
	let search = $state<string>(page.data.search ?? '');

	let debounceTimer: ReturnType<typeof setTimeout>;

	let configuration = $derived<TableConfiguration<ScoreRow>>({
		serverSide: {
			enabled: true,
			manualPagination: true,
			totalItems: total
		},
		pageSize,
		pageIndex: currentPage,
		sortingState: sortBy ? [{ id: sortBy, desc: sortDir === 'desc' }] : []
	});

	function updateUrl(params: { page?: number; limit?: number; sortBy?: string | null; sortDir?: string; search?: string }) {
		const url = new URL(page.url);
		if (params.page !== undefined) url.searchParams.set('page', String(params.page));
		if (params.limit !== undefined) url.searchParams.set('limit', String(params.limit));
		if (params.sortBy !== undefined) {
			if (params.sortBy) url.searchParams.set('sortBy', params.sortBy);
			else url.searchParams.delete('sortBy');
		}
		if (params.sortDir !== undefined) url.searchParams.set('sortDir', params.sortDir);
		if (params.search !== undefined) {
			if (params.search) url.searchParams.set('search', params.search);
			else url.searchParams.delete('search');
		}
		goto(url.toString(), { invalidateAll: true, keepFocus: true, noScroll: true });
	}

	function onSearchInput() {
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			updateUrl({ page: 0, search });
		}, 300);
	}

	function onPageIndexChanged(newIndex: number) {
		updateUrl({ page: newIndex, limit: pageSize });
	}

	function onPageSizeChanged(newPageSize: number) {
		updateUrl({ page: 0, limit: newPageSize });
	}

	function onSortingChanged(state: SortingState) {
		const first = state[0] ?? null;
		updateUrl({
			page: 0,
			sortBy: first?.id ?? null,
			sortDir: first ? (first.desc ? 'desc' : 'asc') : 'desc'
		});
	}
</script>

<BasePage title="players.profile.title" description="players.profile.description">
	<div class="flex flex-col gap-8">
		<!-- Profile header -->
		<div class="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
			<Avatar src={profile.image ?? undefined} id={profile.id} size={96} styleClass="h-24 w-24 shrink-0" />
			<div class="flex flex-col justify-center">
				<h1 class="text-3xl font-bold">{profile.name}</h1>
			</div>
		</div>

		<!-- Scores table -->
		<section class="flex flex-col gap-4">
			<h2 class="text-xl font-semibold">{$t('players.profile.scores_title')}</h2>
			<AppDataTable
				{columns}
				data={scores}
				{configuration}
				pageIndexChanged={onPageIndexChanged}
				pageSizeChanged={onPageSizeChanged}
				sortingChanged={onSortingChanged}
			>
				{#snippet headerLeft()}
					<Input
						type="search"
						placeholder={$t('players.profile.search_placeholder')}
						bind:value={search}
						oninput={onSearchInput}
						class="w-48"
					/>
				{/snippet}
			</AppDataTable>
		</section>
	</div>
</BasePage>

