<script lang="ts">
	import { langHref } from '$lib/utils';

	let { md5, title, subtitle }: { md5: string; title: string; subtitle: string } = $props();
	const href = $derived(langHref(`/charts/${md5}`));
</script>

<a {href} class="flex min-w-0 flex-col hover:underline">
	<span class="truncate font-medium" {title}>{title}</span>
	{#if subtitle}
		<span class="text-muted-foreground truncate text-xs" title={subtitle}>{subtitle}</span>
	{/if}
</a>
