<script lang="ts">
	import authClient from '$lib/client/auth/client';
	import { t } from '$lib/i18n';
	import { LoaderCircle } from '@lucide/svelte';
	import Button from '../ui/button/button.svelte';
	import Input from '../ui/input/input.svelte';
	import Label from '../ui/label/label.svelte';
	import { toast } from 'svelte-sonner';
	import * as Card from '$lib/components/ui/card';
	import { Turnstile } from 'svelte-turnstile';
	import { PUBLIC_TURNSTILE_SITE_KEY } from '$env/static/public';
	import { langHref } from '$lib/utils';

	let email = $state('');
	let isLoading = $state(false);
	let submitted = $state(false);
	let turnstileToken = $state('');
	let resetTurnstile = $state<() => void>();

	async function submit(event: Event) {
		event.preventDefault();
		if (!turnstileToken) {
			toast.error(t.get('common.captcha_required'));
			return;
		}
		isLoading = true;
		const { error } = await authClient.requestPasswordReset({
			email,
			redirectTo: langHref('/reset-password'),
			fetchOptions: { headers: { 'x-captcha-response': turnstileToken } }
		});
		if (error) {
			toast.error(t.get(`common.auth_errors.${error.code ?? 'UNKNOWN_ERROR'}`));
			resetTurnstile?.();
			turnstileToken = '';
		} else {
			submitted = true;
		}
		isLoading = false;
	}
</script>

<div class="flex items-center justify-center p-4">
	<Card.Root>
		<Card.Header>
			<Card.Title>{$t('common.forgot_password_title')}</Card.Title>
			<Card.Description>{$t('common.forgot_password_description')}</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-4">
			{#if submitted}
				<p class="text-muted-foreground text-sm">{$t('common.forgot_password_sent')}</p>
			{:else}
				<form onsubmit={submit} class="space-y-4">
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
					<Turnstile
						siteKey={PUBLIC_TURNSTILE_SITE_KEY}
						on:turnstile-callback={(e) => (turnstileToken = e.detail.token)}
						on:turnstile-expired={() => (turnstileToken = '')}
						on:turnstile-error={() => (turnstileToken = '')}
						bind:reset={resetTurnstile}
					/>
					<Button type="submit" class="w-full" disabled={isLoading || !turnstileToken}>
						{#if isLoading}
							<LoaderCircle class="animate-spin" size={18} />
						{/if}
						{$t('common.forgot_password_submit')}
					</Button>
				</form>
			{/if}
			<p class="text-muted-foreground text-center text-sm">
				<a href={langHref('/signin')} class="underline underline-offset-4">{$t('common.back_to_signin')}</a>
			</p>
		</Card.Content>
	</Card.Root>
</div>


