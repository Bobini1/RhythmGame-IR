import { LocaleNativeNames } from '$lib/enums/available-locales';
import type { ComboboxConfiguration } from '$lib/models/combobox';

export const LanguageSelectorConfiguration: ComboboxConfiguration = {
	options: Object.entries(LocaleNativeNames).map(([value, label]) => ({
		value,
		label,
		noTranslationRequired: true
	})),
	placeholder: 'common.select_language',
	event: 'language_changed'
};
