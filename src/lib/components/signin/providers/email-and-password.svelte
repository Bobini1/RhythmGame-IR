<script lang="ts">
	import authClient from '$lib/client/auth/client';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { t } from '$lib/i18n';
	import { LoaderCircle } from '@lucide/svelte';
	import { toast } from 'svelte-sonner';
	import { langHref } from '$lib/utils';

	const session = authClient.useSession();
	let { redirect }: { redirect: string } = $props();
	let email = $state('');
	let password = $state('');
	let isLoading = $derived($session?.isPending);
	let needsVerification = $state(false);
	let isResending = $state(false);

	async function signin(event: Event) {
		event.preventDefault();
		needsVerification = false;
		authClient.signIn.email({
			email,
			password,
			callbackURL: redirect,
			fetchOptions: {
				onError: (ctx) => {
					if (ctx.error.status === 403) {
						needsVerification = true;
						toast.error(t.get('common.email_verify_required'));
						return;
					}
					toast.error(t.get('common.signin_failed'));
				}
			}
		});
	}

	async function resendVerification() {
		if (!email) {
			toast.error(t.get('common.enter_email_first'));
			return;
		}
		isResending = true;
		const { error } = await authClient.sendVerificationEmail({
			email,
			callbackURL: redirect
		});
		isResending = false;
		if (error) {
			toast.error(t.get('common.resend_failed'));
		} else {
			toast.success(t.get('common.verification_sent'));
		}
	}
</script>

<form onsubmit={signin} class="space-y-4">
	<div class="space-y-2">
		<Label for="email">{$t('common.email')}</Label>
		<Input
			id="email"
			type="email"
			placeholder={t.get('common.enter_email')}
			bind:value={email}
			required
			disabled={isLoading}
		/>
	</div>

	<div class="space-y-2">
		<div class="flex items-center justify-between">
			<Label for="password">{$t('common.password')}</Label>
			<a href={langHref('/forgot-password')}
			   class="text-muted-foreground text-sm underline underline-offset-4">{$t('common.forgot_password')}</a>
		</div>
		<Input
			id="password"
			type="password"
			placeholder={t.get('common.enter_password')}
			bind:value={password}
			required
			disabled={isLoading}
		/>
	</div>

	{#if needsVerification}
		<div class="bg-muted rounded-md p-3 text-sm flex flex-col gap-2">
			<span class="text-muted-foreground">{$t('common.email_verify_required')}</span>
			<Button
				type="button"
				variant="outline"
				size="sm"
				class="w-full"
				disabled={isResending}
				onclick={resendVerification}
			>
				{#if isResending}
					<LoaderCircle class="animate-spin" size={14} />
				{/if}
				{$t('common.resend_verification')}
			</Button>
		</div>
	{/if}

	<Button type="submit" class="w-full" disabled={isLoading}>
		{#if isLoading}
			<LoaderCircle class="animate-spin" size={18} />
		{/if}
		{$t('common.sign_in')}
	</Button>
</form>