export const load = async ({ locals }) => {
  // Default safe status
  const tachiId = locals?.tachi?.userID ?? null;

  return { tachiId };
};

