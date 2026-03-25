<script lang="ts">
	import * as Breadcrumb from '$lib/components/ui/breadcrumb/index.js';
	import { t } from '$lib/i18n';
	import type { BreadcrumbDef } from '$lib/models/breadcrumb';

	const { crumbs }: { crumbs: BreadcrumbDef[] } = $props();
</script>

<Breadcrumb.Root>
	<Breadcrumb.List>
		{#each crumbs as crumb (crumb)}
			<Breadcrumb.Item>
				{#if crumb.href}
				<Breadcrumb.Link href={crumb.href}>{$t(crumb.label)}</Breadcrumb.Link>
					{:else}
					<Breadcrumb.Page>{$t(crumb.label)}</Breadcrumb.Page>
					{/if}
			</Breadcrumb.Item>
			{#if crumbs.indexOf(crumb) < crumbs.length - 1}
				<Breadcrumb.Separator />
			{/if}
		{/each}
	</Breadcrumb.List>
</Breadcrumb.Root>