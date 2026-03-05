<script lang="ts">
	import Avatar from '$lib/components/avatar/avatar.svelte';
	import { page } from '$app/state';

	let { id, name, image }: { id: number; name: string; image: string | null } = $props();
	const lang = $derived(page.params.lang ? `/${page.params.lang}` : '');
	const href = $derived(`${lang}/players/${id}`);
</script>

<a {href} class="flex min-w-0 items-center gap-2 hover:underline">
	<Avatar src={image ?? undefined} id={String(id)} styleClass="h-5 w-5 shrink-0" />
	<span class="truncate">{name}</span>
</a>
