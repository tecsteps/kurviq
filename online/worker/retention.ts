// Retention: an hourly job (cron trigger in wrangler.jsonc, `scheduled` in
// ./index.ts) deletes bug reports and change requests 2 years after they were
// sent, and contact messages 1 year after receipt. The sender hash (keyed
// hash of the IP / agent pairing) is only needed for the rate limits (last
// hour / last day): it is blanked in rows older than a day, so a stored report
// or message carries no sender identifier beyond that (at most ~25 hours).
// Statistics are counters only (no personal data) and are kept.

type D1 = { prepare: (sql: string) => { bind: (...values: unknown[]) => { run: () => Promise<unknown> } } };

const yearsAgo = (now: number, years: number) => {
  const date = new Date(now);
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date.toISOString();
};

/** delete what is past its retention; a table that does not exist yet is skipped */
export const runRetention = async (env: { FEEDBACK?: D1 }, now = Date.now()) => {
  const db = env.FEEDBACK;
  const done: Record<string, string> = {};
  if (!db) {
    return done;
  }
  const dayAgo = new Date(now - 86_400_000).toISOString();
  for (const [table, years] of [
    ["feedback", 2],
    ["contact_messages", 1],
  ] as const) {
    try {
      const deleted: any = await db.prepare(`DELETE FROM ${table} WHERE created_at < ?`).bind(yearsAgo(now, years)).run();
      const blanked: any = await db.prepare(`UPDATE ${table} SET sender = '' WHERE created_at < ? AND sender != ''`).bind(dayAgo).run();
      done[table] = `deleted ${deleted?.meta?.changes ?? "?"}, sender removed from ${blanked?.meta?.changes ?? "?"}`;
    } catch (error) {
      done[table] = /no such table/i.test(String((error as Error).message)) ? "no table yet" : `failed: ${(error as Error).message}`;
    }
  }
  console.log(`[retention] ${JSON.stringify(done)}`);
  return done;
};
