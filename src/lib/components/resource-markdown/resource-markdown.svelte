<script lang="ts">
	import { locale } from '$lib/i18n';
	import { defaultLocale } from '$lib/api/configurations/common';
	import { type Component } from 'svelte';

	let { path }: { path: string } = $props();

	const resources = import.meta.glob<{ default: Component }>(
		'/src/lib/resources/markdown/**/*.md'
	);

	const content = $derived(loadContent($locale, path));

	async function loadContent(
		selectedLocale: string,
		resourcePath: string
	): Promise<Component | undefined> {
		const localizedResource =
			resources[`/src/lib/resources/markdown/${selectedLocale}/${resourcePath}.md`];
		const fallbackResource =
			resources[`/src/lib/resources/markdown/${defaultLocale}/${resourcePath}.md`];
		const loadResource = localizedResource ?? fallbackResource;

		if (!loadResource) {
			return;
		}

		return (await loadResource()).default;
	}
</script>

<article
	class="prose prose-strong:text-foreground prose-a:text-foreground prose-headings:text-foreground text-foreground text-justify"
>
	{#await content then Content}
		{#if Content}
			<Content />
		{/if}
	{/await}
</article>
