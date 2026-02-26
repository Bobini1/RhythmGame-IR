import { AvailableLocales } from '$lib/enums/available-locales';
import type { ComboboxConfiguration } from '$lib/models/combobox';

export const LanguageSelectorConfiguration: ComboboxConfiguration = {
	options: [
		{
			value: AvailableLocales.Polish,
			label: `common.locales.${AvailableLocales.Polish}`
		},
		{
			value: AvailableLocales.English_US,
			label: `common.locales.${AvailableLocales.English_US}`
		}
	],
	placeholder: 'common.select_language',
	event: 'language_changed'
};
