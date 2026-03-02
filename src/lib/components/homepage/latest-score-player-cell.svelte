<script lang="ts">
	import Avatar from '$lib/components/avatar/avatar.svelte';
	import { page } from '$app/state';

	let { userId, name, image }: { userId: string; name: string; image: string | null } = $props();
	const lang = $derived(page.params.lang ? `/${page.params.lang}` : '');
	const href = $derived(`${lang}/players/${userId}`);
</script>

<a {href} class="flex min-w-0 items-center gap-2 hover:underline">
	<Avatar src={image ?? undefined} id={userId} styleClass="h-5 w-5 shrink-0" />
	<span class="truncate">{name}</span>
</a>

