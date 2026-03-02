<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import BasePage from '$lib/components/base-page/base-page.svelte';
	import Homepage from '$lib/components/homepage/homepage.svelte';
	import type { LatestScoreRow } from '$lib/server/scores/query';

	let latestScores = $derived<LatestScoreRow[]>(page.data.latestScores ?? []);
	let total = $derived<number>(page.data.total ?? 0);
	let currentPage = $derived<number>(page.data.page ?? 0);
	let pageSize = $derived<number>(page.data.pageSize ?? 20);

	function updateUrl(params: { page?: number; limit?: number }) {
		const url = new URL(page.url);
		if (params.page !== undefined) url.searchParams.set('page', String(params.page));
		if (params.limit !== undefined) url.searchParams.set('limit', String(params.limit));
		goto(url.toString(), { invalidateAll: true, keepFocus: true, noScroll: true });
	}
</script>

<BasePage title="common.brand.name" description="seo.description">
	<Homepage
		{latestScores}
		{total}
		{currentPage}
		{pageSize}
		pageIndexChanged={(i) => updateUrl({ page: i, limit: pageSize })}
		pageSizeChanged={(s) => updateUrl({ page: 0, limit: s })}
	/>
</BasePage>
