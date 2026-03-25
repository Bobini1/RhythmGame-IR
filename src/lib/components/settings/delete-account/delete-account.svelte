<script lang="ts">
import * as AlertDialog from '$lib/components/ui/alert-dialog';
import { Button } from '$lib/components/ui/button';
import { t } from '$lib/i18n';
import authClient from '$lib/client/auth/client';
import { toast } from 'svelte-sonner';
import { langGoto } from '$lib/utils';
import * as Card from '$lib/components/ui/card';

	let open = $state(false);
	let isLoading = $state(false);

	async function deleteAccount() {
		isLoading = true;
		try {
			const res = await fetch('/api/users/me', { method: 'DELETE' });
			if (!res.ok) {
				toast.error($t('common.delete_account_error'));
				return;
			}
			await authClient.signOut();
			toast.success($t('common.delete_account_success'));
			langGoto('/');
		} catch {
			toast.error($t('common.delete_account_error'));
		} finally {
			isLoading = false;
			open = false;
		}
	}
</script>

<Card.Root class="w-full">
  <Card.Header>
	<Card.Title>
	  <h3 class="font-semibold text-destructive">{$t('common.delete_account')}</h3>
	</Card.Title>
	<Card.Description>{$t('common.delete_account_description')}</Card.Description>
  </Card.Header>

  <div class="px-4">
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
</Card.Root>

