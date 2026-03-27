import type { PageServerLoad } from './$types';
import { createMetaTags } from '$lib/client/configurations/meta-tags';

export const load: PageServerLoad = async () => {
    return { meta: createMetaTags('common.reset_password_title', 'seo.pages.reset_password.description') };
};

