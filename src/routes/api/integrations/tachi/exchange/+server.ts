import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/database/client';
import { integrations } from '$lib/server/database/schemas/integrations';
import { PUBLIC_BOKUTACHI_CLIENT_ID } from '$env/static/public';
import { eq, and } from 'drizzle-orm';

export const POST: RequestHandler = async (event) => {
  try {
    const session = event.locals.session;
    if (!session) return json({ error: 'Unauthorized' }, { status: 401 });

    const body = await event.request.json();
    const { code } = body as { code?: string };
    if (!code) return json({ error: 'Missing code' }, { status: 400 });

		const base = env.BOKUTACHI_BASE_URL;
		const tokenRes = await fetch(`${base}/api/v1/oauth/token`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				client_id: PUBLIC_BOKUTACHI_CLIENT_ID,
				client_secret: env.BOKUTACHI_CLIENT_SECRET,
				grant_type: 'authorization_code',
				redirect_uri: `${env.BOKUTACHI_CALLBACK_URL}/integrations/tachi/callback`,
				code
			})
		});

		if (!tokenRes.ok) {
			const text = await tokenRes.text();
			console.error('Token exchange failed', text);
			return json({ error: 'Token exchange failed' }, { status: 500 });
		}

		const data = (await tokenRes.json()).body;

    // Upsert into integrations table: if an integration for this user+provider exists, update it, otherwise insert.
    const existing = await db
      .select()
      .from(integrations)
      .where(and(eq(integrations.userId, Number(event.locals.user.id)), eq(integrations.provider, 'tachi')))
      .limit(1);

    if (existing.length > 0) {
      await db
				.update(integrations)
				.set({ data, updatedAt: new Date() })
				.where(eq(integrations.id, existing[0].id));
    } else {
      await db
				.insert(integrations)
				.values({ userId: Number(event.locals.user.id), provider: 'tachi', data });
    }

    return json({ ok: true });
  } catch (err) {
    console.error(err);
    return json({ error: 'Internal server error' }, { status: 500 });
  }
};



