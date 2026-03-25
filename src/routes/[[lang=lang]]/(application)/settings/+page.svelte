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
				import { onMount } from 'svelte';
				import { t } from '$lib/i18n';
	import { PUBLIC_BOKUTACHI_API } from '$env/static/public';
	import { syncScores } from './tachi.remote';

	let tachiId = $derived(page.data.tachiId);

	let user : string | undefined = $state(undefined);

	const session = authClient.useSession();

	const removeUrl = '/api/integrations/tachi/remove';

	const manageHref = $derived(tachiId ? `https://boku.tachi.ac/u/${tachiId}/integrations` : 'https://boku.tachi.ac');

	onMount(async () => {
		const res = await fetch(`${PUBLIC_BOKUTACHI_API}/users/${tachiId}`);
		if (res.ok) {
			const body = await res.json();
			user = body?.body?.username ?? null as string | null;
		} else {
			console.warn('Tachi API returned', res.status, await res.text());
		}
	});

	function startConnect() {
		const id = env.PUBLIC_BOKUTACHI_CLIENT_ID;
		if (!id) {
			toast.error($t('integrations.bokutachi.client_id_not_configured'));
			return;
		}
		window.location.href = `https://boku.tachi.ac/oauth/request-auth?clientID=${encodeURIComponent(id)}`;
	}

	async function disconnect() {
		try {
			const res = await fetch(removeUrl, { method: 'POST' });
			const redirectTo = manageHref ?? 'https://boku.tachi.ac';
			if (res.ok) {
				toast.success($t('integrations.bokutachi.disconnect_success'));
				// Inform user they need to finish disconnecting on the Tachi site and redirect them there shortly
				toast($t('integrations.bokutachi.disconnect_finish_notice'));
				user = undefined;
				// keep tachiId for redirect if available
				setTimeout(() => {
					try {
						window.location.href = redirectTo;
					} catch (e) {
						console.warn('Redirect failed', e);
					}
				}, 3000);
			} else {
				toast.error($t('integrations.bokutachi.disconnect_failed'));
			}
		} catch (err) {
			console.error('Disconnect failed', err);
			toast.error($t('integrations.bokutachi.disconnect_failed'));
		}
	}
</script>

<BasePage title="common.settings" description="seo.pages.settings.description">
	<div class="flex w-full flex-col gap-8">
		<ThemeSettings />
		{#if $session.data}
			<ProfilePicture />
			<BokutachiIntegration syncForm={syncScores} user={user} id={tachiId} manageHref={`https://boku.tachi.ac/u/${tachiId}/integrations`} onConnect={startConnect} onDisconnect={disconnect} />
			<ChangePassword />
			<DeleteAccount />
		{/if}
	</div>
</BasePage>
