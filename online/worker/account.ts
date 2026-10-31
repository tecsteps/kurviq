// Live sync: one Durable Object per account (Google's `sub`), strongly
// consistent where D1 is not:
//
//   - the revocation epoch: "sign out everywhere" ends every session, ticket,
//     access proof and stored token issued before it
//   - the index of scenes holding this account's stored refresh token, and
//     of scenes it is connected to: a scene registers a connection here
//     before accepting it (refused if the sign-in predates the epoch), so
//     signing out everywhere finds every stored copy and every open connection
//   - revocations to deliver: each scene is told (its tokens and connections
//     of this account go) until it confirmed, retried with this object's alarm
//
// No content, no tokens: file ids, the account id and timestamps, each with
// a bound (pruned by the alarm):
//   connected-scene entries   1 hour after the last registration or renewal (renewals come every 10 minutes)
//   stored-token entries      5 hours after the last one (a stored token's lease ends 4 hours after its last renewal)
//   the epoch, the account id 400 days (the longest a session from before could be presented), then all is gone
//   revocations               until delivered (retried every minute)
//   a refresh token to revoke at Google (sealed with TOKEN_KEY), when sign out everywhere couldn't:
//                             until Google confirmed, at most 30 days (retried every minute)

import { DurableObject } from "cloudflare:workers";

import { devGate, revokeAtGoogle, unsealSceneToken } from "./auth";
import type { AuthEnv } from "./auth";

const FILE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
const CONNECTED_KEPT_MS = 3600_000;
const TOKEN_ENTRY_KEPT_MS = 5 * 3600_000;
const EPOCH_KEPT_MS = 400 * 24 * 3600_000;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type AccountEnv = AuthEnv & { SCENE: DurableObjectNamespace };

export class AccountGuard extends DurableObject<AccountEnv> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: AccountEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS scenes (id TEXT PRIMARY KEY, at INTEGER) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS connected (id TEXT PRIMARY KEY, at INTEGER) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS revocations (id TEXT PRIMARY KEY, epoch INTEGER) WITHOUT ROWID;
    `);
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
    if (this.sql.exec("SELECT 1 FROM revocations LIMIT 1").toArray().length || this.metaValue("revoke")) {
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

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const body: any = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    const fileOk = typeof body.fileId === "string" && FILE_ID_RE.test(body.fileId);
    if (pathname === "/epoch") {
      // a renewal of a connected tab also keeps its index entries fresh (they run out without)
      if (fileOk && body.touch) {
        this.sql.exec("UPDATE connected SET at = ? WHERE id = ?", Date.now(), body.fileId);
        this.sql.exec("UPDATE scenes SET at = ? WHERE id = ?", Date.now(), body.fileId);
      }
      return json({ epoch: this.epoch() });
    }
    if (pathname === "/scene-connect") {
      // the scene asks before it accepts a connection: refused for a sign-in older than the epoch
      if (!fileOk) {
        return json({ error: "bad file id" }, 400);
      }
      const epoch = this.epoch();
      if (epoch && !(Number(body.iat) >= epoch)) {
        return json({ ok: false, epoch });
      }
      this.sql.exec("INSERT OR REPLACE INTO connected (id, at) VALUES (?, ?)", body.fileId, Date.now());
      await this.planPrune();
      return json({ ok: true });
    }
    const ops: Record<string, string> = {
      "/scene-add": "INSERT OR REPLACE INTO scenes (id, at) VALUES (?, ?)",
      "/scene-remove": "DELETE FROM scenes WHERE id = ?",
      "/scene-disconnect": "DELETE FROM connected WHERE id = ?",
    };
    if (ops[pathname]) {
      if (!fileOk) {
        return json({ error: "bad file id" }, 400);
      }
      if (pathname === "/scene-add") {
        this.sql.exec(ops[pathname], body.fileId, Date.now());
        await this.planPrune();
      } else {
        this.sql.exec(ops[pathname], body.fileId);
      }
      return json({ ok: true });
    }
    if (pathname === "/logout-all") {
      if (typeof body.sub !== "string" || !body.sub) {
        return json({ error: "no account" }, 400);
      }
      // strictly later than every session issued so far (sessions carry their sign-in time)
      const epoch = Math.max(Date.now(), this.epoch() + 1);
      const scenes = this.sql
        .exec("SELECT id FROM scenes UNION SELECT id FROM connected")
        .toArray()
        .map((row) => String(row.id));
      this.ctx.storage.transactionSync(() => {
        this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('epoch', ?)", String(epoch));
        this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('sub', ?)", body.sub);
        if (typeof body.retryRevoke === "string") {
          this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('revoke', ?)", body.retryRevoke);
        }
        for (const id of scenes) {
          this.sql.exec("INSERT OR REPLACE INTO revocations (id, epoch) VALUES (?, ?)", id, epoch);
        }
        this.sql.exec("DELETE FROM scenes");
        this.sql.exec("DELETE FROM connected");
      });
      await this.ctx.storage.setAlarm(Date.now());
      return json({ epoch, scenes });
    }
    // tests with the fake Google only: everything stored gets older by `ms`, then pruned
    if (pathname === "/dev-age" && devGate(this.env)) {
      const ms = Number(body.ms) || 0;
      this.sql.exec("UPDATE connected SET at = at - ?", ms);
      this.sql.exec("UPDATE scenes SET at = at - ?", ms);
      if (this.epoch()) {
        this.sql.exec("UPDATE meta SET v = ? WHERE k = 'epoch'", String(this.epoch() - ms));
      }
      this.prune();
      return json({
        epoch: this.epoch(),
        connected: this.sql.exec("SELECT COUNT(*) AS n FROM connected").toArray()[0]?.n,
        scenes: this.sql.exec("SELECT COUNT(*) AS n FROM scenes").toArray()[0]?.n,
        sub: !!this.metaValue("sub"),
      });
    }
    return json({ error: "Not found" }, 404);
  }

  /** revocations, delivered until each scene confirmed; then the prune */
  async alarm() {
    const sub = this.metaValue("sub");
    for (const row of this.sql.exec("SELECT id, epoch FROM revocations").toArray()) {
      try {
        const stub = this.env.SCENE.get(this.env.SCENE.idFromName(String(row.id)));
        const res = await stub.fetch("https://scene/forget", {
          method: "POST",
          body: JSON.stringify({ fileId: row.id, sub, epoch: row.epoch }),
        });
        if (res.ok) {
          this.sql.exec("DELETE FROM revocations WHERE id = ?", row.id);
        }
      } catch {}
    }
    // a revocation at Google that didn't go through: tried again until it does (or the sealed copy ran out)
    const revoke = this.metaValue("revoke");
    if (revoke && sub) {
      const sealed = await unsealSceneToken(this.env, revoke, "revoke-at-google", sub);
      if (!sealed || (await revokeAtGoogle(this.env, sealed.r))) {
        this.sql.exec("DELETE FROM meta WHERE k = 'revoke'");
      }
    }
    this.prune();
    await this.planPrune();
  }
}
