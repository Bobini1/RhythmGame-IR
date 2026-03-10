<script lang="ts">
	import authClient from '$lib/client/auth/client';
	import { t } from '$lib/i18n';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import * as Alert from '$lib/components/ui/alert';
	import EmailAndPassword from '$lib/components/signin/providers/email-and-password.svelte';

	const session = authClient.useSession();
	
	function handleLogout() {
		authClient.signOut();
	}
</script>

<div class="w-full max-w-md">
	{#if $session.data}
		<Card.Root>
			<Card.Header>
				<Card.Title>{$t('common.player_settings')}</Card.Title>
				<Card.Description>
					{$t('common.signed_in_as', { user: $session.data.user.name || $session.data.user.email })}
				</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-4">
				<div class="space-y-2">
					<div class="font-medium">{$t('common.email')}</div>
					<div class="text-sm text-muted-foreground">{$session.data.user.email}</div>
				</div>
				{#if $session.data.user.name}
					<div class="space-y-2">
						<div class="font-medium">{$t('common.name')}</div>
						<div class="text-sm text-muted-foreground">{$session.data.user.name}</div>
					</div>
				{/if}
				<div class="pt-4">
					<Button onclick={handleLogout} variant="destructive" class="w-full">
						{$t('common.sign_out')}
					</Button>
				</div>
			</Card.Content>
		</Card.Root>
	{:else}
		<Card.Root>
			<Card.Header>
				<Card.Title>{$t('common.sign_in')}</Card.Title>
				<Card.Description>
					{$t('common.sign_in_to_access_features')}
				</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-4">
				<EmailAndPassword redirect="/" />
				<Alert.Root>
					<Alert.Description>
						{$t('common.native_apps_use_bearer_tokens')}
					</Alert.Description>
				</Alert.Root>
			</Card.Content>
		</Card.Root>
	{/if}
</div>