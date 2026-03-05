<script lang="ts">
	import { page } from '$app/state';

	let { title, subtitle, md5 }: { title: string; subtitle: string; md5: string } = $props();

	const lang = $derived(page.params.lang ? `/${page.params.lang}` : '');
	const href = $derived(`${lang}/charts/${md5}`);
</script>

<a {href} class="flex min-w-0 flex-col hover:underline">
	<span class="truncate font-medium" title={title}>{title}</span>
	{#if subtitle}
		<span class="text-muted-foreground truncate text-xs" title={subtitle}>{subtitle}</span>
	{/if}
</a>
