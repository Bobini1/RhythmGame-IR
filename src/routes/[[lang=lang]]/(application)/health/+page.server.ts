import { GET } from '$lib/api/helpers/request';
import { DbHealth, Health } from '../../../api';
import type { PageServerLoad } from './$types';
import { createMetaTags } from '$lib/client/configurations/meta-tags';

export const load: PageServerLoad = async ({ fetch }) => {
	const apiHealthStatus = await GET(Health, { fetch }).catch(() => false);
	const dbHealthStatus = await GET(DbHealth, { fetch }).catch(() => false);
	return {
		apiHealthStatus,
		dbHealthStatus
		,meta: createMetaTags('common.server_health', 'seo.description')
	};
};
