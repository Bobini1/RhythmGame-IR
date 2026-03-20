import type { PageServerLoad } from './$types';
import { env } from '$env/dynamic/private';

export const load: PageServerLoad = async ({ locals }) => {
  // Default safe status
  let tachiStatus: null | { username?: string; id: number } = null;

  try {
    const tachi = locals?.tachi;
    if (tachi) {
      const tachiId = tachi.userID;

      // call tachi to get username (server-side env; use $env/dynamic/private)
      const res = await fetch(`${env.BOKUTACHI_API}/users/${tachiId}`);
      if (res.ok) {
        const body = await res.json();
        const user = body?.body?.username as string | undefined;
        if (user) tachiStatus = { username: user, id: tachiId };
      } else {
        console.warn('Tachi API returned', res.status, await res.text());
      }
    }
  } catch (err) {
    console.warn('Failed to load tachi status in server load', err);
  }

  return { tachiStatus };
};

