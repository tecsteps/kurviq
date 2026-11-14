// One Durable Object per account (Google's `sub`), strongly consistent where
// D1 is not:
//
//   - the revocation epoch: "sign out everywhere" ends every session and
//     relay ticket issued before it (kept: an account id and a time, no data)
//   - until the retired live sync is drained (docs/relay/CONCEPT.md
//     "Retiring live sync"): the ids of the old scene objects that may still
//     hold this account's token or changes. The drain (/live/drain) asks for
//     them and drops each one it emptied; no new ones are added.
//   - revocations to deliver: each old scene object is told (its tokens of
//     this account go) until it confirmed, retried with this object's alarm
//
// No content, no tokens: file ids, the account id and timestamps, each with
// a bound (pruned by the alarm):
//   old scene entries     until drained, at most 5 hours after they were last added (the old token lease)
//   the epoch, the account id 400 days (the longest a session from before could be presented), then all is gone
//   revocations           until delivered (retried every minute)
// Never a Google token: a revocation at Google is tried within the sign-out
// request only (./sceneRoutes.ts). Objects that kept one for a later try (the
// meta key `revoke`, before 2026-11-13) drop it when they next start.

import { DurableObject } from "cloudflare:workers";

import type { AuthEnv } from "./auth";

const FILE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
const CONNECTED_KEPT_MS = 3_600_000;
const TOKEN_ENTRY_KEPT_MS = 5 * 3_600_000;
const EPOCH_KEPT_MS = 400 * 24 * 3_600_000;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type AccountEnv = AuthEnv & { SCENE: DurableObjectNamespace };

export class AccountGuard extends DurableObject<AccountEnv> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: AccountEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS scenes (id TEXT PRIMARY KEY, at INTEGER) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS connected (id TEXT PRIMARY KEY, at INTEGER) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS revocations (id TEXT PRIMARY KEY, epoch INTEGER) WITHOUT ROWID;
    `);
    // migration: a sealed refresh token kept for a later revocation at Google goes (no tokens on our servers)
    this.sql.exec("DELETE FROM meta WHERE k = 'revoke'");
  }

  private metaValue(k: string) {
    return this.sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray()[0]?.v as string | undefined;
  }

  private epoch() {
    return Number(this.metaValue("epoch") ?? 0);
  }

  /** the next prune: when the oldest entry runs out */
  private async planPrune() {
    const times: number[] = [];
    const add = (value: unknown, kept: number) => value !== null && value !== undefined && times.push(Number(value) + kept);
    add(this.sql.exec("SELECT MIN(at) AS at FROM connected").toArray()[0]?.at, CONNECTED_KEPT_MS);
    add(this.sql.exec("SELECT MIN(at) AS at FROM scenes").toArray()[0]?.at, TOKEN_ENTRY_KEPT_MS);
    if (this.epoch()) {
      add(this.epoch(), EPOCH_KEPT_MS);
    }
    if (this.sql.exec("SELECT 1 FROM revocations LIMIT 1").toArray().length) {
      times.push(Date.now() + 60_000);
    }
    const current = await this.ctx.storage.getAlarm();
    const next = times.length ? Math.min(...times) : null;
    if (next !== null && (current === null || next < current)) {
      await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 10));
    }
  }

  private prune() {
    const now = Date.now();
    this.sql.exec("DELETE FROM connected WHERE at < ?", now - CONNECTED_KEPT_MS);
    this.sql.exec("DELETE FROM scenes WHERE at < ?", now - TOKEN_ENTRY_KEPT_MS);
    if (this.epoch() && now - this.epoch() > EPOCH_KEPT_MS && !this.sql.exec("SELECT 1 FROM revocations LIMIT 1").toArray().length) {
      this.sql.exec("DELETE FROM meta WHERE k IN ('epoch', 'sub')");
    }
  }

  /** the old scene objects this account may still have something in */
  private oldScenes() {
    return this.sql
      .exec("SELECT id FROM scenes UNION SELECT id FROM connected")
      .toArray()
      .map((row) => String(row.id));
  }

  private async logoutAll(body: any): Promise<Response> {
    if (typeof body.sub !== "string" || !body.sub) {
      return json({ error: "no account" }, 400);
    }
    // strictly later than every session issued so far (sessions carry their sign-in time)
    const epoch = Math.max(Date.now(), this.epoch() + 1);
    const scenes = this.oldScenes();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('epoch', ?)", String(epoch));
      this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('sub', ?)", body.sub);
      for (const id of scenes) {
        this.sql.exec("INSERT OR REPLACE INTO revocations (id, epoch) VALUES (?, ?)", id, epoch);
      }
      this.sql.exec("DELETE FROM scenes");
      this.sql.exec("DELETE FROM connected");
    });
    await this.ctx.storage.setAlarm(Date.now());
    return json({ epoch, scenes });
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const body: any = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    const fileOk = typeof body.fileId === "string" && FILE_ID_RE.test(body.fileId);
    if (pathname === "/epoch") {
      return json({ epoch: this.epoch() });
    }
    if (pathname === "/scenes-list") {
      this.prune();
      return json({ scenes: this.oldScenes() });
    }
    if (pathname === "/scene-drained") {
      if (!fileOk) {
        return json({ error: "bad file id" }, 400);
      }
      this.sql.exec("DELETE FROM scenes WHERE id = ?", body.fileId);
      this.sql.exec("DELETE FROM connected WHERE id = ?", body.fileId);
      return json({ ok: true });
    }
    if (pathname === "/logout-all") {
      return this.logoutAll(body);
    }
    return json({ error: "Not found" }, 404);
  }

  /** revocations, delivered until each old scene object confirmed; then the prune */
  async alarm() {
    const sub = this.metaValue("sub");
    for (const row of this.sql.exec("SELECT id, epoch FROM revocations").toArray()) {
      try {
        const stub = this.env.SCENE.get(this.env.SCENE.idFromName(String(row.id)));
        const res = await stub.fetch("https://scene/forget", { // NOSONAR S9382: in order on purpose (preserves rendering or server operation order)
          method: "POST",
          body: JSON.stringify({ fileId: row.id, sub, epoch: row.epoch }),
        });
        if (res.ok) {
          this.sql.exec("DELETE FROM revocations WHERE id = ?", row.id);
        }
      } catch {}
    }
    this.prune();
    await this.planPrune();
  }
}
