<script lang="ts">
	import type { Snippet } from 'svelte';

	let { children }: { children?: Snippet } = $props();
</script>
<div class="w-full max-w-5xl mx-auto min-w-0">
{@render children?.()}
</div>