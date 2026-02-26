import i18n, { type Config } from 'sveltekit-i18n';
import { Locale } from '../../routes/api';
import { AvailableLocales } from '$lib/enums/available-locales';

interface Params {
	year?: string;
	number?: number;
	user?: string;
	author?: string;
}

/** @type {import('sveltekit-i18n').Config} */
const config: Config<Params> = {
	loaders: [
		{
			locale: AvailableLocales.Polish,
			key: 'common',
			loader: async () => (await import('$lib/i18n/pl-PL/common.json')).default
		},
		{
			locale: AvailableLocales.Polish,
			key: 'seo',
			loader: async () => (await import('$lib/i18n/pl-PL/seo.json')).default
		},
		{
			locale: AvailableLocales.Polish,
			key: 'homepage',
			loader: async () => (await import('$lib/i18n/pl-PL/homepage.json')).default
		},
		{
			locale: AvailableLocales.English_US,
			key: 'common',
			loader: async () => (await import('./en-US/common.json')).default
		},
		{
			locale: AvailableLocales.English_US,
			key: 'seo',
			loader: async () => (await import('./en-US/seo.json')).default
		},
		{
			locale: AvailableLocales.English_US,
			key: 'homepage',
			loader: async () => (await import('./en-US/homepage.json')).default
		}
	]
};

export const { t, locale, locales, loading, loadTranslations, initialized } = new i18n(config);

export const changeLocale = (newLocale: string) => {
	locale.set(newLocale);
	const formData = new FormData();
	formData.append('locale', newLocale);
	fetch(Locale, { method: 'POST', body: formData });
};
