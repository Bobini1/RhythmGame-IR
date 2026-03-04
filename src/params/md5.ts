import type { ParamMatcher } from '@sveltejs/kit';

export const match: ParamMatcher = (param) => {
	return /^[0-9A-Fa-f]{32}$/.test(param);
};

