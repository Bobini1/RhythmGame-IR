<script lang="ts">
	import BasePage from '$lib/components/base-page/base-page.svelte';
	import ThemeSettings from '$lib/components/settings/theme/theme.svelte';
	import ProfilePicture from '$lib/components/settings/profile-picture/profile-picture.svelte';
	import DeleteAccount from '$lib/components/settings/delete-account/delete-account.svelte';
	import ChangePassword from '$lib/components/settings/change-password/change-password.svelte';
	import BokutachiIntegration from '$lib/components/settings/integrations/bokutachi.svelte';
	import authClient from '$lib/client/auth/client';
	import { page } from '$app/state';
	import { env } from '$env/dynamic/public';
	import { toast } from 'svelte-sonner';

	let tachiStatus = $derived(page.data.tachiStatus);

	const session = authClient.useSession();

	const removeUrl = '/api/integrations/tachi/remove';

	function startConnect() {
		const id = env.PUBLIC_BOKUTACHI_CLIENT_ID;
		if (!id) {
			toast.error('Tachi client ID not configured');
			return;
		}
		window.location.href = `https://boku.tachi.ac/oauth/request-auth?clientID=${encodeURIComponent(id)}`;
	}

	async function disconnect() {
		try {
			const res = await fetch(removeUrl, { method: 'POST' });
			if (res.ok) {
				toast.success('Disconnected');
				tachiStatus = null;
			} else {
				toast.error('Failed to disconnect');
			}
		} catch (err) {
			console.error('Disconnect failed', err);
			toast.error('Failed to disconnect');
		}
	}
</script>

<BasePage title="common.settings" description="seo.pages.settings.description">
	<div class="flex w-full flex-col gap-8">
		<ThemeSettings />
		{#if $session.data}
			<ProfilePicture />
			<BokutachiIntegration status={tachiStatus} onConnect={startConnect} onDisconnect={disconnect} />
			<ChangePassword />
			<DeleteAccount />
		{/if}
	</div>
</BasePage>
