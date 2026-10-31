// Usage statistics: anonymous counters per hour (UTC), nothing per person.
// See "Usage statistics" in CLAUDE.md (repo root) for how to read them.
//
// Server side only: counted from requests the browser makes anyway, in the
// Worker. Nothing runs in the visitor's browser for statistics (no beacons,
// no scripts, no storage).
//
//   page loads        navigations to the app's HTML (/, /<scene>, /s/…,
//                     /features) and the plain pages (imprint, privacy,
//                     terms, contact): by entry, country, device class
//   server events     live sync tickets and renewals, agent tool calls,
//                     public scene reads, feedback and contact messages,
//                     sign-ins
//
// Everything goes to one Durable Object (Stats) that adds it up in its own
// storage and writes it to D1 (stats_hourly, stats_daily) with its alarm,
// every 15 minutes while there is something to write.
//
// Never stored: IP addresses, user agents, cookies, account or scene ids,
// scene names. The country comes from Cloudflare (request.cf.country), the
// device class (desktop / mobile / tablet) is derived from the user agent and
// the user agent dropped. Visitors per day are estimated with a HyperLogLog
// over a keyed hash of IP + user agent; the key is random per UTC day and
// deleted when the day is closed, then only the estimate is kept (the hashes
// themselves are never stored, only the HLL registers until the day closes).
// Active live scenes per hour work the same way with the scene's Drive id.

import { DurableObject } from "cloudflare:workers";

// -----------------------------------------------------------------------------
// what is counted
// -----------------------------------------------------------------------------

/** the plain pages around the app (built from online/pages) */
const PLAIN_PAGES: Record<string, string> = {
  "/imprint": "imprint",
  "/privacy": "privacy",
  "/terms": "terms",
  "/contact": "contact",
};

/** Kurviq's own public scenes (scenes-plugin/src/publicScene.tsx PUBLIC_SCENES, online/scenes) */
const OWN_PUBLIC_SCENES = new Set(["features"]);

/** the agent tools (scenes-mcp/tools.mjs, excalidraw-mcp): anything else counts as "other" */
const MCP_TOOLS = new Set([
  "read_me",
  "create_view",
  "export_to_excalidraw",
  "save_checkpoint",
  "read_checkpoint",
  "add_font",
  "app_status",
  "clone_scene",
  "delete_scene",
  "edit_open_scene",
  "edit_scene",
  "export_pdf",
  "get_conflict",
  "get_scene",
  "list_scenes",
  "measure_text",
  "open_scene",
  "read_open_scene",
  "read_scene",
  "rename_scene",
  "resolve_conflict",
  "save_open_scene",
  "save_scene",
  "send_feedback",
  "set_local_only",
  "validate_deck",
  "view_scene",
]);

/** crawlers, link previews and scripts: not counted */
const BOT_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|curl|wget|python|httpclient|okhttp|go-http|java\/|headless|lighthouse|pingdom|uptime|monitor/i;

const FILE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;

// -----------------------------------------------------------------------------
// the Worker's side
// -----------------------------------------------------------------------------

type D1Statement = { bind: (...values: unknown[]) => D1Statement; run: () => Promise<unknown> };
type D1 = { prepare: (sql: string) => D1Statement; batch: (statements: D1Statement[]) => Promise<unknown> };

export type StatsEnv = {
  STATS?: DurableObjectNamespace;
  /** "on" in wrangler.jsonc; anything else switches statistics off */
  STATS_ENABLED?: string;
  /** local dev (.dev.vars has DEV_ORIGIN): off unless STATS_DEV=1 (wrangler dev --var STATS_DEV:1) */
  DEV_ORIGIN?: string;
  STATS_DEV?: string;
};

/** [metric, dim, n] */
export type Count = [string, string, number];
/** what the Worker sends to the Stats object */
export type StatsBatch = { c: Count[]; /** IP + user agent, for the visitors estimate (hashed there, never stored) */ u?: string; /** live scenes' Drive ids, for the active scenes estimate (hashed there, never stored) */ s?: string[] };

export const statsEnabled = (env: StatsEnv) => !!env.STATS && env.STATS_ENABLED === "on" && (!env.DEV_ORIGIN || env.STATS_DEV === "1");

const statsStub = (env: StatsEnv) => env.STATS!.get(env.STATS!.idFromName("stats"));

/** hand a batch to the Stats object, after the response (one Durable Object request) */
export const recordStats = (env: StatsEnv, ctx: ExecutionContext, batch: StatsBatch) => {
  if (!statsEnabled(env) || (!batch.c.length && !batch.s?.length)) {
    return;
  }
  ctx.waitUntil(
    statsStub(env)
      .fetch("https://stats/add", { method: "POST", body: JSON.stringify(batch) })
      .then((res) => res.body?.cancel())
      .catch(() => {}),
  );
};

/** count one thing */
export const countStat = (env: StatsEnv, ctx: ExecutionContext, metric: string, dim = "all") => recordStats(env, ctx, { c: [[metric, dim, 1]] });

const countryOf = (request: Request) => {
  const country = String((request as { cf?: { country?: unknown } }).cf?.country ?? "");
  return /^[A-Z][A-Z0-9]$/.test(country) ? country : "XX";
};

/** desktop / mobile / tablet, from the user agent (which is not kept) */
export const deviceOf = (ua: string) =>
  /iPad|Tablet|PlayBook|Silk|Kindle|Android(?!.*Mobi)/i.test(ua) ? "tablet" : /Mobi|iPhone|iPod|Android|Windows Phone/i.test(ua) ? "mobile" : "desktop";

const isBot = (ua: string) => !ua || BOT_RE.test(ua);

/** which page a navigation loads: the app (any scene), a shared scene, Kurviq's own public scene, a plain page */
export const entryOf = (pathname: string) => {
  const path = pathname.replace(/\.html$/, "").replace(/\/+$/, "") || "/";
  if (PLAIN_PAGES[path]) {
    return PLAIN_PAGES[path];
  }
  if (path.startsWith("/s/")) {
    return "shared";
  }
  let name = path.slice(1);
  try {
    name = decodeURIComponent(name);
  } catch {}
  return OWN_PUBLIC_SCENES.has(name) ? "features" : "app";
};

/**
 * A page load worth counting: a top-level navigation of a browser (Fetch
 * Metadata: Sec-Fetch-Mode navigate, Sec-Fetch-Dest document, or empty when
 * the service worker forwards it), not a
 * prefetch / prerender, answered with an HTML page (or 304 for a cached
 * one). Assets, API calls, the
 * service worker's own fetches, iframes and scripts never match.
 */
export const isPageLoad = (request: Request, response: Response) => {
  const headers = request.headers;
  return (
    request.method === "GET" &&
    headers.get("Sec-Fetch-Mode") === "navigate" &&
    // "empty": the page load forwarded by the app's service worker (network first, its fetch keeps
    // mode navigate but has no destination); pages can't make navigate requests themselves
    (headers.get("Sec-Fetch-Dest") === "document" || headers.get("Sec-Fetch-Dest") === "empty") &&
    !/prefetch|prerender/i.test(`${headers.get("Sec-Purpose") ?? ""} ${headers.get("Purpose") ?? ""} ${headers.get("X-Moz") ?? ""}`) &&
    // 304: the browser revalidated its cached copy of the page (a reload): a page load all the same
    (response.status === 200
      ? (response.headers.get("Content-Type") ?? "").includes("text/html")
      : response.status === 304 && !/\.(?!html$)[A-Za-z0-9]{1,8}$/.test(new URL(request.url).pathname)) &&
    !isBot(headers.get("User-Agent") ?? "")
  );
};

/** a page load: entry, country, device class, and the visitor for the daily estimate (hashed in the Stats object) */
export const pageStats = (request: Request, response: Response, env: StatsEnv, ctx: ExecutionContext) => {
  if (!statsEnabled(env) || !isPageLoad(request, response)) {
    return;
  }
  const ua = request.headers.get("User-Agent") ?? "";
  recordStats(env, ctx, {
    c: [
      ["views", entryOf(new URL(request.url).pathname), 1],
      ["views_country", countryOf(request), 1],
      ["views_device", deviceOf(ua), 1],
    ],
    u: `${request.headers.get("CF-Connecting-IP") ?? ""}\n${ua}`,
  });
};

/** a public scene read through the Worker (/api/public/<fileId>: the viewer and link previews; version polls not counted) */
export const publicReadStats = (request: Request, env: StatsEnv, ctx: ExecutionContext) => {
  const url = new URL(request.url);
  if (request.method === "GET" && /^\/api\/public\/[A-Za-z0-9_-]{10,200}$/.test(url.pathname) && !isBot(request.headers.get("User-Agent") ?? "")) {
    countStat(env, ctx, "public_reads");
  }
};

/**
 * Local tests only (wrangler dev with DEV_ORIGIN and STATS_DEV=1, never in
 * production): POST /api/stats-dev/flush?now=<ms> writes to D1 at once, as
 * the alarm would at that time (a later `now` closes today's estimates);
 * POST /api/stats-dev/retention runs the daily retention job now
 */
export const handleStatsDev = async (request: Request, env: StatsEnv, retention: () => Promise<unknown>) => {
  const url = new URL(request.url);
  if (request.method !== "POST" || !statsEnabled(env) || !env.DEV_ORIGIN || !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(`${env.DEV_ORIGIN}/`)) {
    return new Response("Not found", { status: 404 });
  }
  if (url.pathname.endsWith("/retention")) {
    return new Response(JSON.stringify(await retention()), { headers: { "Content-Type": "application/json" } });
  }
  return statsStub(env).fetch(`https://stats/flush${url.search}`, { method: "POST" });
};

/** agent tool calls, by tool name */
export const mcpStats = (env: StatsEnv, ctx: ExecutionContext, names: string[]) => {
  const counts = new Map<string, number>();
  for (const name of names) {
    const tool = MCP_TOOLS.has(name) ? name : "other";
    counts.set(tool, (counts.get(tool) ?? 0) + 1);
  }
  recordStats(env, ctx, { c: [...counts].map(([tool, n]) => ["mcp_calls", tool, n]) });
};

/** a bug report or change request was stored */
export const feedbackStats = (env: StatsEnv, ctx: ExecutionContext, source: "app" | "agent") => countStat(env, ctx, "feedback", source);

/**
 * Responses of the Worker's own routes worth counting: live sync tickets
 * (a tab connects to a live scene) and renewals (every 10 minutes while
 * connected), and completed sign-ins. Only for kurviq.com's own pages (the
 * local install is not counted).
 */
export const routeStats = (request: Request, response: Response, env: StatsEnv, ctx: ExecutionContext) => {
  if (!statsEnabled(env) || response.status >= 400) {
    return;
  }
  const url = new URL(request.url);
  if (url.pathname === "/auth/callback") {
    // the app's sign-in (the local install's goes back with a fragment, not ?google=)
    const done = (response.headers.get("Location") ?? "").match(/[?&]google=(connected|nodrive)\b/);
    if (done) {
      countStat(env, ctx, "sign_ins", done[1] === "connected" ? "drive" : "nodrive");
    }
    return;
  }
  const scene = url.pathname.match(/^\/scene\/([^/]+)\/(ticket|renew)$/);
  if (!scene || request.method !== "POST" || response.status !== 200 || !FILE_ID_RE.test(scene[1]) || request.headers.get("Origin") !== url.origin) {
    return;
  }
  if (scene[2] === "renew") {
    recordStats(env, ctx, { c: [["live_minutes", "all", 10]], s: [scene[1]] });
    return;
  }
  // a ticket only counts when live sync is on for the scene
  const copy = response.clone();
  ctx.waitUntil(
    copy
      .json()
      .then((body: any) => {
        if (body?.enabled === true) {
          recordStats(env, ctx, { c: [["live_sessions", "all", 1]], s: [scene[1]] });
        }
      })
      .catch(() => {}),
  );
};

// -----------------------------------------------------------------------------
// HyperLogLog
// -----------------------------------------------------------------------------

/** register index and rank of a 64-bit hash (the first 8 bytes) for 2^p registers */
export const hllPosition = (hash: Uint8Array, p: number) => {
  const view = new DataView(hash.buffer, hash.byteOffset, 8);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const index = hi >>> (32 - p);
  const restHi = (hi << p) >>> 0;
  const rank = restHi !== 0 ? Math.clz32(restHi) + 1 : 32 - p + (lo !== 0 ? Math.clz32(lo) + 1 : 33);
  return { index, rank };
};

/** the HLL estimate of the registers (with linear counting for small numbers) */
export const hllEstimate = (registers: Uint8Array) => {
  const m = registers.length;
  let sum = 0;
  let zeros = 0;
  for (const rank of registers) {
    sum += 2 ** -rank;
    if (rank === 0) {
      zeros++;
    }
  }
  const alpha = 0.7213 / (1 + 1.079 / m);
  const raw = (alpha * m * m) / sum;
  return Math.round(raw <= 2.5 * m && zeros > 0 ? m * Math.log(m / zeros) : raw);
};

// -----------------------------------------------------------------------------
// the Durable Object
// -----------------------------------------------------------------------------

/** register bits per estimate: 2^12 registers ≈ 1.6 % error, 2^10 ≈ 3.3 % */
const HLL_BITS: Record<string, number> = { visitors: 12, scenes_day: 12, scenes_hour: 10 };
const FLUSH_MS = 15 * 60_000;
/** D1 takes at most 100 bound values per statement: 25 rows of 4 */
const ROWS_PER_INSERT = 25;

const hourOf = (time: number) => new Date(time).toISOString().slice(0, 13);
const dayOf = (time: number) => new Date(time).toISOString().slice(0, 10);

/** an estimate's period "<kind>|<day or hour>" and when it ends */
const periodEnd = (period: string) => {
  const [, at] = period.split("|");
  return at.length === 10 ? Date.parse(`${at}T00:00:00Z`) + 86_400_000 : Date.parse(`${at}:00:00Z`) + 3_600_000;
};

const D1_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS stats_hourly (hour TEXT NOT NULL, metric TEXT NOT NULL, dim TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY (hour, metric, dim)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS stats_daily (day TEXT NOT NULL, metric TEXT NOT NULL, dim TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY (day, metric, dim)) WITHOUT ROWID`,
];

/** STATS_FLUSH_MS: a shorter flush interval for local tests (only with a local DEV_ORIGIN) */
type StatsDoEnv = { FEEDBACK?: D1; DEV_ORIGIN?: string; STATS_FLUSH_MS?: string };

export class Stats extends DurableObject<StatsDoEnv> {
  private sql: SqlStorage;
  private registers = new Map<string, Uint8Array>();
  private keys = new Map<string, Promise<CryptoKey>>();
  private alarmAt: number | null | undefined;
  private d1Ready = false;
  private flushMs = FLUSH_MS;
  /** the hour estimates were last closed in (closing again only when it changes) */
  private closedAt = "";

  constructor(ctx: DurableObjectState, env: StatsDoEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    if (/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(`${env.DEV_ORIGIN ?? ""}/`) && Number(env.STATS_FLUSH_MS) >= 1_000) {
      this.flushMs = Number(env.STATS_FLUSH_MS);
    }
    this.sql.exec(`CREATE TABLE IF NOT EXISTS pending (hour TEXT NOT NULL, metric TEXT NOT NULL, dim TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY (hour, metric, dim)) WITHOUT ROWID`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS hll (period TEXT NOT NULL, idx INTEGER NOT NULL, rank INTEGER NOT NULL, PRIMARY KEY (period, idx)) WITHOUT ROWID`);
    // the day's random key for the hashes; deleted when the day is closed
    this.sql.exec(`CREATE TABLE IF NOT EXISTS day_key (day TEXT PRIMARY KEY, key BLOB NOT NULL)`);
    // daily estimates of closed days, until they are in D1 (the hourly one goes to pending)
    this.sql.exec(`CREATE TABLE IF NOT EXISTS pending_daily (day TEXT NOT NULL, metric TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY (day, metric)) WITHOUT ROWID`);
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/add") {
      await this.add((await request.json()) as StatsBatch);
      return new Response(null, { status: 204 });
    }
    // tests: write everything to D1 now (closing finished periods), as the alarm does
    if (request.method === "POST" && url.pathname === "/flush") {
      const now = Number(url.searchParams.get("now")) || Date.now();
      await this.flush(now);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }
    return new Response("Not found", { status: 404 });
  }

  async alarm() {
    this.alarmAt = null;
    await this.flush(Date.now());
  }

  private async add(batch: StatsBatch) {
    const now = Date.now();
    const hour = hourOf(now);
    // a new hour (or day): finished estimates are closed first, without waiting for the alarm
    if (hour !== this.closedAt) {
      this.closePeriods(now);
    }
    for (const [metric, dim, n] of Array.isArray(batch?.c) ? batch.c.slice(0, 40) : []) {
      if (typeof metric === "string" && typeof dim === "string" && Number.isInteger(n) && n > 0 && n <= 1000) {
        this.sql.exec(
          `INSERT INTO pending (hour, metric, dim, value) VALUES (?, ?, ?, ?) ON CONFLICT (hour, metric, dim) DO UPDATE SET value = value + excluded.value`,
          hour,
          metric.slice(0, 40),
          dim.slice(0, 40),
          n,
        );
      }
    }
    const day = dayOf(now);
    if (typeof batch?.u === "string" && batch.u.length <= 2000) {
      await this.hllAdd(`visitors|${day}`, day, `visitor\n${batch.u}`);
    }
    for (const fileId of Array.isArray(batch?.s) ? batch.s.slice(0, 5) : []) {
      if (typeof fileId === "string" && FILE_ID_RE.test(fileId)) {
        await this.hllAdd(`scenes_hour|${hour}`, day, `scene\n${hour}\n${fileId}`);
        await this.hllAdd(`scenes_day|${day}`, day, `scene\n${fileId}`);
      }
    }
    // an alarm within 15 minutes covers everything just added (it reschedules itself)
    if (this.alarmAt == null || this.alarmAt > now + this.flushMs) {
      await this.schedule(now);
    }
  }

  /** the day's key: random, kept only until the day is closed */
  private dayKey(day: string) {
    let key = this.keys.get(day);
    if (!key) {
      const row = this.sql.exec<{ key: ArrayBuffer }>(`SELECT key FROM day_key WHERE day = ?`, day).toArray()[0];
      let raw: ArrayBuffer;
      if (row) {
        raw = row.key;
      } else {
        raw = crypto.getRandomValues(new Uint8Array(32)).buffer;
        this.sql.exec(`INSERT INTO day_key (day, key) VALUES (?, ?)`, day, raw);
      }
      key = crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      this.keys.set(day, key);
    }
    return key;
  }

  private registersOf(period: string) {
    let registers = this.registers.get(period);
    if (!registers) {
      const kind = period.split("|")[0];
      registers = new Uint8Array(2 ** HLL_BITS[kind]);
      for (const { idx, rank } of this.sql.exec<{ idx: number; rank: number }>(`SELECT idx, rank FROM hll WHERE period = ?`, period)) {
        registers[idx] = rank;
      }
      this.registers.set(period, registers);
    }
    return registers;
  }

  /** count a value into an estimate: only the register it touches is kept, never the value or its hash */
  private async hllAdd(period: string, day: string, value: string) {
    const hash = new Uint8Array(await crypto.subtle.sign("HMAC", await this.dayKey(day), new TextEncoder().encode(value)));
    const { index, rank } = hllPosition(hash, HLL_BITS[period.split("|")[0]]);
    const registers = this.registersOf(period);
    if (rank > registers[index]) {
      registers[index] = rank;
      this.sql.exec(`INSERT INTO hll (period, idx, rank) VALUES (?, ?, ?) ON CONFLICT (period, idx) DO UPDATE SET rank = excluded.rank`, period, index, rank);
    }
  }

  /** the next alarm: in 15 minutes with counts to write, else when the next estimate's period ends */
  private async schedule(now: number) {
    if (this.alarmAt === undefined) {
      this.alarmAt = await this.ctx.storage.getAlarm();
    }
    const pending =
      this.sql.exec(`SELECT 1 FROM pending LIMIT 1`).toArray().length > 0 || this.sql.exec(`SELECT 1 FROM pending_daily LIMIT 1`).toArray().length > 0;
    const periods = this.sql.exec<{ period: string }>(`SELECT DISTINCT period FROM hll`).toArray();
    const keys = this.sql.exec(`SELECT 1 FROM day_key LIMIT 1`).toArray().length > 0;
    let at = pending ? now + this.flushMs : Infinity;
    for (const { period } of periods) {
      at = Math.min(at, periodEnd(period) + 5_000);
    }
    if (keys && at === Infinity) {
      at = Date.parse(`${dayOf(now)}T00:00:00Z`) + 86_400_000 + 5_000;
    }
    if (at === Infinity) {
      return;
    }
    at = Math.max(at, now + 1_000);
    if (this.alarmAt == null || this.alarmAt > at) {
      await this.ctx.storage.setAlarm(at);
      this.alarmAt = at;
    }
  }

  private async d1() {
    const db = this.env.FEEDBACK;
    if (!db) {
      throw new Error("no D1 database (FEEDBACK)");
    }
    if (!this.d1Ready) {
      await db.batch(D1_SCHEMA.map((sql) => db.prepare(sql)));
      this.d1Ready = true;
    }
    return db;
  }

  /** closes finished estimates and writes the counts to D1; what fails is kept for the next alarm */
  /**
   * Finished periods: the estimate is computed and kept (pending, for D1),
   * the registers are deleted, and so are the keys of days that are over.
   * No D1 involved: this happens at the end of the day (the alarm, or the
   * first request after it) even while D1 is unreachable.
   */
  private closePeriods(now: number) {
    const periods = this.sql.exec<{ period: string }>(`SELECT DISTINCT period FROM hll`).toArray();
    for (const { period } of periods) {
      if (periodEnd(period) > now) {
        continue;
      }
      const [kind, at] = period.split("|");
      const value = hllEstimate(this.registersOf(period));
      if (kind === "scenes_hour") {
        this.sql.exec(
          `INSERT INTO pending (hour, metric, dim, value) VALUES (?, 'scenes_active', 'all', ?) ON CONFLICT (hour, metric, dim) DO UPDATE SET value = value + excluded.value`,
          at,
          value,
        );
      } else {
        this.sql.exec(
          `INSERT INTO pending_daily (day, metric, value) VALUES (?, ?, ?) ON CONFLICT (day, metric) DO UPDATE SET value = excluded.value`,
          at,
          kind === "visitors" ? "visitors" : "scenes_active",
          value,
        );
      }
      this.sql.exec(`DELETE FROM hll WHERE period = ?`, period);
      this.registers.delete(period);
    }
    const today = dayOf(now);
    this.sql.exec(`DELETE FROM day_key WHERE day < ?`, today);
    for (const day of [...this.keys.keys()]) {
      if (day < today) {
        this.keys.delete(day);
      }
    }
    this.closedAt = hourOf(now);
  }

  private async flush(now: number) {
    this.closePeriods(now);
    try {
      const db = await this.d1();
      // estimates of closed days / hours that wait for D1 (their registers and keys are gone already)
      const daily = this.sql.exec<{ day: string; metric: string; value: number }>(`SELECT day, metric, value FROM pending_daily`).toArray();
      if (daily.length) {
        await db.batch(
          daily.map((row) =>
            db
              .prepare(`INSERT INTO stats_daily (day, metric, dim, value) VALUES (?, ?, 'all', ?) ON CONFLICT (day, metric, dim) DO UPDATE SET value = excluded.value`)
              .bind(row.day, row.metric, row.value),
          ),
        );
        for (const row of daily) {
          this.sql.exec(`DELETE FROM pending_daily WHERE day = ? AND metric = ?`, row.day, row.metric);
        }
      }
      // the counts: taken out at once (no await in between), back in if D1 fails
      const rows = this.sql.exec<{ hour: string; metric: string; dim: string; value: number }>(`SELECT hour, metric, dim, value FROM pending`).toArray();
      this.sql.exec(`DELETE FROM pending`);
      try {
        const statements = [];
        for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
          const chunk = rows.slice(i, i + ROWS_PER_INSERT);
          statements.push(
            db
              .prepare(
                `INSERT INTO stats_hourly (hour, metric, dim, value) VALUES ${chunk.map(() => "(?, ?, ?, ?)").join(", ")} ON CONFLICT (hour, metric, dim) DO UPDATE SET value = stats_hourly.value + excluded.value`,
              )
              .bind(...chunk.flatMap((row) => [row.hour, row.metric, row.dim, row.value])),
          );
        }
        if (statements.length) {
          await db.batch(statements);
        }
      } catch (error) {
        for (const row of rows) {
          this.sql.exec(
            `INSERT INTO pending (hour, metric, dim, value) VALUES (?, ?, ?, ?) ON CONFLICT (hour, metric, dim) DO UPDATE SET value = value + excluded.value`,
            row.hour,
            row.metric,
            row.dim,
            row.value,
          );
        }
        throw error;
      }
    } catch (error) {
      console.warn(`[stats] flush failed, retrying with the next alarm: ${(error as Error).message}`);
      if (this.alarmAt === undefined) {
        this.alarmAt = await this.ctx.storage.getAlarm();
      }
      if (this.alarmAt == null) {
        this.alarmAt = Date.now() + this.flushMs;
        await this.ctx.storage.setAlarm(this.alarmAt);
      }
      return;
    }
    await this.schedule(Math.max(now, Date.now()));
  }
}
