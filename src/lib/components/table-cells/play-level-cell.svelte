<script lang="ts">
	const DIFFICULTY_COLORS: Record<number, string> = {
		1: 'text-[#89CC89]',
		2: 'text-[#89CCCC]',
		3: 'text-[#CCA46C]',
		4: 'text-[#CC6868]',
		5: 'text-[#CC6699]'
	};

	let { playLevel, difficulty }: { playLevel: number; difficulty: number } = $props();
	const colorClass = $derived(DIFFICULTY_COLORS[difficulty] ?? 'text-muted-foreground');
</script>

<span class="font-bold {colorClass}">{playLevel}</span>


