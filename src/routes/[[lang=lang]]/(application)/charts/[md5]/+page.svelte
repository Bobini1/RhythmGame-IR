<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import BasePage from '$lib/components/base-page/base-page.svelte';
	import AppDataTable from '$lib/components/app-data-table/app-data-table.svelte';
	import { Input } from '$lib/components/ui/input';
	import { t } from '$lib/i18n';
	import PlayLevelCell from '$lib/components/table-cells/play-level-cell.svelte';
	import type { ChartScoreRow, ChartData } from '$lib/server/scores/query';
	import type { TableConfiguration } from '$lib/models/table';
	import type { SortingState } from '@tanstack/table-core';
	import { columns } from './configurations';

	let chart = $derived<ChartData>(page.data.chart);
	let scores = $derived<ChartScoreRow[]>(page.data.scores ?? []);
	let total = $derived<number>(page.data.total ?? 0);
	let currentPage = $derived<number>(page.data.page ?? 0);
	let pageSize = $derived<number>(page.data.pageSize ?? 20);
	let sortBy = $derived<string>(page.data.sortBy ?? 'score_pct');
	let sortDir = $derived<'asc' | 'desc'>(page.data.sortDir ?? 'desc');
	let search = $state<string>(page.data.search ?? '');

	let debounceTimer: ReturnType<typeof setTimeout>;

	let configuration = $derived<TableConfiguration<ChartScoreRow>>({
		serverSide: { enabled: true, manualPagination: true, totalItems: total },
		pageSize,
		pageIndex: currentPage,
		sortingState: [{ id: sortBy, desc: sortDir === 'desc' }]
	});

	function updateUrl(params: {
		page?: number;
		limit?: number;
		sortBy?: string | null;
		sortDir?: string;
		search?: string;
	}) {
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

	function onSortingChanged(state: SortingState) {
		const first = state[0] ?? null;
		updateUrl({
			page: 0,
			sortBy: first?.id ?? null,
			sortDir: first ? (first.desc ? 'desc' : 'asc') : 'desc'
		});
	}

	const RANK_NAMES: Record<number, string> = { 0: 'Very Hard', 1: 'Hard', 2: 'Normal', 3: 'Easy' };


	const totalNotes = $derived(
		chart.normalNoteCount + chart.scratchCount + chart.lnCount + chart.bssCount
	);
</script>

<BasePage title="charts.page.title" description="charts.page.description">
	<div class="flex w-full max-w-300 flex-col gap-8">

		<!-- Chart info -->
		<div class="flex flex-col gap-4">
			<div>
				<h1 class="text-3xl font-bold">{chart.title}</h1>
				{#if chart.subtitle}
					<p class="text-muted-foreground text-lg">{chart.subtitle}</p>
				{/if}
			</div>

			<dl class="grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-3 lg:grid-cols-4">
				{#if chart.artist}
					<div class="flex flex-col">
						<dt class="text-muted-foreground">{$t('charts.info.artist')}</dt>
						<dd class="font-medium">{chart.artist}
							{#if chart.subartist}
							<span class="text-muted-foreground font-normal">
							{chart.subartist}
							</span>
							{/if}
						</dd>
					</div>
				{/if}
				{#if chart.genre}
					<div class="flex flex-col">
						<dt class="text-muted-foreground">{$t('charts.info.genre')}</dt>
						<dd class="font-medium">{chart.genre}</dd>
					</div>
				{/if}
				<div class="flex flex-col">
					<dt class="text-muted-foreground">{$t('charts.info.play_level')}</dt>
					<dd><PlayLevelCell playLevel={chart.playLevel} difficulty={chart.difficulty} /></dd>
				</div>
				<div class="flex flex-col">
					<dt class="text-muted-foreground">{$t('charts.info.keymode')}</dt>
					<dd class="font-medium">{chart.keymode}K</dd>
				</div>
				<div class="flex flex-col">
					<dt class="text-muted-foreground">{$t('charts.info.rank')}</dt>
					<dd class="font-medium">{RANK_NAMES[chart.rank] ?? chart.rank}</dd>
				</div>
				<div class="flex flex-col">
					<dt class="text-muted-foreground">{$t('charts.info.bpm')}</dt>
					<dd class="font-medium">
						{#if chart.minBpm === chart.maxBpm}
							{chart.mainBpm}
						{:else}
							{chart.minBpm}~{chart.maxBpm}
						{/if}
					</dd>
				</div>
				<div class="flex flex-col">
					<dt class="text-muted-foreground">{$t('charts.info.notes')}</dt>
					<dd class="font-medium">
						{totalNotes}
						<span class="text-muted-foreground font-normal">
							({$t('charts.info.normal')}: {chart.normalNoteCount},
							{$t('charts.info.scratch')}: {chart.scratchCount}{#if chart.lnCount > 0},
							{$t('charts.info.ln')}: {chart.lnCount}{/if}{#if chart.bssCount > 0},
							{$t('charts.info.bss')}: {chart.bssCount}{/if})
						</span>
					</dd>
				</div>
				{#if chart.mineCount > 0}
					<div class="flex flex-col">
						<dt class="text-muted-foreground">{$t('charts.info.mine_count')}</dt>
						<dd class="font-medium">{chart.mineCount}</dd>
					</div>
				{/if}
				<div class="flex flex-col">
					<dt class="text-muted-foreground">{$t('charts.info.sha256')}</dt>
					<dd class="font-mono text-xs break-all">{chart.sha256}</dd>
				</div>
				<div class="flex flex-col">
					<dt class="text-muted-foreground">{$t('charts.info.md5')}</dt>
					<dd class="font-mono text-xs break-all">{chart.md5}</dd>
				</div>
			</dl>
		</div>

		<!-- Scores table -->
		<section class="flex flex-col gap-4">
			<h2 class="text-xl font-semibold">{$t('charts.page.scores_title')}</h2>
			<AppDataTable
				{columns}
				data={scores}
				{configuration}
				pageIndexChanged={(i) => updateUrl({ page: i, limit: pageSize })}
				pageSizeChanged={(s) => updateUrl({ page: 0, limit: s })}
				sortingChanged={onSortingChanged}
			>
				{#snippet headerLeft()}
					<Input
						type="search"
						placeholder={$t('charts.page.search_placeholder')}
						bind:value={search}
						oninput={onSearchInput}
						class="w-48"
					/>
				{/snippet}
			</AppDataTable>
		</section>
	</div>
</BasePage>

