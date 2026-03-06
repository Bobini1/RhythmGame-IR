<script lang="ts">
	import Avatar from '$lib/components/avatar/avatar.svelte';
	import { langHref } from '$lib/utils';

	let { id, name, image }: { id: number; name: string; image: string | null } = $props();
	const href = $derived(langHref(`/players/${id}`));
</script>

<a {href} class="flex min-w-0 items-center gap-2 hover:underline">
	<Avatar src={image ?? undefined} id={String(id)} styleClass="h-5 w-5 shrink-0" />
	<span class="truncate">{name}</span>
</a>
