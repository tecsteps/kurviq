// The retired live sync's scene objects (one per Drive scene, named by its
// file id), drain only (docs/relay/CONCEPT.md "Retiring live sync"). Live
// sync kept an encrypted working copy, changes not yet in Drive and sealed
// refresh tokens here; Kurviq keeps no customer data on its servers any
// more, so each object does one last job and empties itself:
//
//   /drain   (an editor opened the scene, or its owner's tab asked for all of
//            its old scenes): what is not in Drive yet is saved, as a new
//            version if Drive still has the object's last save, else as a
//            copy next to it; then every table, the alarm and the storage go
//            (`deleteAll`). Unsaved changes nobody can save are kept (the
//            alarm tries again daily with a token the object still holds)
//            and given up 90 days after the last change, as before.
//   /forget  sign out everywhere: the account's stored tokens go
//
// Everything else is refused. It never creates a table: an object that
// never existed stays empty. The follow-up release removes the class (a
// `deleted_classes` migration) once the drain is confirmed.

import { DurableObject } from "cloudflare:workers";

import { accessFromRefresh, unsealSceneToken } from "./auth";
import type { AuthEnv } from "./auth";
import { buildSceneFile, decryptEntries, latestEntries } from "./drain";
import type { Entry } from "./drain";
import { driveCall, driveUrls, getFile, multipartBody, patchFile, problemOf, SCENE_EXTENSION, uploadVersion } from "./driveApi";
import type { DriveAnswer } from "./driveApi";
import { importSceneKey, KEY_PROPERTY, parseKeyProperty } from "../../scenes-plugin/src/online/sceneKey";

export type SceneEnv = AuthEnv & { ACCOUNT: DurableObjectNamespace };

export type DrainAnswer = { state: "empty" | "drained" | "kept"; saved?: "version" | "copy"; reason?: string; bad?: number };

const DAY_MS = 24 * 3_600_000;
/** unsaved changes nobody can save are given up after this (the old rule for blocked changes) */
const GIVE_UP_AFTER_MS = 90 * DAY_MS;
const FILE_RE = /^[A-Za-z0-9_-]{10,200}$/;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Pending = { at: number; entries: Entry[] };

export class SceneRoom extends DurableObject<SceneEnv> {
  private draining: Promise<DrainAnswer> | null = null;

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const body: any = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    if (pathname === "/drain") {
      return json(await this.drainOnce(body));
    }
    if (pathname === "/forget") {
      return json(this.forget(body));
    }
    return json({ error: "Live sync was retired: this scene saves through Google Drive now", code: "retired" }, 410);
  }

  /** a socket of an old tab (hibernated before the release): closed */
  webSocketMessage(ws: WebSocket) {
    ws.close(4000, "retired");
  }

  /** the old object's alarm (or the daily retry): drained with a token it still holds */
  async alarm() {
    const result = await this.drainOnce({});
    if (result.state === "kept") {
      await this.ctx.storage.setAlarm(Date.now() + DAY_MS);
    }
  }

  /** one drain at a time (a second call waits for the first) */
  private drainOnce(body: { fileId?: unknown; sub?: unknown; token?: unknown }) {
    this.draining ??= this.drain(body).finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  private tables() {
    return new Set(
      this.ctx.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")
        .toArray()
        .map((row) => String(row.name)),
    );
  }

  private rows(query: string, ...args: unknown[]) {
    return this.ctx.storage.sql.exec(query, ...args).toArray();
  }

  private meta(k: string): string | null {
    const row = this.rows("SELECT v FROM meta WHERE k = ?", k)[0];
    return row ? String(row.v) : null;
  }

  /** the working copy and the batches not in Drive yet (discarded ones left out) */
  private stored(tables: Set<string>) {
    const text = tables.has("snapshot") ? this.rows("SELECT data FROM snapshot ORDER BY part").map((row) => String(row.data)).join("") : "";
    const snapshot: Entry[] = text ? JSON.parse(text) : [];
    const pending: Pending[] = [];
    if (tables.has("batches")) {
      for (const row of this.rows("SELECT seq, at, state, data FROM batches ORDER BY seq")) {
        if (row.state === "discarded") {
          continue;
        }
        const raw = String(row.data) === "@chunks" ? this.rows("SELECT data FROM chunks WHERE seq = ? ORDER BY part", row.seq).map((part) => String(part.data)).join("") : String(row.data);
        pending.push({ at: Number(row.at) || 0, entries: JSON.parse(raw).entries ?? [] });
      }
    }
    return { snapshot, pending };
  }

  /** the request's token first (an editor's, for this request only), then those the object still holds */
  private async *tokens(fileId: string, body: { sub?: unknown; token?: unknown }, tables: Set<string>): AsyncGenerator<string> {
    if (typeof body.token === "string" && body.token) {
      yield body.token;
    }
    if (!tables.has("tokens") || !this.env.TOKEN_KEY) {
      return;
    }
    for (const row of this.rows("SELECT author, sealed FROM tokens WHERE expires > ?", Date.now())) {
      const sealed = await unsealSceneToken(this.env, String(row.sealed), fileId, String(row.author)).catch(() => null); // NOSONAR S9382: one at a time on purpose (stops at the first that works)
      const access = sealed ? await accessFromRefresh(this.env, sealed.r).catch(() => null) : null; // NOSONAR S9382: one at a time on purpose (stops at the first that works)
      if (access && typeof access === "object") {
        yield access.token;
      }
    }
  }

  private async drain(body: { fileId?: unknown; sub?: unknown; token?: unknown }): Promise<DrainAnswer> {
    for (const ws of this.ctx.getWebSockets()) {
      ws.close(4000, "retired");
    }
    const tables = this.tables();
    if (!tables.has("meta")) {
      return this.wipe("empty");
    }
    const fileId = this.meta("fileId") ?? (typeof body.fileId === "string" ? body.fileId : "");
    if (!FILE_RE.test(fileId)) {
      return this.wipe("empty");
    }
    const { snapshot, pending } = this.stored(tables);
    let reason = "no-token";
    for await (const token of this.tokens(fileId, body, tables)) {
      const result = pending.length ? await this.save(fileId, token, snapshot, pending) : await this.unmark(fileId, token);
      if (result.saved !== undefined || result.state === "empty") {
        return this.wipe(result.state === "empty" ? "empty" : "drained", result.saved, result.bad);
      }
      reason = result.reason ?? reason;
    }
    if (!pending.length) {
      // nothing unsaved: the file's mark is only a mark (the new app ignores it)
      return this.wipe("empty");
    }
    const newest = Math.max(...pending.map((batch) => batch.at));
    if (Date.now() - newest > GIVE_UP_AFTER_MS) {
      return this.wipe("drained", undefined, undefined, "given-up");
    }
    return { state: "kept", reason };
  }

  /** nothing unsaved: only the file's live sync mark goes */
  private async unmark(fileId: string, token: string): Promise<DrainAnswer> {
    const answer = await patchFile(this.env, token, fileId, { appProperties: { kurviqSync: null } });
    return answer.status === 200 || answer.status === 404 ? { state: "empty" } : { state: "kept", reason: problemOf(answer) };
  }

  /** what isn't in Drive yet: a new version if Drive still has the last save, else a copy next to the file */
  private async save(fileId: string, token: string, snapshot: Entry[], pending: Pending[]): Promise<DrainAnswer> {
    const file = await getFile(this.env, token, fileId, "id,name,parents,trashed,headRevisionId,appProperties");
    if (file.status !== 200) {
      return { state: "kept", reason: problemOf(file) };
    }
    const parsed = await parseKeyProperty(file.data?.appProperties?.[KEY_PROPERTY], fileId);
    if (!parsed || parsed.copy) {
      return { state: "kept", reason: "key-missing" };
    }
    const key = await importSceneKey(parsed.key, parsed.keyId, fileId);
    const { plain, bad } = await decryptEntries(key, latestEntries(snapshot, pending.map((batch) => batch.entries)));
    const built = buildSceneFile(plain);
    const bytes = new TextEncoder().encode(built.json);
    const lastSaved = JSON.parse(this.meta("lastSaved") ?? "{}");
    const driveName = String(file.data?.name ?? "Scene").replace(/\.excalidraw$/, "");
    let answer: DriveAnswer;
    let saved: "version" | "copy";
    if (!file.data?.trashed && file.data?.headRevisionId && file.data.headRevisionId === lastSaved.revision) {
      const name = built.name && built.name !== driveName ? { name: `${built.name}${SCENE_EXTENSION}` } : {};
      answer = await uploadVersion(this.env, token, fileId, { appProperties: { kurviqSync: null }, ...name }, bytes);
      saved = "version";
    } else {
      answer = await this.createCopy(token, file.data?.parents, `${driveName} (unsaved live changes)`, bytes);
      saved = "copy";
      if (answer.status === 200) {
        await patchFile(this.env, token, fileId, { appProperties: { kurviqSync: null } });
      }
    }
    if (answer.status !== 200) {
      return { state: "kept", reason: problemOf(answer) };
    }
    return { state: "drained", saved, bad };
  }

  private createCopy(token: string, parents: unknown, name: string, bytes: Uint8Array) {
    const metadata = {
      name: `${name}${SCENE_EXTENSION}`,
      ...(Array.isArray(parents) && parents.length ? { parents } : {}),
      appProperties: { kurviq: "scene", fmt: "1" },
    };
    const { body, contentType } = multipartBody(metadata, bytes);
    return driveCall(`${driveUrls(this.env).upload}/files?uploadType=multipart&fields=id&supportsAllDrives=true`, token, {
      method: "POST",
      body,
      contentType,
      timeoutMs: 90_000,
    });
  }

  /** every table, the alarm and the storage go; the answer says whether anything is left */
  private async wipe(state: "empty" | "drained", saved?: "version" | "copy", bad?: number, reason?: string): Promise<DrainAnswer & { left: number }> {
    await this.ctx.storage.deleteAlarm();
    for (const table of this.tables()) {
      this.ctx.storage.sql.exec(`DELETE FROM "${table.replaceAll('"', "")}"`);
    }
    await this.ctx.storage.deleteAll();
    const left = this.tables().size + (await this.ctx.storage.list({ limit: 1 })).size;
    return { state, ...(saved ? { saved } : {}), ...(bad ? { bad } : {}), ...(reason ? { reason } : {}), left };
  }

  /** sign out everywhere: the account's stored tokens go (its unsaved changes wait for someone else's drain) */
  private forget(body: { sub?: unknown }) {
    if (typeof body.sub === "string" && this.tables().has("tokens")) {
      this.ctx.storage.sql.exec("DELETE FROM tokens WHERE author = ?", body.sub);
    }
    return { ok: true };
  }
}
