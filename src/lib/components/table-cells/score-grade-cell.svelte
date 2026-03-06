<script lang="ts">
	import { getGrade, getGradeColor } from '$lib/utils/grades';

	let { points, maxPoints }: { points: number; maxPoints: number } = $props();
	const grade = $derived(getGrade(points, maxPoints));
	const color = $derived(getGradeColor(grade));
</script>

<span class="font-bold {color}">{grade}</span>


