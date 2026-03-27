import { defaultLocale, getDirection } from '$lib/api/configurations/common';
import type { AvailableLocales } from '$lib/enums/available-locales';
import { Locale } from './api';
import type { LayoutLoad } from './$types';
import { loadTranslations, locale, locales } from '$lib/i18n';
import { direction } from '$lib/stores';
import { getBaseMetaTags } from '$lib/client/configurations/meta-tags';

export const load: LayoutLoad = async (event) => {
	const { fetch, params, url } = event;
	const localeRes: { locale: AvailableLocales } = await (await fetch(Locale)).json();
	const localeFromCookie = localeRes.locale;
	const localeFromRoute = params['lang'];
	let choosenLocale = localeFromRoute || localeFromCookie;
	if (choosenLocale && !locales.get().includes(choosenLocale)) {
		choosenLocale = defaultLocale;
	}
	locale.set(choosenLocale);
	const newDirection = getDirection(locale.get() as AvailableLocales);
	direction.set(newDirection);
	await loadTranslations(choosenLocale);
	return {
		locale: choosenLocale,
		baseMetaTags: getBaseMetaTags({ url }),
			...event.data
	};
};
