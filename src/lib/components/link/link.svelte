<script lang="ts">
	import { t } from '$lib/i18n';
	import type { Link } from '$lib/models/link';
	import { langHref } from '$lib/utils';

	interface Props {
		link: Link;
		class?: string;
	}

	let {
		link,
		class:
			className = 'text-muted-foreground hover:text-foreground transition-colors cursor-pointer'
	}: Props = $props();
</script>

<a href={langHref(link.path)} class={className}>
	<div class="flex flex-row items-center gap-2">
		{#if link.icon}
			<link.icon />
		{/if}
		<span class="hover:underline-offset-1">{$t(link.label)}</span>
	</div>
</a>
