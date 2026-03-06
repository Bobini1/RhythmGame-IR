<script lang="ts">
	import Avatar from '$lib/components/avatar/avatar.svelte';
	import { langHref } from '$lib/utils';

	let { userId, name, image }: { userId: number; name: string; image: string | null } = $props();
	const href = $derived(langHref(`/players/${userId}`));
</script>

<a {href} class="flex min-w-0 items-center gap-2 hover:underline">
	<Avatar src={image ?? undefined} id={String(userId)} styleClass="h-6 w-6 shrink-0" />
	<span class="truncate">{name}</span>
</a>
