<script lang="ts">
	import CardRoot from '$lib/components/ui/card/card.svelte';
	import CardHeader from '$lib/components/ui/card/card-header.svelte';
	import CardTitle from '$lib/components/ui/card/card-title.svelte';
	import CardDescription from '$lib/components/ui/card/card-description.svelte';
	import { t } from '$lib/i18n';
	import { toast } from 'svelte-sonner';
	import type { RemoteForm } from '@sveltejs/kit';
	import { Button } from '$lib/components/ui/button';
	import { ExternalLink } from '@lucide/svelte';

	interface Props {
		id?: number;
		user?: string;
		onDisconnect: () => void;
		onConnect: () => void;
		manageHref: string;
		syncForm: RemoteForm<void, { synced: boolean, result: boolean } | undefined>;
	}

	let { id, user, onDisconnect, onConnect, manageHref, syncForm }: Props = $props();

	// track whether the latest form result has been handled (to avoid duplicate toasts)
	let handled = $state(false);

	$effect(() => {
		// when a new submit begins, reset handled so the next result will show a toast
		if (syncForm.pending) handled = false;
	});

	$effect(() => {
		// when pending finishes and a result is present, show a toast once
		if (!syncForm.pending && syncForm.result && !handled) {
			const result = syncForm.result.result;
			if (result) {
				toast.success($t('integrations.bokutachi.sync_success'));
			} else {
				toast.error($t('integrations.bokutachi.sync_failed'));
			}
			handled = true;
		}
	});

// Determine the button variant based on the sync result (state-backed for typing)
let syncVariant = $state<'outline' | 'destructive' | 'default'>('outline');

$effect(() => {
	if (syncForm.pending) {
		syncVariant = 'outline';
	} else if (syncForm.result && syncForm.result.result === false) {
		syncVariant = 'destructive';
	} else {
		syncVariant = 'outline';
	}
});
</script>

<CardRoot class="w-full">
	<CardHeader>
		<div class="w-full">
			<div class="flex flex-col md:flex-row md:items-center md:justify-between gap-4">

				<!-- Left: logo + title + description -->
				<div class="flex items-start md:items-center gap-3 flex-1 min-w-0">
					<div class="h-12 w-12 rounded-lg overflow-hidden flex items-center justify-center shrink-0">
						<img
							src="https://cdn-boku.tachi.ac/logos/logo-mark.png"
							alt="Bokutachi logo"
							class="h-12 w-12 object-contain"
							loading="lazy"
						/>
					</div>
					<div class="min-w-0">
						<CardTitle>
							<h3 class="text-lg font-medium">Bokutachi Integration</h3>
						</CardTitle>
						<CardDescription>
							Connect your Bokutachi account to enable integrations.
							{#if id}
								<span class="block mt-1 text-sm">Connected as {user ?? 'unknown'}</span>
							{/if}
						</CardDescription>
					</div>
				</div>

				<!-- Right: actions -->
				<div class="flex items-center justify-end md:shrink-0">
					{#if id}
						<!-- Sync: submit button, shows feedback via result -->
						<form {...syncForm}>
							<Button
								type="submit"
								size="sm"
								variant={syncVariant}
								disabled={!!syncForm.pending}
								aria-label={$t('integrations.bokutachi.syncing')}
							>
								{#if syncForm.pending}
									{$t('integrations.bokutachi.syncing')}
								{:else if syncForm.result && syncForm.result.result === false}
									{$t('integrations.bokutachi.failed')}
								{:else if syncForm.result?.synced}
									{$t('integrations.bokutachi.synced')}
								{:else}
									{$t('integrations.bokutachi.sync')}
								{/if}
							</Button>
							<!-- Manage: a real link, opens externally -->
							<Button
								size="sm"
								variant="outline"
								href={manageHref}
								target="_blank"
								rel="noopener noreferrer"
								aria-label={$t('integrations.bokutachi.manage_label')}
							>
								{$t('integrations.bokutachi.manage')}
								<ExternalLink class="ml-1.5 h-3.5 w-3.5 opacity-60" />
							</Button>

							<!-- Disconnect -->
							<Button
								size="sm"
								variant="destructive"
								onclick={onDisconnect}
								aria-label={$t('integrations.bokutachi.disconnect_label')}
							>
								{$t('integrations.bokutachi.disconnect')}
							</Button>
						</form>
					{:else}
						<Button
							size="sm"
							variant="default"
							onclick={onConnect}
							aria-label={$t('integrations.bokutachi.connect_label')}
						>
							{$t('integrations.bokutachi.connect')}
						</Button>
					{/if}
				</div>

			</div>
		</div>
	</CardHeader>
</CardRoot>