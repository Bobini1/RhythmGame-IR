<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import BasePage from '$lib/components/base-page/base-page.svelte';
	import AppDataTable from '$lib/components/app-data-table/app-data-table.svelte';
	import Avatar from '$lib/components/avatar/avatar.svelte';
	import { t } from '$lib/i18n';
	import type { ChartUserScoreRow } from '$lib/server/scores/query';
	import type { TableConfiguration } from '$lib/models/table';
	import type { SortingState } from '@tanstack/table-core';
	import { columns } from './configurations';

	let { data } = $props();
	let { chart, profile, scores, total, page: currentPage, pageSize, sortBy, sortDir } = $derived(data);

	let configuration = $derived<TableConfiguration<ChartUserScoreRow>>({
		serverSide: { enabled: true, manualPagination: true, totalItems: total },
		pageSize,
		pageIndex: currentPage,
		sortingState: [{ id: sortBy, desc: sortDir === 'desc' }]
	});

	function updateUrl(params: { page?: number; limit?: number; sortBy?: string | null; sortDir?: string }) {
		const url = new URL(page.url);
		if (params.page !== undefined) url.searchParams.set('page', String(params.page));
		if (params.limit !== undefined) url.searchParams.set('limit', String(params.limit));
		if (params.sortBy !== undefined) {
			if (params.sortBy) url.searchParams.set('sortBy', params.sortBy);
			else url.searchParams.delete('sortBy');
		}
		if (params.sortDir !== undefined) url.searchParams.set('sortDir', params.sortDir);
		goto(url.toString(), { invalidateAll: true, keepFocus: true, noScroll: true });
	}

	function onSortingChanged(state: SortingState) {
		const first = state[0] ?? null;
		updateUrl({
			page: 0,
			sortBy: first?.id ?? null,
			sortDir: first ? (first.desc ? 'desc' : 'asc') : 'desc'
		});
	}

	const lang = $derived(page.params.lang ? `/${page.params.lang}` : '');
	const chartTitle = $derived(chart.subtitle ? `${chart.title} ${chart.subtitle}` : chart.title);
	const chartHref = $derived(`${lang}/charts/${chart.md5}`);
	const profileHref = $derived(`${lang}/players/${profile.id}`);
</script>

<BasePage title="charts.user_scores.title" description="charts.user_scores.description">
	<div class="flex flex-col gap-8">

		<!-- Breadcrumb context -->
		<div class="flex flex-col gap-2">
			<div class="text-muted-foreground flex flex-wrap items-center gap-1 text-sm">
				<a href={chartHref} class="hover:underline">{chartTitle}</a>
				<span>/</span>
				<a href={profileHref} class="flex items-center gap-1 hover:underline">
					<Avatar src={profile.image ?? undefined} id={profile.id} size={20} styleClass="h-5 w-5" />
					{profile.name}
				</a>
			</div>
		</div>

		<!-- Scores table -->
		<AppDataTable
			{columns}
			data={scores}
			{configuration}
			pageIndexChanged={(i) => updateUrl({ page: i, limit: pageSize })}
			pageSizeChanged={(s) => updateUrl({ page: 0, limit: s })}
			sortingChanged={onSortingChanged}
		>
			{#snippet headerLeft()}
				<h1 class="text-2xl font-bold">{$t('charts.user_scores.heading', { chart: chartTitle, player: profile.name })}</h1>
			{/snippet}
		</AppDataTable>
	</div>
</BasePage>

