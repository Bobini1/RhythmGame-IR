import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { db } from '$lib/server/database/client';
import { integrations } from '$lib/server/database/schemas/integrations';
import { and, eq } from 'drizzle-orm';

export const POST: RequestHandler = async (event) => {
  try {
    const session = event.locals.session;
    if (!session) return json({ error: 'Unauthorized' }, { status: 401 });

    await db.delete(integrations).where(and(eq(integrations.userId, Number(event.locals.user.id)), eq(integrations.provider, 'tachi')));
    return json({ ok: true });
  } catch (err) {
    console.error(err);
    return json({ error: 'Internal server error' }, { status: 500 });
  }
};


