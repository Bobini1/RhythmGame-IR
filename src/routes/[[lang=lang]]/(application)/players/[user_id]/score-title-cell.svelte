<script lang="ts">
	let { title, subtitle }: { title: string; subtitle: string } = $props();
</script>

<div class="flex flex-col">
	<span class="font-medium">{title}</span>
	{#if subtitle}
		<span class="text-muted-foreground text-xs">{subtitle}</span>
	{/if}
</div>

