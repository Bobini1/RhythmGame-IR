<script lang="ts">
	let { title, subtitle }: { title: string; subtitle: string } = $props();
</script>

<div class="flex min-w-0 flex-col">
	<span class="truncate font-medium" title={title}>{title}</span>
	{#if subtitle}
		<span class="text-muted-foreground truncate text-xs" title={subtitle}>{subtitle}</span>
	{/if}
</div>

