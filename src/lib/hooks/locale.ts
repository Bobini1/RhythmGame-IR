import { AvailableLocales } from '$lib/enums/available-locales';
import { error, type Handle } from '@sveltejs/kit';

const locale: Handle = async ({ event, resolve }) => {
	const lang = event.params['lang'];
	if (lang && !Object.values(AvailableLocales).includes(lang as AvailableLocales)) {
		error(404, { message: 'No such locale' });
	}
	
	return resolve(event);
};
export default locale;
