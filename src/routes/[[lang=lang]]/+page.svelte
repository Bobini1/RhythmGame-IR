<script lang="ts">
	import { page } from '$app/state';
	import BasePage from '$lib/components/base-page/base-page.svelte';
	import Homepage from '$lib/components/homepage/homepage.svelte';
	import { langGoto } from '$lib/utils';
	import { onMount } from 'svelte';

	let { data } = $props();
	let { latestScores, total, page: currentPage, pageSize } = $derived(data);

	function updateUrl(params: { page?: number; limit?: number }) {
		const url = new URL(page.url);
		if (params.page !== undefined) url.searchParams.set('page', String(params.page));
		if (params.limit !== undefined) url.searchParams.set('limit', String(params.limit));
		langGoto(url.toString(), { invalidateAll: true, keepFocus: true, noScroll: true });
	}

	interface GitHubRelease {
		tag_name: string;
		name: string;
		published_at: string;
		html_url: string;
	}

	async function getLatestRelease(): Promise<GitHubRelease | null> {
		try {
			const response = await fetch('https://api.github.com/repos/Bobini1/RhythmGame/releases/latest', {
				headers: {
					'Accept': 'application/vnd.github+json',
					'User-Agent': 'RhythmGame-Website'
				}
			});

			if (!response.ok) {
				console.error('Failed to fetch GitHub release:', response.status);
				return null;
			}

			const data = await response.json();

			return data;
		} catch (error) {
			console.error('Error fetching GitHub release:', error);
			return null;
		}
	}
	let latestRelease: GitHubRelease | null = $state(null);
	onMount(async () => {
		latestRelease = await getLatestRelease();
	});
</script>

<BasePage title="common.brand.name" description="seo.description">
	<Homepage
		{latestScores}
		{total}
		{currentPage}
		{pageSize}
		{latestRelease}
		pageIndexChanged={(i) => updateUrl({ page: i, limit: pageSize })}
		pageSizeChanged={(s) => updateUrl({ page: 0, limit: s })}
	/>
</BasePage>
