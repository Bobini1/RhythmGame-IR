<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import BasePage from '$lib/components/base-page/base-page.svelte';
	import Homepage from '$lib/components/homepage/homepage.svelte';
	import { langGoto } from '$lib/utils';

	let { data } = $props();
	let { latestScores, total, page: currentPage, pageSize } = $derived(data);

	function updateUrl(params: { page?: number; limit?: number }) {
		const url = new URL(page.url);
		if (params.page !== undefined) url.searchParams.set('page', String(params.page));
		if (params.limit !== undefined) url.searchParams.set('limit', String(params.limit));
		langGoto(url.toString(), { invalidateAll: true, keepFocus: true, noScroll: true });
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
