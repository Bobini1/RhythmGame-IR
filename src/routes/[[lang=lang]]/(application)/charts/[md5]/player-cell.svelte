<script lang="ts">
	import Avatar from '$lib/components/avatar/avatar.svelte';
	import { page } from '$app/state';

	let { userId, name, image }: { userId: number; name: string; image: string | null } = $props();

	const lang = $derived(page.params.lang ? `/${page.params.lang}` : '');
	const md5 = $derived(page.params.md5);
	const href = $derived(`${lang}/charts/${md5}/player/${userId}/scores`);
</script>

<a {href} class="flex items-center gap-2 hover:underline">
	<Avatar src={image ?? undefined} id={String(userId)} size={24} styleClass="h-6 w-6 shrink-0" />
	<span class="truncate">{name}</span>
</a>
