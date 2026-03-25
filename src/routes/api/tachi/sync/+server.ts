import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { db } from '$lib/server/database/client';
import { scores } from '$lib/server/database/schemas/scores';
import { eq } from 'drizzle-orm';
import { queryScores, getScoreById } from '$lib/server/api/scores.queries';
import { uploadScoresToTachi } from '$lib/server/integrations/tachi';

// POST /api/tachi/sync
// Body: { batchSize?: number, dryRun?: boolean, limit?: number, retryAttempts?: number }
export const POST: RequestHandler = async (event) => {
  try {
    const session = event.locals.session;
    if (!session) return json({ error: 'Unauthorized' }, { status: 401 });

    const tachi = event.locals.tachi;
    if (!tachi?.token) return json({ error: 'Bokutachi token missing' }, { status: 403 });

    const userId = Number(event.locals.user.id);

    let body: any = {};
    try {
      body = await event.request.json();
    } catch {
      // ignore, we'll use defaults
    }

    // No batching: fetch all scores for the user and upload them in a single request
    const filters = { user: userId } as any;
    const rows = await queryScores(filters, undefined, undefined, 'date', 'asc');

    const processed = rows?.length ?? 0;
    let uploaded = 0;
    const failed: Array<{ guid: string; reason: string }> = [];

    if (!rows || rows.length === 0) {
      return json({ processed: 0, uploaded: 0, failed: [], batches: 0 });
    }

    try {
      await uploadScoresToTachi(rows, tachi.token);
      uploaded = rows.length;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // On error, record all as failed with same reason
      for (const s of rows) failed.push({ guid: s.guid, reason });
    }

    return json({ processed, uploaded, failed, batches: 1 });
  } catch (err) {
    console.error('[POST /api/tachi/sync] failed', err);
    return json({ error: 'Internal server error' }, { status: 500 });
  }
};


