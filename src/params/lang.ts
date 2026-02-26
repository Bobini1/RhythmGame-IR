import type { ParamMatcher } from '@sveltejs/kit';
import { AvailableLocales } from '$lib/enums/available-locales';

export const match = ((param: string): param is AvailableLocales => {
	return !param || Object.values(AvailableLocales).includes(param as AvailableLocales);
}) satisfies ParamMatcher;
