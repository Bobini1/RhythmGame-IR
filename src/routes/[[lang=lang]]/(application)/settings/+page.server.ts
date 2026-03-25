export const load = async ({ locals }) => {
	const tachiId = locals?.tachi?.userID ?? null;

	return { tachiId };
};
