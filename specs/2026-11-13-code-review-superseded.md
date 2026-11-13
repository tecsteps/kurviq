# Code review: findings superseded by the specs

Status: superseded (won't fix; kept for the lessons)

These 68 findings of the code review of 2026-11-13 are entirely inside code that
`2026-11-13-drive-collaboration-without-server-data.md` removes (the scene's server object with storage, the
shared-folder proxy, the public content cache, live sync's tickets and renewals, the browser's live sync engine, the
server's comment check). They are not fixed; each says what supersedes it, and the ones that hold a lesson for the
new relay, editor check or viewer say so ("Lesson for the new code"). If the Drive spec is not built, they are open
again (B1, B3, B4 are high).

## Potential bugs

### B1. A refused renewal locks the account out of the scene for 1 to 2 days, even after a fresh ticket
- **Area**: Worker: scene Durable Object (scene.ts, serverMerge.ts, shared.ts)
- **Severity**: high
- **Confidence**: confirmed (traced in the DO, the Worker routes and the client; not executed)
- **Location**: `online/worker/scene.ts:1103-1106` (connect), `1346-1374` (revokeTab, setRevoked, isRevoked), `1328-1335` (the only place the mark is cleared), `3561-3567` (pruned after a day); client `scenes-plugin/src/online/liveSync.ts:1167-1170`, `1105-1108`
- **Description**: `revokeTab` and `recheckedAccess` set `revoked[sub]`. `connect()` then refuses every new connection of that account (`full() || this.isRevoked(claims.sub)`), although a ticket is by definition a fresh Drive check (the code says so itself at `refreshAuthorToken`: "a ticket, a confirmed renewal"). The mark is cleared only in `confirmRenewal`, which needs `/renew`, which the client only calls while it has an established connection (the renew timer is cleared in `dropConnection`, and `renew()` is not called before a welcome). So nothing can clear it until retention prunes it (`now - at > DAY_MS`, and retention runs daily, so up to about 2 days). Scenario: Google asks the user to sign in again while a tab is open (`renewSignInFailure` on 401), or the owner removes and re-adds the person, or the renewal's `getFile` is rate-limited (`sceneRoutes.ts` `renewalAccess` only treats `"unreachable"` as transient, a 429 revokes). The user signs in again, gets a valid ticket, and every WebSocket upgrade is answered 429 "Too many connections to this scene"; the client retries forever. No test covers a reconnect after a refused renewal (`online/test/live-server.mjs` revokes only Google's token, never a renewal).
- **Suggested fix**: In `connect()`, treat the ticket as the confirmation it is: refuse only if `revoked[sub] > claims.checkedAt` (a refusal newer than the ticket's Drive check), otherwise clear the mark (`setRevoked(sub, false)`). Answer a revoked account with 403, not the 429 text. Separately, do not revoke on a rate-limited renewal (use `isTransient`).
- **Superseded**: the scene's server object with storage (`scene.ts`, `serverMerge.ts`, the public content cache) is replaced by a memory-only relay.
- **Lesson for the new code**: The relay's join check: a Drive rate limit (429 / 403 rateLimit) is "try again", never "no access".

### B3. A batch whose upload takes longer than 10 s is never delivered (reconnect loop)
- **Area**: Browser: live sync
- **Severity**: high
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/online/liveSync.ts:1155-1161` (checkAcks), `:2511` (flight start), `scenes-plugin/src/online/liveProtocol.ts:15` (ACK_TIMEOUT_MS)
- **Description**: `sendBatch` stamps `inFlight.at` before encrypting and sending, and `checkAcks` drops the connection when any flight is older than the fixed `ACK_TIMEOUT_MS` (10 s), whatever the batch's size. A batch may be up to 24 MB (`LIMITS.batchBytes`), a picture up to 12 MB (about 16 MB as base64). On an uplink where the batch needs more than 10 s (a 3 MB picture at 2 Mbit/s, 16 MB at 10 Mbit/s), the tab closes the socket mid-upload, sets `retry = 0`, reconnects after 1 s, finds the batch not in `welcome.known`, sends it again and drops again. The picture never reaches the server, every later batch touching it waits behind it, and the tab uploads without end.
- **Suggested fix**: Make the timeout depend on progress: start the clock when `ws.bufferedAmount` has drained to 0 (or extend it while `bufferedAmount` is falling), or scale it with the batch's encoded size.
- **Superseded**: the browser's live sync engine (`liveSync.ts`, `liveQueue.ts`, `liveMerge.ts`) is replaced by the pen-and-relay client.
- **Lesson for the new code**: The relay connection: timeouts by progress (bytes still buffered), not a fixed 10 s.

### B4. Edits made while live sync was stopped are overwritten when the other side's version number is higher (Astra F13)
- **Area**: Browser: live sync
- **Severity**: high
- **Confidence**: confirmed (found and reproduced by the Astra review with the production `reconcile`; the rule traced in code by me)
- **Location**: `scenes-plugin/src/online/liveSync.ts:1714-1727` (`unchangedLocal`, `olderThanTheirs`), `:1756-1780`
- **Description**: `unchangedLocal` counts an element as "not edited here" when `el.version <= theirs.version` (with a known base). The comment's reasoning is that an edit made here counts up from its base, so a lower number must be an older state. That fails when both sides edited: base version 1, local edit to version 2 (made while signed out or while the session was stopped, so there is no queued batch), the other author's edits to version 3. The local edit is classified unchanged, the DO's version replaces it, and no "(offline changes)" copy is made. Astra's reproduction: local `x: 100` at version 2 is replaced by the remote element at version 3, `makeOfflineCopy` is called zero times. The existing tests cover only a local version above the remote one.
- **Suggested fix**: Decide "unchanged here" by content against the stored base (and the DO's own stamps), never by comparing version numbers of two independently edited copies; if the local content differs from its base and theirs changed too, make the offline copy first. Add this case to `liveSyncRecovery.test.ts`.
- **Superseded**: the browser's live sync engine (`liveSync.ts`, `liveQueue.ts`, `liveMerge.ts`) is replaced by the pen-and-relay client.
- **Lesson for the new code**: Offline edits merged into Drive: decide "changed here" by content against the base, never by version numbers.

### B8. Blocked changes that expire (90 days / 7 days) leave ghost elements in connected tabs
- **Area**: Worker: scene Durable Object (scene.ts, serverMerge.ts, shared.ts)
- **Severity**: medium
- **Confidence**: confirmed (DO side traced; client applies `events` without a version check, `liveSync.ts:1974-2050`)
- **Location**: `online/worker/scene.ts:3575-3625` (expireBlocked), compare `3060-3141` (discardBatches, discardRepairEntries)
- **Description**: `expireBlocked` is a second, weaker implementation of a discard. After removing the batches it broadcasts only subjects that still exist in the rebuilt state (`.map((key) => this.state.get(key)).filter(entry => !!entry ...)`). An element that the expired batches created has no state entry any more, so no deletion is sent: connected tabs keep it on the canvas as "confirmed", while the DO and Drive do not know it. Editing it later is refused ("collision", `unknown: <id>`), and because the tabs took the repair's `seq`, a reconnect gets "events" mode (`hello.seq >= maxDeleted`) and the ghost survives until a full reload. `discardBatches` handles exactly this case with a deletion entry (`discardRepairEntries`, line 3135-3137). Scenario: Bob lost access with an unsaved new shape; Alice keeps the scene open; seven days later the daily retention drops Bob's batch; Alice still sees the shape, and it is in no saved version.
- **Suggested fix**: Build the repair in one place: let `expireBlocked` reuse `discardRepairEntries` (deletions for subjects that vanish) and broadcast those; the repair need not be stored as a batch since Drive never had the changes.
- **Also in the Astra review**: F22.
- **Superseded**: the scene's server object with storage (`scene.ts`, `serverMerge.ts`, the public content cache) is replaced by a memory-only relay.

### B9. Content leaves storage only if the save finishes within 10 minutes of the last tab leaving
- **Area**: Worker: scene Durable Object (scene.ts, serverMerge.ts, shared.ts)
- **Severity**: medium
- **Confidence**: confirmed (traced in code)
- **Location**: `online/worker/scene.ts:3632-3648` (cleanup), `1884` and `1133` (the only places "cleanup" is scheduled or cancelled), `4138-4154` (finishSaveRound)
- **Description**: `cleanup` is scheduled once, 10 minutes after the last connection closes. If something is still pending then (Google unreachable with the backoff of up to 30 minutes, an author whose token ran out, commenters' comments waiting for an editor, blocked authors for up to 90 days), `cleanup` returns and is never planned again: neither `finishSaveRound`, `expireBlocked` nor `retention` re-schedules it. When the save succeeds at minute 12, the whole snapshot, `owner`, `onBehalf` and the finished save records stay in the object's SQLite until someone connects and leaves again, possibly forever. That contradicts the stated rule ("Nobody connected for 10 minutes and everything in Drive: content leaves active storage") and costs storage. The same happens to an open audit: `cleanup` clears `seeded` while a `saves` row is in state `audit`, after which `saveRoundLocked` returns before `recoverSaves`, so the audit (and the daily retention alarm, `left` stays true) waits for the next reseed.
- **Suggested fix**: When `cleanup` bails out because of `pending` (or unfinished saves) and no socket is open, keep the job (`schedule("cleanup", now + CLEANUP_AFTER_MS)`), or schedule it from `finishSaveRound` / `expireBlocked` when `!this.sockets().length`. Let `cleanup` skip while `saves` has `prepared`/`audit`/`repair` rows.
- **Superseded**: the scene's server object with storage (`scene.ts`, `serverMerge.ts`, the public content cache) is replaced by a memory-only relay.

### B10. Seed and outside content is not held to the rules batches must pass: such elements can never be changed live
- **Area**: Worker: scene Durable Object (scene.ts, serverMerge.ts, shared.ts)
- **Severity**: medium
- **Confidence**: confirmed for outside changes; likely for the seed (I did not trace whether the client or the MCP normalise element ids before seeding; no such code found in `scenes-mcp` or `liveSync.ts` `seed()`)
- **Location**: `online/worker/scene.ts:222` (ID_RE), `231-250` (cleanReadable limits), `2009-2013` (validEvent), `2687-2704` (seedEntries), `4760-4773` (outsideElement); `online/worker/serverMerge.ts:409-419` (subjectsOfFile)
- **Description**: A batch event must have an id matching `^[\w.:~-]{1,128}$`, at most 200 group ids, 2000 bound ids, ids of at most 128 characters. Elements that arrive through an outside change (`subjectsOfFile` takes any string id, `readableOf` any lists) enter the state without these checks and are sent to all tabs. Any later change to such an element is refused as "invalid", and the client drops the whole batch into an offline copy ("Changes the server could not take"). Scenario: an agent or another tool writes an element with id `"box 1"` or `"größe"` to the Drive file; the element shows up in every tab, but nobody can move or delete it while live sync is on, and each attempt takes the user's other changes of that batch with it. For a file that already contains such an id, the seed is refused as "invalid" (`seedEntries`), the client shows `seed-invalid` and live sync never starts for that scene.
- **Suggested fix**: One validation for all three entry points. Either widen the id rule to what the file format allows (any non-empty string up to a length, checked the same way in `subjectsOfFile`, seed and batch), or have `subjectsOfFile` / the seed skip or re-id what a batch could not carry and say so (`setError`).
- **Superseded**: the scene's server object with storage (`scene.ts`, `serverMerge.ts`, the public content cache) is replaced by a memory-only relay.

### B11. A failed pin of a day's or an agent's version still counts as done (Astra F24)
- **Area**: Worker: scene Durable Object (scene.ts, serverMerge.ts, shared.ts)
- **Severity**: medium
- **Confidence**: confirmed (found by the Astra review; traced in code by me)
- **Location**: `online/worker/scene.ts:4887-4909` (`pin`)
- **Description**: For the daily milestone, `pinDay` is set after the attempt whether `keep(base.revision, true)` succeeded or `makeRoom()` refused, so the next save does not try that day again and its last version is never kept. For agent marks, the previous mark is un-pinned even when pinning the new revision failed (the status is checked only for the `pins.push`), and `agentRev` is patched anyway. One temporary Drive failure can leave neither the old nor the new agent baseline downloadable, which weakens the history and the detection of the user's changes since the agent's last edit.
- **Suggested fix**: Set `pinDay` and move the agent mark only after the new pin succeeded; keep the previous agent pin until its replacement is confirmed, and try again at the next save.
- **Superseded**: the scene's server object with storage (`scene.ts`, `serverMerge.ts`, the public content cache) is replaced by a memory-only relay.

### B12. A rate-limited Drive answer on a proof renewal ends the account's live access
- **Area**: Worker: routes, auth, OAuth, folders, stats
- **Severity**: medium
- **Confidence**: confirmed (traced in code)
- **Location**: `online/worker/sceneRoutes.ts:453-460` (also `:324-334`), `online/worker/scene.ts:1344-1355`, `online/worker/driveApi.ts:114-122`
- **Description**: `renewalAccess` extends the proof only when `problemOf(file) === "unreachable"`. For every other non-200 it first calls `revoke()` (`/revoke-tab`) and then `fileProblem()`. `fileProblem` itself treats `"rate-limited"` (HTTP 429, or 403 with a `rateLimitExceeded` / `userRateLimitExceeded` reason) as "Google Drive is not reachable" (503), but by then the scene object has already marked the account revoked and closed all of its connections on that scene with reason "access" (`revokeTab` closes every socket of the `sub` and refuses its batches until a renewal succeeds). Scenario: Drive answers the renewal's `files.get` with a 403 rate limit, the user is thrown out of the live scene as if their access had been removed. This contradicts the rule stated at the top of driveApi.ts ("Only refusals ever end someone's access").
- **Suggested fix**: In `renewalAccess` treat `problemOf(file)` of `"unreachable"` and `"rate-limited"` (ideally `isTransient`) the same way: `extend()`, no revoke.
- **Also in the Astra review**: F20.
- **Superseded**: live sync's tickets, renewals, sealed tokens and Drive watch go; the relay's join check is new code.
- **Lesson for the new code**: The relay's join check: a Drive rate limit (429 / 403 rateLimit) is "try again", never "no access".

### B13. A Drive rate limit (403) on a folder's permission list deletes the folder share
- **Area**: Worker: routes, auth, OAuth, folders, stats
- **Severity**: medium
- **Confidence**: confirmed (traced in code)
- **Location**: `online/worker/folders.ts:169-185`, `:188-204`, `:129-135`
- **Description**: `listPermissions` returns only the HTTP status, and `folderPermissions` treats everything except 0, 5xx and 429 as "the folder is gone" and calls `forgetFolder` (deletes the `shared_folders` row with the owner's token and all member rows). Drive reports quota problems mostly as 403 with reason `userRateLimitExceeded` / `rateLimitExceeded` (driveApi's `problemOf` knows this, folders.ts does not use it). Scenario: one member's request hits a Drive rate limit, the share disappears for all members until the owner's Kurviq registers the folder again. The same raw-status handling makes `inFolder` (`:372-381`) answer "not in this folder" for a rate-limited check (harmless but wrong).
- **Suggested fix**: Let `listPermissions` return the `DriveAnswer` and decide with `problemOf`: `unreachable` / `rate-limited` -> 503, only `access` / `not-picked` / `token` -> forget.
- **Also in the Astra review**: F21. It adds: a 401 for a cached access token that Google no longer accepts deletes the share the same way.
- **Superseded**: the shared-folder proxy with the owner's stored sign-in goes (guests pick the folder or its scenes in Google's picker).

### B15. A folder owner's "sign out everywhere" does not reach the copies of their refresh token held for folder members
- **Area**: Worker: routes, auth, OAuth, folders, stats
- **Severity**: medium
- **Confidence**: confirmed (traced in code; impact window depends on Google's revocation)
- **Location**: `online/worker/sceneRoutes.ts:291-293`, `:309-319`; `online/worker/folders.ts:138-167`, `:226-247`; `online/worker/scene.ts:3287-3288`, `:3319-3321`; claim in `online/worker/account.ts:6-9`
- **Description**: For a scene in a shared folder the ticket/renewal seals the **owner's** refresh token for the scene object, but under the **member's** `sub` and `iat` (`sealedToken(ctx, fileId, session, access.refresh)`). The scene object registers that token with the member's account guard and checks the member's epoch. The owner's account guard therefore knows nothing about these copies, although account.ts promises that signing out everywhere "finds every stored copy". In addition `ownerAccess` returns its cached access token (up to about 55 minutes per isolate) before it looks at the owner's epoch, and `folderFileAccess` unseals `row.token` without an epoch check, so new tickets with the owner's refresh token are still issued during that time. What limits the damage is only Google's revocation in `logoutAll`; if that call failed (it is retried for up to 30 days) the copies stay usable until their 4-hour lease ends or is renewed.
- **Suggested fix**: Seal folder tokens with the owner's `sub`/`iat` as well (or carry `ownerSub` + owner `iat` in the claims) so the scene object checks and registers with the owner's guard; check the epoch in `ownerAccess` before using the cache (the epoch call is cheap) and in `folderFileAccess`.
- **Also in the Astra review**: F25 (the cache in `ownerAccess` is used before the owner's epoch is checked) and F19 (see the separate finding on delegated saves).
- **Superseded**: the shared-folder proxy with the owner's stored sign-in goes (guests pick the folder or its scenes in Google's picker).

### B17. Shared-folder rows (with the owner's sealed Google refresh token) and member hashes are never deleted by retention
- **Area**: Worker: routes, auth, OAuth, folders, stats
- **Severity**: medium
- **Confidence**: confirmed (traced in code)
- **Location**: `online/worker/retention.ts:25-36`; `online/worker/folders.ts:77-78`, `:86-100`, `:129-135`, `:286-300`
- **Description**: `shared_folders.token` is the owner's Google refresh token sealed with TOKEN_KEY "for 90 days". The row and the member hashes (keyed hashes of e-mail addresses and domains) are removed only when the owner's Kurviq reports "not shared any more" or when a member happens to call `enter` after the token ran out. If the owner simply stops using Kurviq and no member comes back, the encrypted but still valid refresh token and the member list stay in D1 indefinitely; the retention job only knows `feedback` and `contact_messages`. `pub_links` has the same property (see next finding).
- **Suggested fix**: In `runRetention` delete `shared_folders` rows whose `updated_at` is older than `TOKEN_DAYS` (and their member rows).
- **Superseded**: the shared-folder proxy with the owner's stored sign-in goes (guests pick the folder or its scenes in Google's picker).

### B19. A member removed from a shared folder: their accepted changes are still saved with the owner's token (Astra F19)
- **Area**: Worker: routes, auth, OAuth, folders, stats
- **Severity**: medium
- **Confidence**: likely (found by the Astra review, which rates it high; I confirmed that the token is sealed under the member's `sub` without the folder or owner, and that `planGroup` does not look at `revoked`; the end-to-end case was not run)
- **Location**: `online/worker/folders.ts:227-246`, `online/worker/sceneRoutes.ts:292-317`, `:376`, `online/worker/scene.ts:3964-3970` (`planGroup`: `tokens.has(sub) && !blocked[sub]`), `:4105-4120` (`saveGroup`)
- **Description**: For a scene in a shared folder the scene object stores the folder owner's refresh token under the member's account, without the folder id, the owner or the fact that it is delegated. At save time `saveGroup` asks Drive whether the token's holder may edit: that is the owner, not the member. So after the member was removed from the folder, their batches that the object had already accepted are still written to Drive with the owner's credential; a member who is not connected has no renewal that would notice the removal, and `/revoke-tab` only sets `revoked`, which `planGroup` ignores. This is the save-time side of "A folder owner's sign out everywhere does not reach the copies of their refresh token" (same root cause). I rate it medium, not high: the batches were accepted while the member still had access.
- **Suggested fix**: Keep the delegation in the sealed token (folder id, owner `sub` and sign-in time) and check folder membership and the owner's epoch before a delegated save; let `planGroup` skip revoked accounts.
- **Superseded**: the shared-folder proxy with the owner's stored sign-in goes (guests pick the folder or its scenes in Google's picker).

### B21. Queues of closed tabs that cannot be finished are reconnected every 30 s, forever
- **Area**: Browser: live sync
- **Severity**: medium
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/online/liveSync.ts:3860-3873` (closeIdleSessions), `:3876-3898` (sweep), `scenes-plugin/src/online/liveQueue.ts:216-227` (orphanQueues)
- **Description**: `orphanQueues` returns every queue that has any batch, in any state. `closeIdleSessions` closes a replay session as soon as it is `idle()` (no *queued* batch) or `stopped`. Two cases loop: (1) a queue with only `acked` batches (on the server, not yet in Drive, e.g. while an author is blocked or Drive is full) is idle, so it is closed at the next sweep, found again as an orphan, and a new session is started: ticket request, WebSocket, and, because headless sessions always say `seq: 0` (`:1031`), a download and decryption of the whole scene with its pictures, every 30 s until a receipt covers the batches. (2) a queue whose ticket is refused for good (`no-access` after the scene was unshared, 401, live sync off) becomes `disabled`, is closed, and is retried with a new ticket request every 30 s without backoff; those batches are never removed or shown once the session is closed. Every open tab of the account runs this sweep. Each ticket also counts as a `live_sessions` statistic.
- **Suggested fix**: Do not start a replay for queues with only acked batches (drop them from a receipt read cheaply, or when the scene is next opened), and remember refused queues (per file, with a growing pause) instead of recreating the session each sweep.
- **Superseded**: the browser's live sync engine (`liveSync.ts`, `liveQueue.ts`, `liveMerge.ts`) is replaced by the pen-and-relay client.

### B22. An incoming change can overwrite an edit the user started while it was being decrypted
- **Area**: Browser: live sync
- **Severity**: medium
- **Confidence**: confirmed (traced in code; the window is the decryption time of the batch)
- **Location**: `scenes-plugin/src/online/liveSync.ts:2036-2037` (snapshot), `:2041-2052`, `:2080-2091`
- **Description**: `takeStamped` reads `pendingIds()` and `surface.gesture()` once, then awaits the decryption of every event. If the user starts changing element X during those awaits (`collect()` puts X into the draft), the stale snapshot still says "not pending, not in a gesture": X is pushed to `toApply`, `synced` moves to the other author's stamp and the canvas is overwritten. The draft still holds the user's version, and `enqueue` now computes its base and `keys` against the new `synced` entry, so it is sent on the new stamp with the old values of the properties the other author changed. The DO accepts it (the base matches), and the other author's change is undone without a collision or a "restore yours?" offer. The window is milliseconds for small batches and grows with batch size (pictures, many events).
- **Suggested fix**: Decrypt all events first, then read `pendingIds()` and `gesture()` and decide synchronously what goes to the canvas and into `synced`.
- **Superseded**: the browser's live sync engine (`liveSync.ts`, `liveQueue.ts`, `liveMerge.ts`) is replaced by the pen-and-relay client.

### B23. A dead connection is only noticed when the tab sends a batch; a handshake has no time limit
- **Area**: Browser: live sync
- **Severity**: medium
- **Confidence**: likely (how fast a browser reports a silently dropped TCP connection was not measured)
- **Location**: `scenes-plugin/src/online/liveSync.ts:1034-1038` (ping sent, pong ignored), `:1018` (phase "handshake"), `:886-895` (wake only from "offline"), `:1041-1046`
- **Description**: The tab sends `"ping"` every 30 s and discards `"pong"` without recording it. The only liveness check is the ack timeout of a sent batch. A tab that only receives (the shared-link viewer, an editor who is reading) keeps `phase === "ready"` on a connection that died silently (NAT timeout, VPN, Wi-Fi roam): it shows "connected" and a stale scene until the operating system gives up on the socket. `wake()` on the browser's `online` event does nothing unless the phase is already `offline`. Likewise nothing limits the time between `hello` and `welcome`: if the welcome never arrives, or one of its parts is dropped as malformed (`:1043-1045` only logs, although `frames.ts:30` says the caller drops the connection), the session stays in `handshake` for good.
- **Suggested fix**: Record the time of the last pong (or any message) and call `dropConnection()` when nothing arrived for about 2 ping intervals; do the same when no welcome arrived within a limit; drop the connection when `receive()` throws.
- **Superseded**: the browser's live sync engine (`liveSync.ts`, `liveQueue.ts`, `liveMerge.ts`) is replaced by the pen-and-relay client.
- **Lesson for the new code**: The relay connection: detect dead connections both ways (ping / pong), limit the handshake.

### B24. A token refusal that renewing cannot fix resends the batch in a tight loop
- **Area**: Browser: live sync
- **Severity**: medium
- **Confidence**: confirmed (traced in code; which renew failures last was not tested)
- **Location**: `scenes-plugin/src/online/liveSync.ts:2836-2841`, `:1167-1185` (renew swallows errors), `online/worker/scene.ts:2118-2120`
- **Description**: On `refused: "token"` the tab awaits `renew()`, then calls `pump()`, which sends the batch again at once. `renew()` swallows every error except lost access. While `/renew` fails (5xx, 429, a 401 of an expired session) the DO keeps answering `token`, so the tab alternates `/renew` and a full re-encryption and upload of the batch as fast as the round trips allow. The token path does not count in `rebases` and has no pause.
- **Suggested fix**: Let `renew()` report success; on failure park the batch and retry with backoff (as the passing limits do at `:2733-2740`).
- **Superseded**: the browser's live sync engine (`liveSync.ts`, `liveQueue.ts`, `liveMerge.ts`) is replaced by the pen-and-relay client.

### B25. The DO's status message erases the tab's own error
- **Area**: Browser: live sync
- **Severity**: medium
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/online/liveSync.ts:1220-1222` against `:2718`, `:2849`, `:1520`, `:949`, `:1060`
- **Description**: `this.error` holds three kinds of values: the DO's status codes, the tab's own codes (`font-full`, `key-changed`, `key-invalid`, `too-many-tabs`) and free text (`refusedMessage(...)`, exception messages). `onStatus` assigns `this.error = message.error` unconditionally, and the DO broadcasts a status on every presence, blocked or save change. So after a batch was parked ("Too big to save at once", "You can only view this scene now", `font-full`), the next status with `error: null` removes the banner while the batch stays parked until the next handshake. The user sees only the stage "in this browser" with no reason.
- **Suggested fix**: Keep the tab's own problem in a separate field (derived from `parked` / the key state) and let `info()` combine both.
- **Superseded**: the browser's live sync engine (`liveSync.ts`, `liveQueue.ts`, `liveMerge.ts`) is replaced by the pen-and-relay client.

### B26. A message that fails to apply is skipped, and the next one moves `seq` past it
- **Area**: Browser: live sync
- **Severity**: medium
- **Confidence**: confirmed (traced in code; needs an event that throws, e.g. a failed decryption)
- **Location**: `scenes-plugin/src/online/liveSync.ts:1050-1062` (inbox catch), `:1974-1984` (onEvents), `:1031-1032` (hello)
- **Description**: When `receive()` throws, the inbox logs it, stores the text in `this.error` and continues with the next message. `onEvents` has no gap check: the next batch sets `this.seq = Math.max(this.seq, batch.seq)`. The failed batch (possibly half applied to `confirmed`) is never fetched again, since the next `hello` names the later `seq`, and `catchUp()` then keeps the canvas on the incomplete `confirmed` state. The tab stays wrong until a full-state handshake.
- **Suggested fix**: On an exception in `events`, `ack` or `refused`, call `dropConnection()` without advancing `seq`, so the handshake delivers the batch again (or ask for the full state).
- **Superseded**: the browser's live sync engine (`liveSync.ts`, `liveQueue.ts`, `liveMerge.ts`) is replaced by the pen-and-relay client.

### B27. Without a known base, local changes are replaced by the DO's state without an offline copy
- **Area**: Browser: live sync
- **Severity**: medium
- **Confidence**: uncertain (not traced: whether the controller always pushes a dirty local copy before a scene first goes live)
- **Location**: `scenes-plugin/src/online/liveSync.ts:1726` (`!base ||`), `:1730-1738`, `:854-857`, `scenes-plugin/src/controller.ts:1200-1207`
- **Description**: `localBase` is the stored confirmed state, or else `driveBase()`. `driveBase` returns null when the scene has no `baseMd5` or when loading that Drive version fails (the error is caught; the revision may also be gone). With `base === null`, `unchangedLocal` is true for every element, so `takeUnchanged` takes the DO's version for all of them and deletes canvas elements the DO does not have. No clash is recorded, so no "(offline changes)" copy is made, also when `signedOutEdits` is set (`unqueued` stays empty). Scenario: first live session of a scene in this browser (or cleared IndexedDB), edits on the canvas made while signed out, and the Drive base version cannot be loaded at that moment.
- **Suggested fix**: When no base is known and the canvas differs from the DO's state by content, make the offline copy first (the same path as a clash) instead of treating everything as unchanged.
- **Superseded**: the browser's live sync engine (`liveSync.ts`, `liveQueue.ts`, `liveMerge.ts`) is replaced by the pen-and-relay client.
- **Lesson for the new code**: No known base: make a copy of local changes, never drop them.

### B28. A comment that collided while offline stays in the queue and is sent again without end (Astra F14)
- **Area**: Browser: live sync
- **Severity**: medium
- **Confidence**: confirmed (found and reproduced by the Astra review; traced in code by me)
- **Location**: `scenes-plugin/src/online/liveSync.ts:3143-3170` (`dropColliding`)
- **Description**: `dropColliding` sorts the colliding keys into element ids and "other keys", but only `set:` and `name:` count as other keys. A colliding comment key (`cmt:<id>`) therefore lands in the element id set, where no element matches it, and the filter for non-element changes keeps the comment because it is not in `otherKeys`. `pump()` sends the same comment with the same stale base again, gets the same collision, and repeats. Reachable when two tabs change or resolve the same comment while one is offline.
- **Suggested fix**: Treat every non-element key (`cmt:` too) as an other key: drop the colliding comment change from the queue and the draft, show the confirmed comment, and keep the local one in the offline copy.
- **Superseded**: live sync's queue goes; commenters' comments go through the editor's tab or Drive's comments as a mailbox.

### B29. A shared link opened in a shared-folder tab is read through the folder proxy and can never be opened
- **Area**: Browser: Drive client and online UI
- **Severity**: medium
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/online/drive.ts:462-464`, `722-734`, `1662-1674`, `1688-1719`; `scenes-plugin/src/publicScene.tsx:199-216`, `535-556`; `online/worker/folders.ts:389-390`
- **Description**: `drive()` sends every call through `folderDrive` when the tab's space is a shared folder (`sharedFolderId`). The space is sticky (`SPACE_KEY` in localStorage, so every new tab starts in it). `readSharedScene` and `sharedSceneVersion` use `fetchSharedFile`, which uses `drive()`. Scenario: the tab is in a colleague's folder space and the user opens `kurviq.com/s/<fileId>` of a non-public scene that is not in that folder (shared with them on its own, or even their own private scene). The Worker answers "File not found in this folder" (status 404), `fetchSharedFile` returns null, the viewer shows "Google Drive asks you to allow Kurviq to open this scene". The Picker grants access to the user's own token, `retry()` asks the folder proxy again, same answer: an endless "allow" loop for a file the user can read. For public scenes `canEdit` is always false for the same reason (no Edit button).
- **Suggested fix**: let `fetchSharedFile` / `download` for a shared link use the visitor's own token (a `direct` option of `drive()` that skips the folder route), since a `/s/` link is never a call "in the folder".
- **Superseded**: the shared-folder proxy with the owner's stored sign-in goes (guests pick the folder or its scenes in Google's picker).

### B30. The viewer can stay on a stale copy of a public scene until the next save
- **Area**: Browser: Drive client and online UI
- **Severity**: medium
- **Confidence**: confirmed (traced in code; timing not reproduced)
- **Location**: `scenes-plugin/src/publicScene.tsx:292`, `318-322`; `scenes-plugin/src/online/drive.ts:1677-1686`; `online/worker/shared.ts:71`, `103`
- **Description**: the first load takes `/api/public/<id>` (edge cache and browser cache, `max-age=60`), while the version to compare with comes from `/api/public/<id>/version` (`max-age=5`) and is stored as "the version shown" (`version.current ??= v`) without looking at what was actually loaded. Scenario: the owner saves, a visitor reloads (or opens) the link within a minute of an earlier fetch: the content is the old cached copy, `version.current` is the new MD5. Every later check finds `latest === version.current` and skips, so the old drawing stays on screen until the owner saves again or the visitor reloads after the cache expired.
- **Suggested fix**: note the version of the content that was loaded: `version.current = md5(bytes of the loaded json)` (the public route passes Drive's bytes through, `md5.ts` is there), or load the first copy with `?v=<version>` after asking the version.
- **Superseded**: the public viewer reads Drive directly in the browser; no content cache.
- **Lesson for the new code**: The viewer reading Drive directly: compare the version of what was actually loaded.

### B56. A discard does not take back comments, images, fonts or a name that the discarded batches created
- **Area**: Worker: scene Durable Object (scene.ts, serverMerge.ts, shared.ts)
- **Severity**: low
- **Confidence**: confirmed in the DO; what the tabs then show was not traced
- **Location**: `online/worker/scene.ts:3123-3141`
- **Description**: `discardRepairEntries` makes a repair entry only if an earlier state exists (`back`) or the subject is an element (`else if (old.r)`). A comment (or a scene name without a seeded `name` subject) first created by a discarded batch gets no repair: the DO forgets it, the tabs that received it live keep it. Resolving or editing that comment later is refused (`unknown: <id>`). The doc comment promises "deleted subjects included".
- **Suggested fix**: For `cmt` send a tombstone (`gone`) repair; for other kinds at least tell the tabs (a repair with an empty value or a `state` welcome).
- **Superseded**: the scene's server object with storage (`scene.ts`, `serverMerge.ts`, the public content cache) is replaced by a memory-only relay.

### B57. `lastAccess` survives "sign out everywhere" and can be filed under the wrong account
- **Area**: Worker: scene Durable Object (scene.ts, serverMerge.ts, shared.ts)
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `online/worker/scene.ts:1655-1670` (forget), `3233-3240` (dropToken), `4250` and `4296` (upload), `3857-3861` (verificationRefused), `1403-1405`
- **Description**: (1) `forget()` drops the stored token and `this.access`, but not `this.lastAccess`: the object keeps using that person's Google access token for outside checks, trash checks and verification until it expires or the object is evicted. (2) `upload()` with an empty group (the audit's repair) takes `author` from `this.lastAccess?.sub ?? this.anyToken() ?? ""` and then stores `this.lastAccess = { sub: author, token }`, although `token` is whatever the caller passed (for `reconcileToken` the asking person's one-time token). The token is then attributed to another account or to `""`; `verificationRefused` compares that `sub` with the owner (a 404 for the "owner" becomes a tombstone), `recheckAccess` applies the result to the wrong person, and the `saves` row and the on-behalf record name the wrong author.
- **Suggested fix**: Clear `lastAccess` in `dropToken`/`forget` when it is that account's. Pass `{ sub, token }` into `upload`/`audit`/`repairUpload` instead of guessing the account.
- **Superseded**: the scene's server object with storage (`scene.ts`, `serverMerge.ts`, the public content cache) is replaced by a memory-only relay.

### B58. The save backoff is undone by the next change
- **Area**: Worker: scene Durable Object (scene.ts, serverMerge.ts, shared.ts)
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `online/worker/scene.ts:3952-3957` (retryLater), `3364-3376` (schedule), `2449`, `2970`, `1177`
- **Description**: `retryLater` plans the next round up to 30 minutes ahead. Every accepted batch calls `schedule("save", now + SAVE_EVERY_MS, true)`; with `earlier` a later planned time is replaced by the sooner one. While anyone edits, a scene that Google rate-limits is retried every minute, so the exponential backoff only works for idle scenes.
- **Suggested fix**: Keep a `retryNotBefore` (meta) that `schedule("save", …)` respects unless the caller is a credential or access event (`unblock`, `refreshAuthorToken`).
- **Superseded**: the scene's server object with storage (`scene.ts`, `serverMerge.ts`, the public content cache) is replaced by a memory-only relay.

### B59. Snapshot entries that do not decrypt are silently left out of the Drive file
- **Area**: Worker: scene Durable Object (scene.ts, serverMerge.ts, shared.ts)
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `online/worker/scene.ts:4179-4197` (decryptAll), `4243-4249` (upload), `4712-4713` (mergeOutside)
- **Description**: `upload` sets aside only bad entries that belong to the group. A bad entry in the snapshot (the seed is never decrypted when taken, so a faulty seed lands there unchecked) is neither in `plain` nor reported: the next save writes the file without it and no error is set. A client bug in seeding would thus remove elements from Drive at the first save instead of stopping.
- **Suggested fix**: If `bad` contains entries outside the group, do not upload: `setError("snapshot-invalid")` and retry later (or verify the seed in the first round before anything is written).
- **Superseded**: the scene's server object with storage (`scene.ts`, `serverMerge.ts`, the public content cache) is replaced by a memory-only relay.

### B60. A pin is forgotten even when Drive did not delete the revision
- **Area**: Worker: scene Durable Object (scene.ts, serverMerge.ts, shared.ts)
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `online/worker/scene.ts:4614-4623`
- **Description**: `pinRoom` deletes the oldest day pin's revision and removes it from `pins` without looking at the answer. On a failed DELETE (Google down, 403) the revision stays `keepForever` in Drive but Kurviq no longer counts it. Repeated, the file drifts towards Google's limit and ends in `pins-full` / `audit-pins-full`, which nothing in Kurviq can clear.
- **Suggested fix**: Drop the pin from the list only on 200/204/404; otherwise return `false`.
- **Also in the Astra review**: F23. It adds: `pinRoom` (`online/worker/scene.ts:4620`) ignores the answer of the DELETE and drops the pin record anyway, and `releaseAuditPins` (`:4596-4601`) stops tracking a pin after a 429 or a 403 rate limit; both checked by me.
- **Superseded**: the scene's server object with storage (`scene.ts`, `serverMerge.ts`, the public content cache) is replaced by a memory-only relay.

### B61. Element ids may contain ":" and then collide with the keys of other kinds
- **Area**: Worker: scene Durable Object (scene.ts, serverMerge.ts, shared.ts)
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `online/worker/scene.ts:222`, `scenes-plugin/src/online/liveProtocol.ts:381`
- **Description**: `eventKey("el", id)` is the bare id, other kinds are `"<kind>:<id>"`, and `ID_RE` allows `:`. An element with id `set:settings`, `name:name` or `cmt:<id>` shares its state key with that subject; with the right base the DO replaces the settings or a comment entry by an element (the save then writes default settings and drops the comment). Only editors can do it, but outside files can carry such ids by accident.
- **Suggested fix**: Forbid `:` in element ids, or prefix element keys as well.
- **Superseded**: the scene's server object with storage (`scene.ts`, `serverMerge.ts`, the public content cache) is replaced by a memory-only relay.

### B62. Public scenes: `?v=` is only a cache key, and a failed Drive call is cached as "not public"
- **Area**: Worker: scene Durable Object (scene.ts, serverMerge.ts, shared.ts)
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `online/worker/shared.ts:47-83`, `86-108`, `123-124`
- **Description**: (1) The header says "?v=<version>: that version", but `publicScene` always downloads the head and only uses `v` in the cache key. Any 32 hex characters are accepted, so each new value makes two Drive calls with Kurviq's API key and stores another copy of the file (up to 25 MB) in the cache. (2) `meta.ok === false` and a failed download are answered with `notPublic()` and cached for 30 s, also when Drive answered 429 or 5xx. During a Google hiccup a public scene is "Not a public scene" for every viewer, and `handleSharedPage` adds `noindex` and the generic title to a public scene's page.
- **Suggested fix**: Accept `v` only if it equals the `md5Checksum` from the metadata call (else serve the plain key). Cache the negative answer only for 403/404; pass 429/5xx through uncached (or serve a stale copy).
- **Superseded**: the scene's server object with storage (`scene.ts`, `serverMerge.ts`, the public content cache) is replaced by a memory-only relay.

### B70. The watch secret is compared with `===`
- **Area**: Worker: routes, auth, OAuth, folders, stats
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `online/worker/sceneRoutes.ts:563`
- **Description**: The HMAC-derived channel secret of Drive's webhook is compared with a normal string comparison (not constant time). Practically hard to exploit over the network, but it is the only secret comparison in the Worker that is not done by AES-GCM.
- **Suggested fix**: Compare with `crypto.subtle.timingSafeEqual` (available in Workers) over equal-length byte arrays.
- **Superseded**: live sync's tickets, renewals, sealed tokens and Drive watch go; the relay's join check is new code.

### B71. The account's e-mail from the ID token is trusted without `email_verified`
- **Area**: Worker: routes, auth, OAuth, folders, stats
- **Severity**: low
- **Confidence**: uncertain (whether Google ever issues an unverified `email` for an account that Drive permissions do not refer to could not be checked here)
- **Location**: `online/worker/auth.ts:224-234`; used for authorization in `online/worker/folders.ts:213`, `online/worker/folderRules.ts:49-66`, `online/worker/sceneRoutes.ts:160-166`
- **Description**: Folder access is granted with the **owner's** Drive token to whoever's ID token carries an e-mail that matches a folder permission (or its domain). `userOf` takes `claims.email` as it is. Google's guidance is to rely on `email` only when `email_verified` is true.
- **Suggested fix**: In `userOf` refuse (or mark) sessions whose ID token has `email_verified !== true`; `roleFor` should then ignore unverified e-mails.
- **Superseded**: the shared-folder proxy with the owner's stored sign-in goes (guests pick the folder or its scenes in Google's picker).

### B72. Live-sync claims travel in a header: non-Latin-1 names
- **Area**: Worker: routes, auth, OAuth, folders, stats
- **Severity**: low
- **Confidence**: uncertain (works only because workerd accepts UTF-8 header values; not verified with a test account named e.g. "Łukasz" or "山田")
- **Location**: `online/worker/sceneRoutes.ts:414-416`
- **Description**: `headers.set("X-Kurviq-Claims", JSON.stringify(claims))` contains `person` (the Google display name). The Fetch standard requires header values to be byte strings; in a standard runtime (the unit tests' environment, Node) this throws for characters above U+00FF.
- **Suggested fix**: Encode the claims (`encodeURIComponent` or base64url) and decode in the scene object, or pass the sealed ticket and unseal there.
- **Superseded**: live sync's tickets, renewals, sealed tokens and Drive watch go; the relay's join check is new code.

### B81. `sendBatch` marks a batch as in flight only after two awaits
- **Area**: Browser: live sync
- **Severity**: low
- **Confidence**: likely (in the common paths IndexedDB's transaction order happens to close the window)
- **Location**: `scenes-plugin/src/online/liveSync.ts:2501-2511`, `:2456-2485` (pump), `:3118-3120`, `:2735-2739`, `:2787-2792`
- **Description**: `pump()` skips a batch only if it is in `inFlight`, but `sendBatch` sets that after `await includeMissingFiles` (which may read the uploads database) and `await persist`. A `pump()` in between (the 15 s timers that release parked batches, the token path, an ack while `getUpload` runs) starts a second `sendBatch` for the same batch. The DO answers the second copy as a duplicate, or refuses both, which counts two of the three `rebases` tries for one collision and uploads the payload twice.
- **Suggested fix**: Set the `inFlight` entry (or a "sending" mark) synchronously at the start of `sendBatch` and remove it on the early returns.
- **Superseded**: the browser's live sync engine (`liveSync.ts`, `liveQueue.ts`, `liveMerge.ts`) is replaced by the pen-and-relay client.

### B82. Handlers that resume after a reconnect act on the new connection
- **Area**: Browser: live sync
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/online/liveSync.ts:1634-1638`, `:1646-1675` (seed)
- **Description**: `seed()` awaits `loadFileVersion` and, when it returns null, calls `dropConnection()` without a `stale()` check. If the socket was replaced meanwhile, this closes the new, healthy one. After the single `stale()` check at `:1643` it still awaits `showSeedAssets` and `fontHash`, replaces `confirmed`, and `this.send(...)` then writes the seed, built for the old ticket's head, to whatever socket is current. A `JSON.parse` error at `:1640` leaves the phase at `seeding` with no retry.
- **Suggested fix**: Check `stale()` after every await in `seed()` before touching state or the socket, and treat a parse failure like an unreadable version.
- **Superseded**: the browser's live sync engine (`liveSync.ts`, `liveQueue.ts`, `liveMerge.ts`) is replaced by the pen-and-relay client.

### B83. Three closes before a welcome are reported as "too many connections"
- **Area**: Browser: live sync
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/online/liveSync.ts:1077-1084`, text in `scenes-plugin/src/online/ui.tsx:1307`
- **Description**: Any socket that closes before a welcome increments `refusedOpens`; from the third on, the banner says the server cannot take another connection and asks the user to close other tabs. A network where the ticket request works but WebSockets fail (a proxy, a flaky link) gets the same text, and the retry pause is set to the longest one.
- **Suggested fix**: Use this text only for the close codes and reasons the DO sends for its limits (`4000` / `1008` with a reason); treat the rest as offline.
- **Superseded**: the browser's live sync engine (`liveSync.ts`, `liveQueue.ts`, `liveMerge.ts`) is replaced by the pen-and-relay client.

### B84. `close({ resetToConfirmed })` can add an element without an id to the canvas
- **Area**: Browser: live sync
- **Severity**: low
- **Confidence**: likely (needs a pending id that is neither on the canvas nor confirmed, e.g. a queued new element after a reload that dropped it from the stored canvas)
- **Location**: `scenes-plugin/src/online/liveSync.ts:3628-3635`
- **Description**: For every pending id the code takes `confirmed.get(id)` or else `{ ...shown, isDeleted: true, version: shown.version + 1 }`, with `shown` asserted non-null. If the id is on neither side, the result is `{ isDeleted: true, version: NaN }` with no `id`, which `merge()` stores under the key `undefined` and hands to `updateScene`.
- **Suggested fix**: Skip ids that are neither confirmed nor on the canvas.
- **Superseded**: the browser's live sync engine (`liveSync.ts`, `liveQueue.ts`, `liveMerge.ts`) is replaced by the pen-and-relay client.

### B85. User edits made during an agent edit are sent as the agent's
- **Area**: Browser: live sync
- **Severity**: low
- **Confidence**: confirmed (traced in code; the window is the awaited flush)
- **Location**: `scenes-plugin/src/online/liveSync.ts:3406-3416`, `:2235`, `:2247`
- **Description**: `agentMark` stays set across `await this.flush()`. A canvas `onChange` in that time runs `collect()` → `addDraft`, which reads `agentMark`: the user's change gets `via: "agent"` and the agent's command id, so it is attributed to the agent and belongs to the command's exactly-once journal.
- **Suggested fix**: Clear `agentMark` right after the synchronous `collect()`, before awaiting the flush.
- **Superseded**: the browser's live sync engine (`liveSync.ts`, `liveQueue.ts`, `liveMerge.ts`) is replaced by the pen-and-relay client.

### B86. Without Web Locks a tab can take over the queue of another open tab (Astra F15)
- **Area**: Browser: live sync
- **Severity**: low
- **Confidence**: confirmed (found by the Astra review; traced in code by me; only browsers without `navigator.locks` are affected)
- **Location**: `scenes-plugin/src/online/liveQueue.ts:153-158` (`holdTab`), `:182-207` (`claimTab`)
- **Description**: Without Web Locks `holdTab` always succeeds ("this tab's own ids only, never taken over"), but `claimTab` still offers it the tab ids of all stored batches of the account. So the first candidate, possibly the id of another open tab, is claimed, and two tabs send under one tab id. `orphanQueues` guards this case, `claimTab` does not.
- **Suggested fix**: Without locks, try only the id remembered in `sessionStorage`, else a new one.
- **Superseded**: the browser's live sync engine (`liveSync.ts`, `liveQueue.ts`, `liveMerge.ts`) is replaced by the pen-and-relay client.

### B87. Agent command records are never deleted (Astra F16)
- **Area**: Browser: live sync
- **Severity**: low
- **Confidence**: confirmed (found by the Astra review; traced in code by me)
- **Location**: `scenes-plugin/src/online/liveQueue.ts:233-249`
- **Description**: `COMMAND_KEEP_MS` (7 days) is applied only when a record is read: older records are ignored, not removed. `recordCommand` adds one per agent edit and nothing deletes them (`forgetFile` removes batches only), so the `kurviq-live-commands` store grows for good.
- **Suggested fix**: Delete records older than the limit in the 30 s sweep (or when recording), and with the file's queue.
- **Superseded**: the browser's live sync engine (`liveSync.ts`, `liveQueue.ts`, `liveMerge.ts`) is replaced by the pen-and-relay client.

## Code smells

### S3. Whole-scene work on every incoming batch and every timer tick
- **Area**: Browser: live sync
- **Severity**: medium
- **Confidence**: confirmed (traced in code; the cost was not measured)
- **Location**: `scenes-plugin/src/online/liveSync.ts:1980`, `:2625` (catchUp per message), `:1944-1962`, `:1893-1912`, `:258`, `:2210`, `:1135`, `:3883`, `:3901`, `:3275-3289`; `scenes-plugin/src/online/liveQueue.ts:191`, `:218`
- **Description**: (1) `catchUp()` runs after every `events` message and every ack. It clones every canvas element (`surface.elements()` spreads each one) and calls `contentEqual` (normalise, sort keys, stringify both sides) for each *before* comparing stamps, so one remote drag at three batches per second costs a full normalisation of the scene each time. (2) `applyToSurface` runs `elements.some(...)` inside a loop over all canvas elements: quadratic when a state load applies most of the scene (limit 50,000 elements). (3) `collect()` calls `this.surface.elements().find(...)` once per released gesture id, a full clone of the scene per id, although `elements` is already in scope. (4) `batchesOf` reads whole batches with their picture payloads only to learn tab ids, element ids and states: every 15 s per scene, twice per 30 s sweep for the account, and in `claimTab`. (5) `persistBaseSoon` writes the whole confirmed scene to IndexedDB up to every 1.5 s while events arrive.
- **Suggested fix**: In `catchUp` compare stamps first and call `contentEqual` only when they differ; use a `Set` of applied ids; reuse the `elements` array in `collect`; read keys (`getAllKeys`) or a small index instead of whole batches.
- **Superseded**: the browser's live sync engine (`liveSync.ts`, `liveQueue.ts`, `liveMerge.ts`) is replaced by the pen-and-relay client.

### S9. Memory and storage can part ways when a transaction throws; only `acceptBatch` handles it
- **Area**: Worker: scene Durable Object (scene.ts, serverMerge.ts, shared.ts)
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `online/worker/scene.ts:2408-2429` (handled), `3022-3038` (acceptAs), `3064-3108` (discardBatches), `3170-3180` (adoptComments), `2718-2743` (commitSeedSnapshot), `3591-3611` (expireBlocked), `4343-4367` (commitSave), `4797-4815` (commitOutside)
- **Description**: These functions change `this.pending`, `this.snap`, `this.seqNow`, `batch.author` and `this.discarded` before or inside `transactionSync`. If the transaction rolls back, memory keeps the change. `acceptBatch` sets `loaded = false` for that case, `handleFetch` and `runAlarm` do it in their catch, but `webSocketMessage` has no catch at all, so a failure in `onDecide`, `onSeed` or `onKeepLocalDone` leaves the object running on a state SQLite does not have.
- **Suggested fix**: One wrapper (`this.tx(() => …)`) that sets `loaded = false` on a throw, and a catch in `handleMessage` that does the same.
- **Superseded**: the scene's server object with storage (`scene.ts`, `serverMerge.ts`, the public content cache) is replaced by a memory-only relay.

### S10. The batch path is a chain of nine functions that each call the next
- **Area**: Worker: scene Durable Object (scene.ts, serverMerge.ts, shared.ts)
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `online/worker/scene.ts:2058-2453`
- **Description**: `onBatch → admitBatch → checkBatchCounter → checkBatchEvents → validateBatchEvents → applyBatchBases → mapBatchFonts → stampBatch → checkBatchResult → acceptBatch` pass `input, events, fontIds, remap, output` along and return the next call. The numbered steps ("1. bases" … "7. durable") are spread over them. The split has real costs: `cleanReadable` runs three times per element event (`validEvent`, `batchEntryVersion`, `stampBatchEvent`), the pending-bytes limits are checked twice (`2344-2349` and `2404-2406`), and the second check answers `accountPendingBytes` also when the scene-wide limit was hit. Small helpers such as `addDayPin`, `unpinPreviousResult`, `knownKeyStatus`, `seedOnBehalf` exist only to move a branch out of its function.
- **Suggested fix**: One `onBatch` that calls steps returning `{ refuse } | value` in sequence; validate each event once and keep the cleaned readable.
- **Superseded**: the scene's server object with storage (`scene.ts`, `serverMerge.ts`, the public content cache) is replaced by a memory-only relay.

### S11. Comments and names that say something else than the code
- **Area**: Worker: scene Durable Object (scene.ts, serverMerge.ts, shared.ts)
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `online/worker/scene.ts:1344-1346`, `2455-2465`, `1104-1105`, `1588`, `185-187`; `online/worker/shared.ts:7`
- **Description**: `revokeTab` has two doc comments that contradict each other and ignores `body.tab` (it closes all of the account's connections). The doc comment of `referenceProblem` sits above `fileUse`. A revoked account is answered "Too many connections to this scene". `reconcileToken` says the one-time token is "used for these checks only", but it is kept as `lastAccess` for 30 minutes and can upload a repair version (`recoverSaves → repairUpload`). `CONFIRMED_FRESH_MS` describes a rule the code does not have (see Dead code). `shared.ts` says `?v=` serves "that version".
- **Suggested fix**: Correct the comments; rename `revokeTab` to `revokeAccount`.
- **Superseded**: the scene's server object with storage (`scene.ts`, `serverMerge.ts`, the public content cache) is replaced by a memory-only relay.

### S12. Avoidable work inside loops
- **Area**: Worker: scene Durable Object (scene.ts, serverMerge.ts, shared.ts)
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `online/worker/scene.ts:2879-2889`, `2612-2624` with `2354-2377`
- **Description**: `restoreSeedAuthors` calls `this.num("maxDeleted")` (a SQL read) for every snapshot entry, up to 50,000 billed row reads for one check. `freeIndex` copies and sorts all indices of the scene for every entry that needs a new index; a batch of several thousand elements without a usable index against a large scene can run into the CPU limit and is then never accepted.
- **Suggested fix**: Read `maxDeleted` once; sort the indices once per batch and insert the new ones.
- **Superseded**: the scene's server object with storage (`scene.ts`, `serverMerge.ts`, the public content cache) is replaced by a memory-only relay.

### S14. `/revoke-tab` revokes the account, and its `tab` argument is never read
- **Area**: Worker: routes, auth, OAuth, folders, stats
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `online/worker/sceneRoutes.ts:419-424`, `:480`; `online/worker/scene.ts:1344-1355`
- **Description**: The route name, the parameter and the first doc comment say "that tab's connection ends"; the code closes every connection of the account on the scene and blocks its batches. The Worker passes `tab`, the object ignores it. This misled the rate-limit handling above.
- **Suggested fix**: Rename to `/revoke-account` (or honour `tab`) and drop the unused argument.
- **Superseded**: the scene's server object with storage (`scene.ts`, `serverMerge.ts`, the public content cache) is replaced by a memory-only relay.

### S23. The tab and the DO disagree on which copy of an element's references is in force
- **Area**: Browser: live sync
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/online/liveCrypto.ts:124-143`, `scenes-plugin/src/online/liveProtocol.ts:343-361`, `online/worker/serverMerge.ts:126-167`
- **Description**: Tabs build an element from the encrypted content and put only id, version, nonce, `isDeleted`, index and the font number on top. The DO, when it writes Drive's file, overwrites bindings, container, frame, groups, file id and bound elements from the readable part ("what is saved is what was checked"). An event whose readable and encrypted references differ (a bug, or a crafted event of an editor) is shown one way live and saved another way, and the difference appears only after a reseed from Drive.
- **Suggested fix**: Put the readable references on top in `decodeElement` too (share `withReadableReferences`), or reject events whose two copies differ.
- **Superseded**: live sync's protocol and its docs are replaced.

### S24. Comments that contradict the code
- **Area**: Browser: live sync
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/online/liveSync.ts:227`, `:3351` ("undoable"; `edit` uses `CaptureUpdateAction.NEVER` at `:280`, deliberate since commit cb2e93d); `scenes-plugin/src/online/liveProtocol.ts:343-347` (says `frameId` is taken out; the code keeps it); `scenes-plugin/src/online/liveCrypto.ts:8-10`; `scenes-plugin/src/online/liveMerge.ts:200-205` (the doc of `writerChanged` sits on `intent`); `scenes-plugin/src/online/liveSync.ts:3521-3525` (two stacked docs, the first describes the old order); `:146-147` (`LiveHost.changed`); `docs/live-sync/PROTOCOL.md` §7 ("re-stamp on canvas"; `:2559`, `:2564-2566` say the canvas is not re-stamped)
- **Description**: Each of these states a behaviour the code does not have, in the engine where the comments are the main guide to deliberate choices.
- **Suggested fix**: Correct or remove them.
- **Superseded**: live sync's protocol and its docs are replaced.

### S25. Test and debug hooks live inside the engine
- **Area**: Browser: live sync
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/online/liveSync.ts:528`, `:547-573`, `:1667-1673`, `:2174-2176`, `:2421-2422`, `:2835`
- **Description**: `trace`, `traced`, `debugCopy` (writes to `localStorage`), `window.__liveSeedDelayMs` and the `source` string of `setConfirmed` (read only for tracing, and only when it is `"refused"`) run through the production paths. The condition at `:2174` reduces to `el.isDeleted && !view`.
- **Suggested fix**: Put tracing behind one optional observer object passed in by tests.
- **Superseded**: the browser's live sync engine (`liveSync.ts`, `liveQueue.ts`, `liveMerge.ts`) is replaced by the pen-and-relay client.

### S43. The server's check of comment text and pin is a 32-bit fingerprint (Astra)
- **Area**: MCP server and shared modules (scenes-mcp)
- **Severity**: low
- **Confidence**: confirmed for the code (noted by the Astra review; no collision was constructed)
- **Location**: `scenes-mcp/sceneComments.mjs:288-296` (`shortHash`, FNV-1a, 8 hex), used by `commentReadable` at `:299-307`
- **Description**: What a commenter may change is enforced on hashes of the comment's text and pin. A 32-bit FNV hash is easy to collide on purpose, so a commenter with a modified client could replace another author's text by one with the same hash. The comment says "enough to notice a changed text (not a secret)", which holds against accidents, not against intent. Belongs with "A commenter can change the author name".
- **Suggested fix**: Use SHA-256 (truncated to 128 bits is enough) for the readable part.
- **Superseded**: the server no longer checks comments (no readable parts).

## Dead code

### D3. The "confirmed" map is written on every connect, renewal and save but never read
- **Area**: Worker: scene Durable Object (scene.ts, serverMerge.ts, shared.ts)
- **Severity**: low
- **Confidence**: confirmed (repo-wide search; the only readers are pruning, `devStats` and the `left` test in `retention`)
- **Location**: `online/worker/scene.ts:185-187`, `955-967`, `1140`, `1330`, `3808`, `4115`, `3512-3518`, `3542`
- **Description**: `confirmed(sub)` stores account id and time in `meta` and plans the retention job. The rule it was made for ("an access confirmed this recently makes a 'not found' mean 'gone'") is not in the code: `verificationRefused` decides by `sub === owner` alone. It costs a row write per call and keeps account ids for nothing.
- **Suggested fix**: Remove the map, `CONFIRMED_FRESH_MS` and its pruning, or implement the rule.
- **Superseded**: the scene's server object with storage (`scene.ts`, `serverMerge.ts`, the public content cache) is replaced by a memory-only relay.

### D4. Batch fields that are stored and never used
- **Area**: Worker: scene Durable Object (scene.ts, serverMerge.ts, shared.ts)
- **Severity**: low
- **Confidence**: confirmed for the DO (search in `scene.ts`); likely for the wire fields (no reader found in `liveSync.ts`, `ui.tsx`)
- **Location**: `online/worker/scene.ts:150`, `155`, `477-478`, `625`, `637`, `2395-2397` (`live`, `command`); `766-778` (`author` = `pseudonym`, `name`); `4406`, `4422` (`needCredential`)
- **Description**: `Batch.live` (and the `live` column) and `Batch.command` are written with every batch and loaded again, but no decision reads them; `command` is described in the protocol as "so a retry never applies twice", which the DO does not do. `StampedBatch.author` always equals `pseudonym`, and `name` comes from the memory-only `names` map; the client reads neither. `needCredential` is only read by `devStats`.
- **Suggested fix**: Drop the fields (or implement the `command` de-duplication if it is wanted).
- **Superseded**: the scene's server object with storage (`scene.ts`, `serverMerge.ts`, the public content cache) is replaced by a memory-only relay.

### D5. Exports of serverMerge.ts that nothing imports
- **Area**: Worker: scene Durable Object (scene.ts, serverMerge.ts, shared.ts)
- **Severity**: low
- **Confidence**: confirmed (repo-wide search without upstream clones and node_modules)
- **Location**: `online/worker/serverMerge.ts:63`, `71`, `97`, `198`, `271`, `284`, `443`; `online/worker/scene.ts:88`
- **Description**: `decryptContent`, `repairGraph`, `DEFAULT_SETTINGS`, `FileMeta`, `toBase64`, `fromBase64` are used only inside the file (the tests import `toBase64` from `liveCrypto`). The re-export `export { readableOf } from …liveProtocol` has no importer (`scene.ts` imports it from `liveProtocol`). `SceneEnv` is exported but used only in `scene.ts`.
- **Suggested fix**: Remove `export` from these and delete the re-export.
- **Superseded**: the scene's server object with storage (`scene.ts`, `serverMerge.ts`, the public content cache) is replaced by a memory-only relay.

### D6. Unreachable comparison in `sameContent`
- **Area**: Worker: scene Durable Object (scene.ts, serverMerge.ts, shared.ts)
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `online/worker/serverMerge.ts:258-260`
- **Description**: Inside `if (a.isDeleted || b.isDeleted)` the expression `!!a.isDeleted === !!b.isDeleted && (a.isDeleted || JSON.stringify(…) === …)` reaches its right side only when both are deleted, so `a.isDeleted` is true and the JSON comparison never runs.
- **Suggested fix**: `return !!a.isDeleted === !!b.isDeleted;`
- **Superseded**: the scene's server object with storage (`scene.ts`, `serverMerge.ts`, the public content cache) is replaced by a memory-only relay.

### D12. Unused exports and fields
- **Area**: Browser: live sync
- **Severity**: low
- **Confidence**: confirmed (repo-wide search over scenes-plugin, online, scenes-mcp, scenes-server, scripts)
- **Location**: `scenes-plugin/src/online/liveQueue.ts:116-117` (`currentCounter`), `:54` (`QueuedBatch.seq`), `:60` (`rebased`), `:240` (`CommandRecord.revision`); `scenes-plugin/src/online/liveProtocol.ts:308-323` (`READABLE_KEYS`); `scenes-plugin/src/online/liveSync.ts:4082` (`DECIDE_AFTER_HOURS`), `:389` (`Flight.ids`), `:308`, `:338-342` (`memorySurface().load`)
- **Description**: `currentCounter`, `READABLE_KEYS`, `DECIDE_AFTER_HOURS` and `memorySurface().load` have no user. `Flight.ids` is filled at `:2511` and `:2830` and never read. `QueuedBatch.seq` is written at `liveSync.ts:2596` and never read; `rebased` is written at `:3113` and read only by tests; `CommandRecord.revision` is written at `:3424` (which builds a whole snapshot for it) and never read. `batchKey` is exported only for a test.
- **Suggested fix**: Remove them (and the `this.revision()` call at `:3424`).
- **Also in the Astra review**: F18. It adds two fields that are written and never read: `seeded` (`liveSync.ts:517`, `:1665`) and `fontRemap` (`:2666`, `:2700`); checked by me.
- **Superseded**: the browser's live sync engine (`liveSync.ts`, `liveQueue.ts`, `liveMerge.ts`) is replaced by the pen-and-relay client.

### D13. Protocol fields the tab never sends
- **Area**: Browser: live sync
- **Severity**: low
- **Confidence**: confirmed (the only `hello` and `seed` senders are in liveSync.ts)
- **Location**: `scenes-plugin/src/online/liveSync.ts:1030` (`revision: null`), `:1674-1675`; `scenes-plugin/src/online/liveProtocol.ts:121-122` (`WireScene.meta`), `:163`, `:188-193` (`seed.kurviq`); `online/worker/scene.ts:1979-1982`
- **Description**: `hello.revision` is always null, so the DO's branch "loaded exactly the last save" can never be taken. The seed never carries `kurviq` or `meta` (the comment at `:1674` says the DO reads them from Drive itself), yet the types still describe them as sent.
- **Suggested fix**: Remove the fields and the unreachable branch.
- **Superseded**: the browser's live sync engine (`liveSync.ts`, `liveQueue.ts`, `liveMerge.ts`) is replaced by the pen-and-relay client.

### D14. Parameters and hooks without effect
- **Area**: Browser: live sync
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/online/liveSync.ts:236` (`_scene`, passed at `:3950`, `:3973`), `:233`, `:304`, `:337`, `:3658` (`Surface.destroy`), `:3914-3916` (`startHeadless(..., tab?)`), `:1782`
- **Description**: `canvasSurface` never uses `_scene`; both surfaces implement `destroy` as an empty function; the only caller of `startHeadless` passes no `tab`; in `:1782` the clause `(!before && !theirs)` is covered by `!theirs`.
- **Suggested fix**: Remove them.
- **Superseded**: the browser's live sync engine (`liveSync.ts`, `liveQueue.ts`, `liveMerge.ts`) is replaced by the pen-and-relay client.

### D35. `commenterRefusal` is used only by its test
- **Area**: MCP server and shared modules (scenes-mcp)
- **Severity**: low
- **Confidence**: confirmed (repo-wide search; `online/worker/scene.ts:2158` is a private method of the same name that calls `commenterReadableRefusal`)
- **Location**: `scenes-mcp/sceneComments.mjs:253-279`, `scenes-mcp/sceneComments.d.mts:48`
- **Description**: The server checks readable parts only. The full-comment variant is a second copy of the rule that production never runs.
- **Suggested fix**: Remove it and its test, or express it through `commentReadable` + `commenterReadableRefusal`.
- **Superseded**: `commenterRefusal` becomes the editor tab's check of commenters' comments.

## Duplications

### U1. The scene key crypto exists twice
- **Area**: Worker: scene Durable Object (scene.ts, serverMerge.ts, shared.ts)
- **Severity**: medium
- **Confidence**: confirmed
- **Location**: `online/worker/serverMerge.ts:63-123` and `scenes-plugin/src/online/liveCrypto.ts:27-87`
- **Description**: `toBase64`, `fromBase64`, `importSceneKey`, `encryptContent`/`decryptContent` are copies of `toBase64`, `fromBase64`, `importSceneKey`, `encryptJson`/`decryptJson`. `liveCrypto.ts` is pure WebCrypto ("runs in the browser and in node") and the Worker already imports `liveProtocol` and `frames` from the same folder. The copies have drifted: only the client checks that the key has 32 bytes. A change to IV length or the additional data must be made in both or saved content becomes unreadable.
- **Suggested fix**: Import them from `liveCrypto.ts` in `serverMerge.ts`.
- **Also in the Astra review**: F51.
- **Superseded**: the Worker's copy of the tab's logic goes with the scene object; one copy remains.

### U2. Two discards
- **Area**: Worker: scene Durable Object (scene.ts, serverMerge.ts, shared.ts)
- **Severity**: medium
- **Confidence**: confirmed
- **Location**: `online/worker/scene.ts:3060-3121` and `3575-3625`
- **Description**: Marking rows `discarded`, deleting chunks, `addDiscarded`, dropping tokens of authors with nothing left, refusing the batches at their tabs: written twice, with different repairs (see the ghost-element bug above).
- **Suggested fix**: One function with a flag for "store the repair as a batch".
- **Superseded**: the scene's server object with storage (`scene.ts`, `serverMerge.ts`, the public content cache) is replaced by a memory-only relay.

### U7. The file's `kurviq` record is parsed in two places, with different rules
- **Area**: Worker: scene Durable Object (scene.ts, serverMerge.ts, shared.ts)
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `online/worker/scene.ts:2789-2809` with `2732-2741`, and `2856-2872` with `2879-2889`
- **Description**: `seedAttribution`/`seedOnBehalf`/`commitSeedSnapshot` and `verifySeedRecord`/`restoreSeedAuthors` both read authors, receipts and the on-behalf list, including the identical `foldCounters(tab, [...extra, mark], mark)` loop. They differ: the first cuts `by`/`for` to 40 characters, the second stores them at any length (they are written back into every saved file); the first merges receipts with those kept, the second clears them first.
- **Suggested fix**: One `takeRecord(record)` used by both.
- **Superseded**: the scene's server object with storage (`scene.ts`, `serverMerge.ts`, the public content cache) is replaced by a memory-only relay.

### U8. Small helpers the tab already has
- **Area**: Worker: scene Durable Object (scene.ts, serverMerge.ts, shared.ts)
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `online/worker/serverMerge.ts:169-191` vs `scenes-plugin/src/online/liveMerge.ts:176-194` (cut dangling references); `serverMerge.ts:273-282` vs `liveMerge.ts:157-171` (`byIndex`, with opposite places for an element without index: first on the server, last in the tab); `scene.ts:354` vs `liveMerge.ts:153-154` (`receiptHas` / `inReceipt`); `scene.ts:299-333` vs `liveMerge.ts:63-88` (`touchesOf` / `touchedBy`, with different prefixes `f#` and `font:`); `scene.ts:288-290` vs `scenes-plugin/src/fonts.ts:39` (font id range); `serverMerge.ts:57` vs `liveMerge.ts:33` (`randomNonce`)
- **Description**: The same rules in two files each; the z-order rule already differs.
- **Suggested fix**: Move the pure ones into `liveProtocol.ts` (or `liveMerge.ts`) and import them in the Worker.
- **Superseded**: the Worker's copy of the tab's logic goes with the scene object; one copy remains.

### U9. Repeated blocks inside scene.ts
- **Area**: Worker: scene Durable Object (scene.ts, serverMerge.ts, shared.ts)
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `online/worker/scene.ts:1941-1959` vs `2923-2945` (the welcome message); `1398-1405` vs `3669-3676` (stored token, else `lastAccess` if it is theirs); `2422-2424`, `3029-3031`, `3096-3098`, `3171-3173` (store the token if the author has none); `1189-1194` vs `1295-1299` (trashed / restored)
- **Description**: Each block is written out again; the welcome copies already differ in how `openToken` is filled.
- **Suggested fix**: `welcome(att, mode, extra)`, `tokenOf(sub)`, `ensureToken(sub, sealed)`, `applyTrashState(trashed)`.
- **Superseded**: the scene's server object with storage (`scene.ts`, `serverMerge.ts`, the public content cache) is replaced by a memory-only relay.

### U19. Repeated blocks inside liveSync.ts
- **Area**: Browser: live sync
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/online/liveSync.ts:801-809`, `:1137-1145`, `:2768-2774` (other tabs' queued ids); `:2127-2143` and `:2390-2401` (`viewOf` contains `viewOfBatches`); `:261-282` (`apply` and `edit` of the canvas surface differ in one condition; `:324-335` are identical); `:1591`, `:1592`, `:1609`, `:3505` (inline nonce instead of `randomNonce`, `liveMerge.ts:33`); `:1594`, `:1654` (seed settings); `:1605`, `:1658` (each font hashed twice); `:172-180` and `liveMerge.ts:316-321` (the same string comparator; two more copies in `serverMerge.ts:233-241` and `elementContent.mjs:18-23`); `:152` (`keyOf` only renames `eventKey`)
- **Description**: Each is the same logic kept in several places; the three "other tabs' pending" copies already differ in what they collect (elements only, or all event keys).
- **Suggested fix**: One helper each; let `viewOf` call `viewOfBatches`; use `eventKey` directly.
- **Superseded**: the Worker's copy of the tab's logic goes with the scene object; one copy remains.

### U26. Sorting by fractional index, three times
- **Area**: Browser: controller, storage, router, merge
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `scenes-plugin/src/merge.ts:78-82`; `scenes-plugin/src/online/liveMerge.ts:157-173`; `online/worker/serverMerge.ts:273-282`
- **Description**: Three comparators with different treatment of a missing index (`""` first in `merge.ts` and the Worker, last and stable in `liveMerge.byIndex`).
- **Suggested fix**: Use `byIndex` in `merge.ts`.
- **Superseded**: the Worker's copy of the tab's logic goes with the scene object; one copy remains.

## Over-engineering

### O3. `outboxChain` serialises something that is already serial
- **Area**: Worker: scene Durable Object (scene.ts, serverMerge.ts, shared.ts)
- **Severity**: low
- **Confidence**: confirmed (`flushOutbox` has one caller, `runTimer`)
- **Location**: `online/worker/scene.ts:406`, `3269-3301`
- **Description**: "One drain at a time" is guaranteed by the alarm (alarms never overlap, and the loop awaits the drain). The promise chain and its two `catch(() => {})` guard against a second caller that does not exist.
- **Suggested fix**: Make `flushOutbox` a plain `async` loop.
- **Superseded**: the scene's server object with storage (`scene.ts`, `serverMerge.ts`, the public content cache) is replaced by a memory-only relay.

### O4. Test hooks and cost counters run in the production paths
- **Area**: Worker: scene Durable Object (scene.ts, serverMerge.ts, shared.ts)
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `online/worker/scene.ts:413-464`, `504-513`, `1022-1034`, `1474-1586`, `4283-4285`, `4299`
- **Description**: About 200 lines of the object are for tests: metrics, `devEnv` (an `Object.create(env)` proxy), `dcall`/`genv`, two row counters, `devAge`, `devCrash`, `devRace`, `crashPoint`, `devExpire`, `dev-drop-tabs`. In production every upload still does three `meta` reads for them (`devRace`, two `crashPoint`s), and the `/dev-*` routes of the object rely on the Worker's gate alone (the object does not check `devOn`).
- **Suggested fix**: Guard the hooks with `this.devOn` at the call sites (and in `handleFetch`), and move them into a subclass or a separate module used only with the fake Google.
- **Superseded**: the scene's server object with storage (`scene.ts`, `serverMerge.ts`, the public content cache) is replaced by a memory-only relay.

### O8. `Surface.edit` next to `Surface.apply`
- **Area**: Browser: live sync
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/online/liveSync.ts:221-234`, `:261-282`, `:324-335`, `:618-622`
- **Description**: `edit` was the undoable variant. Since agent edits no longer enter the undo history, both methods do the same in both surfaces (the canvas one differs only in always calling `updateScene`), and the wrapper in the constructor guards both alike. Together with the empty `destroy` and the unused `load`, the interface has four members without a purpose.
- **Suggested fix**: Keep `apply` only.
- **Superseded**: the browser's live sync engine (`liveSync.ts`, `liveQueue.ts`, `liveMerge.ts`) is replaced by the pen-and-relay client.

### O9. A fallback counter for a batch that can never be sent
- **Area**: Browser: live sync
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/online/liveSync.ts:2346-2352`, `:2406-2417`, `:2503-2504`
- **Description**: When `nextCounter` fails, `enqueue` invents a counter from the batches in memory. Such a batch then also fails `persist`, stays in `unstored`, and `sendBatch` returns before sending it. The invented counter is never used on the wire; if it ever were, it could repeat one the DO already knows (counters must only grow) and be answered as a duplicate.
- **Suggested fix**: Mark the scene "unsaved" and keep the changes in the draft instead of building a batch with a made-up counter.
- **Superseded**: the browser's live sync engine (`liveSync.ts`, `liveQueue.ts`, `liveMerge.ts`) is replaced by the pen-and-relay client.
