<script lang="ts">
	import authClient from '$lib/client/auth/client';
	import { t } from '$lib/i18n';
	import { LoaderCircle } from '@lucide/svelte';
	import Button from '../ui/button/button.svelte';
	import Input from '../ui/input/input.svelte';
	import Label from '../ui/label/label.svelte';
	import { toast } from 'svelte-sonner';
	import * as Card from '$lib/components/ui/card';
	import { goto } from '$app/navigation';

	let { token }: { token: string } = $props();

	const session = authClient.useSession();
	const isAuthenticated = $derived(!!$session.data);

	let currentPassword = $state('');
	let password = $state('');
	let confirmPassword = $state('');
	let isLoading = $state(false);
	let tokenError = $state(false);

	async function submit(event: Event) {
		event.preventDefault();
		if (password !== confirmPassword) {
			toast.error(t.get('common.passwords_do_not_match'));
			return;
		}
		isLoading = true;
		if (token) {
			const { error } = await authClient.resetPassword({ newPassword: password, token });
			if (error) {
				tokenError = true;
				toast.error(t.get(`common.auth_errors.${error.code ?? 'UNKNOWN_ERROR'}`));
			} else {
				toast.success(t.get('common.password_reset_success'));
				goto('/signin');
			}
		} else {
			const { error } = await authClient.changePassword({
				currentPassword,
				newPassword: password
			});
			if (error) {
				toast.error(t.get(`common.auth_errors.${error.code ?? 'UNKNOWN_ERROR'}`));
			} else {
				toast.success(t.get('common.password_reset_success'));
				goto('/');
			}
		}
		isLoading = false;
	}
</script>

<div class="flex items-center justify-center p-4">
	<Card.Root>
		<Card.Header>
			<Card.Title>{$t('common.reset_password_title')}</Card.Title>
			<Card.Description>{$t('common.reset_password_description')}</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-4">
			{#if !isAuthenticated && !token}
				<p class="text-destructive text-sm">{$t('common.reset_password_invalid_link')}</p>
				<p class="text-muted-foreground text-center text-sm">
					<a href="/forgot-password" class="underline underline-offset-4">{$t('common.request_new_reset_link')}</a>
				</p>
			{:else}
				<form onsubmit={submit} class="space-y-4">
					{#if isAuthenticated && !token}
						<div class="space-y-2">
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
					{/if}
					<div class="space-y-2">
						<Label for="password">{$t('common.new_password')}</Label>
						<Input
							id="password"
							type="password"
							placeholder={t.get('common.enter_password')}
							bind:value={password}
							required
							disabled={isLoading}
						/>
					</div>
					<div class="space-y-2">
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
					<Button type="submit" class="w-full" disabled={isLoading}>
						{#if isLoading}
							<LoaderCircle class="animate-spin" size={18} />
						{/if}
						{$t('common.reset_password_submit')}
					</Button>
				</form>
				{#if tokenError}
					<p class="text-muted-foreground text-center text-sm">
						<a href="/forgot-password" class="underline underline-offset-4">{$t('common.request_new_reset_link')}</a>
					</p>
				{:else if isAuthenticated && !token}
					<p class="text-muted-foreground text-center text-sm">
						<a href="/forgot-password" class="underline underline-offset-4">{$t('common.request_reset_link')}</a>
					</p>
				{/if}
			{/if}
			{#if !isAuthenticated}
				<p class="text-muted-foreground text-center text-sm">
					<a href="/signin" class="underline underline-offset-4">{$t('common.back_to_signin')}</a>
				</p>
			{/if}
		</Card.Content>
	</Card.Root>
</div>

