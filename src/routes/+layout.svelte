<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { locale } from '$lib/i18n';
	import type { AvailableLocales } from '$lib/enums/available-locales';
	import { analyticsAllowed, direction } from '$lib/stores';
	import { directionMap } from '$lib/api/configurations/common';
	import SEO from '$lib/components/seo/seo.svelte';
	import { ModeWatcher } from 'mode-watcher';
	import { Toaster } from '$lib/components/ui/sonner/index.js';
	import { deepMerge } from 'svelte-meta-tags';
	import { page } from '$app/state';
	import { changeTheme, getTheme } from '$lib/theme/manager';
	import { isAnalyticsAccepted, revokeAnalyticsCookies } from '$lib/manage-cookies/manager';
	import { browser } from '$app/environment';
	import type { LayoutProps } from './$types';

	let { children, data } : LayoutProps = $props();
	let mergedMetaTags = $derived(
		deepMerge(data.baseMetaTags, page.data.meta)
	);

	onMount(() => {
		changeTheme(getTheme());
		locale.subscribe((seletedLocale) => {
			updateDirection(seletedLocale as AvailableLocales);
		});
	});

	function updateDirection(locale: AvailableLocales) {
		if (!locale) {
			return;
		}
		if (document) {
			const dir = directionMap[locale] ?? $direction;
			document.dir = dir === 'lr' ? 'ltr' : 'rtl';
			direction.set(dir);
		}
	}

	$analyticsAllowed = isAnalyticsAccepted(page.data.cookiePreferences);

	if (browser) {
		window.dataLayer = window.dataLayer || [];
	}

	// Default consent – set before GTM loads
	if (browser && !window.gtmLoaded) {
		window.dataLayer.push(['consent', 'default', {
			analytics_storage: 'denied'
		}]);
		const script = document.createElement('script');
		script.src = 'https://www.googletagmanager.com/gtm.js?id=GTM-NH6TLDJF';
		script.async = true;
		document.head.appendChild(script);
		window.gtmLoaded = true;
	}

	$effect(() => {
		if (browser && $analyticsAllowed !== undefined) {
			const consentState = $analyticsAllowed ? 'granted' : 'denied';
			window.dataLayer.push(['consent', 'update', {
				analytics_storage: consentState
			}]);

			// Optional: clear existing GA cookies when denied
			if (!consentState) {
				document.cookie.split(';').forEach(c => {
					const [name] = c.split('=');
					if (name.trim().startsWith('_ga')) {
						document.cookie = `${name}=; Max-Age=0; path=/; domain=${location.hostname}`;
					}
				});
			}
		}
	});
</script>

<Toaster expand={true} richColors={true} dir={$direction === 'lr' ? 'ltr' : 'rtl'} />
<SEO data={mergedMetaTags} />
<ModeWatcher />
{@render children?.()}
