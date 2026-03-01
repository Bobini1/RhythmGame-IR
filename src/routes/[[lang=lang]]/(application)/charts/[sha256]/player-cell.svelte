<script lang="ts">
	import Avatar from '$lib/components/avatar/avatar.svelte';
	import { page } from '$app/state';

	let { userId, name, image }: { userId: string; name: string; image: string | null } = $props();

	const lang = $derived(page.params.lang ? `/${page.params.lang}` : '');
	const sha256 = $derived(page.params.sha256);
	// Links to the per-user scores page for this chart
	const href = $derived(`${lang}/charts/${sha256}/${userId}`);
</script>

<a {href} class="flex items-center gap-2 hover:underline">
	<Avatar src={image ?? undefined} id={userId} size={24} styleClass="h-6 w-6 shrink-0" />
	<span class="truncate">{name}</span>
</a>
