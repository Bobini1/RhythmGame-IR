<script lang="ts">
	import authClient from '$lib/client/auth/client';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { t } from '$lib/i18n';
	import { LoaderCircle } from '@lucide/svelte';
	import { toast } from 'svelte-sonner';
	import { langHref } from '$lib/utils';

	let currentPassword = $state('');
	let newPassword = $state('');
	let confirmPassword = $state('');
	let isLoading = $state(false);
	let open = $state(false);

	async function submit(event: Event) {
		event.preventDefault();
		if (newPassword !== confirmPassword) {
			toast.error(t.get('common.passwords_do_not_match'));
			return;
		}
		isLoading = true;
		const { error } = await authClient.changePassword({ currentPassword, newPassword });
		if (error) {
			toast.error(t.get(`common.auth_errors.${error.code ?? 'UNKNOWN_ERROR'}`));
		} else {
			toast.success(t.get('common.password_changed_success'));
			currentPassword = '';
			newPassword = '';
			confirmPassword = '';
			open = false;
		}
		isLoading = false;
	}
</script>

<div class="rounded-lg border p-4 flex flex-col gap-3">
	<div>
		<h3 class="font-semibold">{$t('common.change_password')}</h3>
		<p class="text-muted-foreground text-sm mt-1">{$t('common.change_password_description')}</p>
	</div>
	{#if open}
		<form onsubmit={submit} class="flex flex-col gap-3">
			<div class="space-y-1">
				<Label for="current-password">{$t('common.current_password')}</Label>
				<Input
					id="current-password"
					type="password"
					placeholder={t.get('common.enter_password')}
					bind:value={currentPassword}
					required
					disabled={isLoading}
				/>
			</div>
			<div class="space-y-1">
				<Label for="new-password">{$t('common.new_password')}</Label>
				<Input
					id="new-password"
					type="password"
					placeholder={t.get('common.enter_password')}
					bind:value={newPassword}
					required
					disabled={isLoading}
				/>
			</div>
			<div class="space-y-1">
				<Label for="confirm-password">{$t('common.confirm_password')}</Label>
				<Input
					id="confirm-password"
					type="password"
					placeholder={t.get('common.enter_password')}
					bind:value={confirmPassword}
					required
					disabled={isLoading}
				/>
			</div>
			<div class="flex gap-2">
				<Button type="submit" size="sm" disabled={isLoading}>
					{#if isLoading}
						<LoaderCircle class="animate-spin" size={16} />
					{/if}
					{$t('common.save_changes')}
				</Button>
				<Button type="button" variant="outline" size="sm" disabled={isLoading} onclick={() => (open = false)}>
					{$t('common.cancel')}
				</Button>
			</div>
			<p class="text-muted-foreground text-sm">
				<a href={langHref('/forgot-password')} class="underline underline-offset-4">{$t('common.request_reset_link')}</a>
			</p>
		</form>
	{:else}
		<div>
			<Button variant="outline" size="sm" onclick={() => (open = true)}>
				{$t('common.change_password')}
			</Button>
		</div>
	{/if}
</div>

