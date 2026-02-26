import * as sitemap from 'super-sitemap';
import type { RequestHandler } from '@sveltejs/kit';
import { BaseUrl } from '$lib/api/configurations/common';
import { AvailableLocales } from '$lib/enums/available-locales';

export const GET: RequestHandler = async () => {
	return await sitemap.response({
		origin: BaseUrl,
		lang: {
			default: AvailableLocales.English_US,
			alternates: [AvailableLocales.Polish]
		}
	});
};
