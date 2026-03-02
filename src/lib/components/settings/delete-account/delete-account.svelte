<script lang="ts">
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Button } from '$lib/components/ui/button';
	import { t } from '$lib/i18n';
	import { goto } from '$app/navigation';
	import authClient from '$lib/client/auth/client';
	import { toast } from 'svelte-sonner';

	let open = $state(false);
	let isLoading = $state(false);

	async function deleteAccount() {
		isLoading = true;
		try {
			const res = await fetch('/api/user', { method: 'DELETE' });
			if (!res.ok) {
				toast.error($t('common.delete_account_error'));
				return;
			}
			await authClient.signOut();
			toast.success($t('common.delete_account_success'));
			goto('/');
		} catch {
			toast.error($t('common.delete_account_error'));
		} finally {
			isLoading = false;
			open = false;
		}
	}
</script>

<div class="rounded-lg border border-destructive/40 p-4 flex flex-col gap-3">
	<div>
		<h3 class="font-semibold text-destructive">{$t('common.delete_account')}</h3>
		<p class="text-muted-foreground text-sm mt-1">{$t('common.delete_account_description')}</p>
	</div>
	<div>
		<AlertDialog.Root bind:open>
			<AlertDialog.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="destructive" size="sm">
						{$t('common.delete_account')}
					</Button>
				{/snippet}
			</AlertDialog.Trigger>
			<AlertDialog.Content>
				<AlertDialog.Header>
					<AlertDialog.Title>{$t('common.delete_account_confirm_title')}</AlertDialog.Title>
					<AlertDialog.Description>
						{$t('common.delete_account_confirm_description')}
					</AlertDialog.Description>
				</AlertDialog.Header>
				<AlertDialog.Footer>
					<AlertDialog.Cancel disabled={isLoading}>
						{$t('common.cancel')}
					</AlertDialog.Cancel>
					<AlertDialog.Action
						onclick={deleteAccount}
						disabled={isLoading}
						class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
					>
						{$t('common.delete_account_confirm')}
					</AlertDialog.Action>
				</AlertDialog.Footer>
			</AlertDialog.Content>
		</AlertDialog.Root>
	</div>
</div>

