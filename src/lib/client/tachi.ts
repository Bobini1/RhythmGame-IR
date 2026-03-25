export async function syncToTachi(options?: { batchSize?: number; dryRun?: boolean; limit?: number }) {
  const body = {
    batchSize: options?.batchSize ?? 100,
    dryRun: options?.dryRun ?? false,
    limit: options?.limit
  };
  const res = await fetch('/api/tachi/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error ?? 'Sync failed');
  return json;
}

