<script lang="ts">
	const CLEAR_COLORS: Record<string, string> = {
		FAILED:    'text-red-400',
		AEASY:     'text-purple-400',
		EASY:      'text-green-400',
		NORMAL:    'text-sky-400',
		HARD:      'text-red-400',
		DAN:       'text-red-400',
		EXHARD:    'text-orange-400',
		EXDAN:     'text-orange-400',
		FC:        'text-slate-300',
		EXHARDDAN: 'text-slate-300',
		PERFECT:   'text-slate-300',
		MAX:       'text-slate-300'
	};

	let { value }: { value: string } = $props();
	const colorClass = $derived(CLEAR_COLORS[value] ?? '');
</script>

<span class="font-bold {colorClass}">{value}</span>

