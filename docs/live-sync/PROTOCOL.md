# Live sync: implementation contract

The concept (`CONCEPT.md`, exported from the Claude Doc) says *what* and *why*.
This file says *how*: modules, wire messages, storage, and who owns what. All
parts of the build follow it; when code and this file disagree, fix one of them
in the same change.

Shared types live in `scenes-plugin/src/online/liveProtocol.ts` (imported by the
app and the Worker, like `frames.ts`).

## 1. Modules

| Part | Files | Notes |
| --- | --- | --- |
| Shared contract | `scenes-plugin/src/online/liveProtocol.ts` | types, readable-field split, limits, constants |
| Google endpoints | `online/worker/google.ts` | OAuth and Drive base URLs from env (real Google by default, the fake one in dev) |
| Scene DO | `online/worker/scene.ts` (`SceneRoom`) | one per Drive file id; ordering, storage, fan-out, saving, merging |
| Account DO | `online/worker/account.ts` (`AccountGuard`) | one per account (`sub`): revocation epoch, index of scenes holding this account's token |
| Routes | `online/worker/sceneRoutes.ts` | tickets, proofs, WebSocket upgrade, Drive webhook, reconcile tokens |
| Sign-in | `online/worker/auth.ts` | `sub` in the session, expiry for sealed local sessions, helpers to seal a refresh token for a scene |
| Public viewer cache | `online/worker/shared.ts` | 60 s, no stale serving |
| Client engine | `scenes-plugin/src/online/liveSync.ts` | one `LiveScene` per open Drive scene: connection, handshake, two layers, batching, rebase, offline copies |
| Client crypto | `scenes-plugin/src/online/liveCrypto.ts` | AES-GCM per element, split/merge of readable fields |
| Client queue | `scenes-plugin/src/online/liveQueue.ts` | IndexedDB queue keyed by account, file, tab, counter |
| Integration | `scenes-plugin/src/controller.ts` (+ small UI bits) | Drive scenes with live sync never push/pull/merge directly; status from the engine |
| Dev harness | `online/worker/fakeGoogle.ts` (`FakeGoogle` DO) | fake OAuth + Drive v3 subset for local QA, only when `FAKE_GOOGLE=1` |

## 2. Switch

`LIVE_SYNC` (Worker var): `off` | `all` | comma-separated list of emails.
A file that already carries `appProperties.kurviqSync = "do-1"` is always live,
for every Kurviq client of version ≥ protocol 1 (so collaborators of a pilot
scene don't write it directly). The ticket answer says `{ enabled: false }`
otherwise, and the client keeps today's sync.

## 3. Worker routes

All POSTs accept the sign-in cookie, or `{ session }` in the body from the local
install (CORS like `/auth/token`). Errors are JSON `{ error, code }`.

### `POST /scene/:fileId/ticket` → `TicketAnswer`

1. Session → fresh access token (refresh if < 10 min left; on Google 5xx/timeouts → 503 `google-unreachable`).
2. AccountGuard: session must be newer than the account's revocation epoch.
3. Drive `files.get(fileId, fields=id,name,trashed,headRevisionId,md5Checksum,capabilities(canEdit),appProperties)`.
   404/403 → `{ code: "no-access" }` (the UI explains `drive.file` and offers the Picker).
4. Switch check (§2). If off → `{ enabled: false }`.
5. Role = `edit` if `canEdit` else `read`.
6. Key: if `appProperties.kurviqKey` is missing and role is `edit` → key creation
   under the DO's lease (`POST /key-lease` → lease id or `held`; read property;
   if still missing write a new random 256-bit key with its fingerprint and the
   file id; `POST /key-done`). A key whose file id differs from `fileId` (a copy)
   is replaced the same way. A viewer without a key gets `{ code: "no-key-yet" }`
   and reads the saved file instead.
7. Answer: `ticket` (sealed, 60 s, single-use nonce, file id, sub, role, name,
   pseudonym, head revision + md5, sealed refresh token for editors), `proof`
   (sealed, 15 min, same claims minus token), `role`, `key` (base64), `keyId`,
   `pseudonym`, `head: { revision, md5 }`, `name`, `protocol: 1`, `enabled: true`.

### `GET /scene/:fileId/live?ticket=…` (WebSocket)

Worker unseals and checks the ticket (expiry, file id, protocol), the DO marks the
nonce used, then the upgrade is forwarded with headers `X-Kurviq-Claims`
(JSON of the claims). Origin must be this site or a local-install origin.

### `POST /scene/:fileId/renew` → `{ proof, expiresAt }`

Same checks as the ticket (session, epoch, Drive capabilities, plus name,
trashed, head revision). Forwards to the DO (`/renew`: tab, role, proof expiry,
sealed token for editors, name, trashed, head). Called every 10 minutes and when
the DO sends `renew-now`. On Google 5xx/timeouts the Worker extends the proof
(never past 2 h after the last successful check, never after a refusal, never
across a revocation epoch).

### `POST /scene/:fileId/reconcile` → `{ ok }`

Called by a tab after `need-token`: the Worker mints a one-time access token and
passes it to the DO (`/reconcile-token`), memory only.

### `POST /drive/notify` (webhook)

Checks `X-Goog-Channel-Token` (the channel secret the DO stored) and
`X-Goog-Resource-Id`; forwards `{ state, changed }` to the DO. `sync` messages are
acknowledged and dropped.

### `POST /auth/logout-all`

Raises the account's revocation epoch, revokes Kurviq at Google, asks every scene
DO in the account's index to delete that account's tokens.

## 4. WebSocket messages

Framed with `frames.ts` (`sendMessage` / `createReceiver`). Pings: `"ping"` →
`"pong"` auto-response.

Client → DO:

- `hello { protocol, tab, openToken, revision, seq, generation }`
- `batch { counter, live, made, base?: number /*own pending batch*/, events: WireEvent[] }`
- `seed { revision, md5, scene: WireScene }` (only after `welcome.mode === "seed"`)
- `decide { author, action: "accept" | "discard" }`
- `presence { activeAt }`

DO → client:

- `welcome { mode: "events" | "state" | "seed" | "wait", seq, generation, events?, state?: WireScene, keyId, role, lifecycle, presence, pending }`
- `ack { counter, seq, stamps: Record<id, { v, n }> }`
- `refused { counter, reason, current: WireEvent[] }` — reasons: `collision`, `reference`, `limit`, `key`, `role`, `lifecycle`, `discarded`, `font-id`, `invalid`
- `events { seq, author, pseudonym, name, tab, via, origin: "user" | "outside" | "repair", events: WireEvent[] }`
- `saved { revision, md5, receipts: Record<tab, Receipt>, at }`
- `status { stage, blocked: BlockedAuthor[], error?, lifecycle, presence }`
- `renew-now`, `need-token`, `closed { reason }`

`WireEvent = { k: "el" | "set" | "file" | "font" | "name", id, base: Base | null, r: Readable, c: string /*base64 iv+ciphertext*/ }`.
`Base = { v: number, n: number }`. `Readable` (elements) = `id, type, version,
versionNonce, isDeleted, index, boundIds, containerId, startId, endId, frameId,
groupIds, fileId, fontFamily`. Everything else of the element is in `c`.

## 5. DO storage (SQLite)

```
meta(k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID          -- generation, seq, lifecycle, epoch, lastSaved, keyFp, channel, …
batches(seq INTEGER PRIMARY KEY, tab TEXT, counter INTEGER, author TEXT, via TEXT,
        live INTEGER, at INTEGER, state TEXT, data TEXT) -- state: pending|blocked|saved|discarded
snapshot(part INTEGER PRIMARY KEY, data TEXT)            -- encrypted readable+cipher per element, ≤ 1.5 MB per part
tabs(tab TEXT PRIMARY KEY, author TEXT, mark INTEGER, extra TEXT, seen INTEGER) WITHOUT ROWID
tokens(author TEXT PRIMARY KEY, sealed TEXT, expires INTEGER) WITHOUT ROWID
saves(op TEXT PRIMARY KEY, state TEXT, batches TEXT, md5 TEXT, base TEXT, author TEXT, at INTEGER) WITHOUT ROWID
schedule(kind TEXT PRIMARY KEY, at INTEGER) WITHOUT ROWID
losers(id TEXT PRIMARY KEY, author TEXT, data TEXT, until INTEGER) WITHOUT ROWID
```

Current state (id → readable + cipher + last author + seq) is held in memory and
rebuilt from `snapshot` + `batches` when the object wakes.

## 6. Saving

Alarm-driven, one upload at a time, groups from the per-author walk (concept
"Saving"). Per upload: token → access token; key from `appProperties` (once per
round); decrypt the base snapshot and the group's events; build the file
(below); record `saves(prepared)`; multipart PATCH (media + `appProperties.kurviqSync`);
on success one transaction: snapshot updated, batch rows `saved`→deleted,
receipts, `saves(done)`; broadcast `saved`.

File format: `{ type: "excalidraw", version: 2, source: "https://kurviq.com",
elements, appState: { viewBackgroundColor, gridSize, gridStep, gridModeEnabled },
files, kurviqFonts?, kurviq: { v: 1, op, receipts, authors: Record<id, pseudonym>,
onBehalf: [] } }`.

## 7. Client engine

`LiveScene` (one per open Drive scene, also headless for agent edits):

- `start()` → ticket → connect → `hello` → `welcome` → apply.
- `onLocalChange(elements, appState, files)` → diff against confirmed + pending →
  queue (IndexedDB) → batch every 300 ms (immediately at gesture end).
- Remote `events` → apply with `CaptureUpdateAction.NEVER`, skipping elements that
  are pending locally or in a gesture.
- `ack` → confirmed layer + re-stamp on canvas if unchanged since sent.
- `refused` → rebase per property (live) or offline copy (after offline).
- Status: `browser` / `server` / `drive` stages, blocked authors, errors.

## 8. Dev harness (`FAKE_GOOGLE=1`)

The Worker serves a fake Google at `/fake-google/…`: an OAuth page that lets you
pick a test user (alice, bob, carol), a token endpoint, and the Drive v3 subset
Kurviq uses (files list/get/create/update incl. multipart and media, `alt=media`,
revisions list/get/update/delete, permissions list/create/update/delete,
`files.watch`, `channels.stop`, app properties). State lives in the `FakeGoogle`
DO. The app build reads `VITE_APP_GOOGLE_API_BASE`; the Worker reads
`GOOGLE_API_BASE`, `GOOGLE_OAUTH_AUTHORIZE`, `GOOGLE_OAUTH_TOKEN`.
