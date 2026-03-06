<script lang="ts">
	import { langHref } from '$lib/utils';

	let { title, subtitle, md5 }: { title: string; subtitle: string; md5: string } = $props();
	const href = $derived(langHref(`/charts/${md5}`));
</script>

<a {href} class="flex min-w-0 flex-col hover:underline">
	<span class="truncate font-medium" title={title}>{title}</span>
	{#if subtitle}
		<span class="text-muted-foreground truncate text-xs" title={subtitle}>{subtitle}</span>
	{/if}
</a>
