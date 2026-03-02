<script lang="ts">
	import BasePage from '$lib/components/base-page/base-page.svelte';
	import ThemeSettings from '$lib/components/settings/theme/theme.svelte';
	import DeleteAccount from '$lib/components/settings/delete-account/delete-account.svelte';
	import authClient from '$lib/client/auth/client';

	const session = authClient.useSession();
</script>

<BasePage title="common.settings" description="seo.pages.settings.description">
	<div class="flex flex-col gap-8">
		<ThemeSettings />
		{#if $session.data}
			<DeleteAccount />
		{/if}
	</div>
</BasePage>
