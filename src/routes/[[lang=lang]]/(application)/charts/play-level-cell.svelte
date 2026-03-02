<script lang="ts">
	import PlayLevel from '$lib/components/scores/play-level.svelte';
	let { playLevel, difficulty }: { playLevel: number; difficulty: number } = $props();
</script>

<PlayLevel {playLevel} {difficulty} />

