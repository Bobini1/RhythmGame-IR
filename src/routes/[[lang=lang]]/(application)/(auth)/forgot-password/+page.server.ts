import type { PageServerLoad } from './$types';
import { createMetaTags } from '$lib/client/configurations/meta-tags';

export const load: PageServerLoad = async () => {
    return { meta: createMetaTags('common.forgot_password_title', 'seo.pages.forgot_password.description') };
};

