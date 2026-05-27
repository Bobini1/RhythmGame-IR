import * as sitemap from 'super-sitemap';
import type { RequestHandler } from '@sveltejs/kit';
import { BaseUrl } from '$lib/api/configurations/common';
import { AvailableLocales } from '$lib/enums/available-locales';
import { getSitemapParamValues } from '$lib/server/sitemap/param-values';

const excludeRoutePatterns = [
	'\\(auth\\)',
	'\\(application\\)/settings$',
	'\\(application\\)/health$',
	'\\(site\\)/manage-cookies$',
	'\\(site\\)/policies/',
	'/integrations/tachi/callback$'
];

export const GET: RequestHandler = async () => {
	const paramValues = await getSitemapParamValues();

	return await sitemap.response({
		origin: BaseUrl,
		excludeRoutePatterns,
		lang: {
			default: AvailableLocales.English_US,
			alternates: [AvailableLocales.Polish]
		},
		// Provide parameter values for dynamic routes (e.g. /charts/[md5])
		paramValues
	});
};
