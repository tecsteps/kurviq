# Code review: Worker: routes, auth, OAuth, folders, stats

Status: open

Findings of the code review of 2026-11-13 (see `2026-11-13-code-review.md`) in the area **Worker: routes, auth, OAuth, folders, stats**, still open after the triage against the two specs of the same day. 26 findings: 0 high, 4 medium, 22 low. Ids as in the review (B bug, S smell, D dead code, U duplication, O over-engineering). A finding that is fixed gets a line "- **Status**: fixed in <commit>".

## Potential bugs

### B14. The local-install sign-in hands a Drive session to any `*.test` / localhost address named in a link
- **Area**: Worker: routes, auth, OAuth, folders, stats
- **Severity**: medium
- **Confidence**: likely (flow traced in code; not exercised against real Google)
- **Location**: `online/worker/auth.ts:401-417` (`isLocalOrigin`), `:424-438` (`safeReturn`), `:500-514` (`finish`), `:701-715` (`authLogin`)
- **Description**: `GET /auth/login?return=http://anything.test/x` is accepted without any confirmation on kurviq.com: after Google's account chooser (and, when no refresh token came back, the consent screen for the already trusted app "Kurviq") the sealed session, refresh token included, is appended to the fragment of that address. The blob is bound to the origin (`lo`), but the origin is the attacker's own and `/auth/token` only compares it with the `Origin` header, which a script outside a browser sets freely. `.test` names do not exist in public DNS, so whoever answers DNS on the victim's network (public Wi-Fi, a compromised router) can serve `http://x.test`; plain http is allowed too. Scenario: the victim, on such a network, follows a link to `https://kurviq.com/auth/login?return=http://x.test/`, picks their account, and the attacker's page receives a session that mints Drive access tokens for all of the victim's Kurviq files for 90 days and longer (renewed with every refresh). `pageState` does not help: it is optional and chosen by whoever starts the flow.
- **Suggested fix**: Before redirecting to Google for a local return address, show a page on kurviq.com that names the address and needs a click ("Sign in the Kurviq running at http://x.test?"); and/or allow only loopback (`localhost`, `127.0.0.1`, `[::1]`) by default, as Google itself does for native apps, with `.test` behind an explicit opt-in.
- **Status**: fixed 2026-11-13 (a *.test return address gets a confirmation page on kurviq.com, POST /auth/login from Kurviq's own page only; loopback goes on directly)

### B16. Feedback can be stored without limit: per-IP check only, not atomic, no overall cap
- **Area**: Worker: routes, auth, OAuth, folders, stats
- **Severity**: medium
- **Confidence**: confirmed (traced in code)
- **Location**: `online/worker/feedback.ts:70-83`, `:95-108`; compare `online/worker/contact.ts:38-41`, `:76`, `:283-293`
- **Description**: `/api/feedback` limits 10 reports per hour per keyed hash of the full `CF-Connecting-IP`. An IPv6 client changes its address inside its own /64 at will, so each request is a new sender; there is no total-per-day cap (contact.ts has `ALL_PER_DAY` and keys IPv6 by /64 for exactly this reason), and the `Origin` check is no obstacle for a script. The count and the insert are two statements, so parallel requests from one sender also pass together. Result: anybody can fill the D1 database (10 kB per row), which also holds statistics, short links and folder shares. The request body is read completely (`request.text()`) before the 10,000 character check.
- **Suggested fix**: Reuse contact.ts's approach: `senderKey` (/64), one `INSERT ... SELECT ... WHERE (count) < limit` statement, and a global daily cap; read the body with a bounded reader.
- **Also in the Astra review**: F28 (the count and the insert are not atomic).
- **Status**: fixed 2026-11-13 (one INSERT … SELECT with the per-sender hour quota and a daily cap of 500 for all; IPv6 keyed by /64; body read bounded)

### B18. OAuth authorization codes can be redeemed more than once (Astra F26)
- **Area**: Worker: routes, auth, OAuth, folders, stats
- **Severity**: medium
- **Confidence**: confirmed (found and reproduced by the Astra review with the bundled module: the same code exchanged twice, both HTTP 200; code traced by me)
- **Location**: `online/worker/oauth.ts:385-396` (`exchangeCode`)
- **Description**: The module calls its codes one-time codes, but a code is a sealed, stateless value: `exchangeCode` decrypts and checks it and never records that it was used. The same code, client, return address and verifier mint any number of independent access / refresh token pairs within the code's 60 seconds, also after the real client redeemed it. PKCE still protects a code without its verifier, so this is a replay gap, not a way in with the code alone.
- **Suggested fix**: Give each code a nonce and consume it atomically before issuing tokens (the pairing Durable Object or D1, kept until the code expires); refuse a second exchange.
- **Status**: fixed 2026-11-13 (codes carry an id; the pairing Durable Object redeems it once, kept until the code expires)

### B63. Shared page: a revalidated page keeps its old title, preload and short-link target
- **Area**: Worker: scene Durable Object (scene.ts, serverMerge.ts, shared.ts)
- **Severity**: low
- **Confidence**: uncertain (I could not check whether the assets binding answers 304 here and whether the rewritten response keeps the ETag)
- **Location**: `online/worker/shared.ts:147-159`, `188-190`
- **Description**: The page is fetched from the assets with the visitor's request headers, `If-None-Match` included, and the rewritten answer is sent with `Cache-Control: no-cache` and the asset's validators. On the next visit the assets answer 304 (no `text/html` content type), the function returns that 304 unchanged, and the browser shows its stored copy with the old `<title>`, the old `kurviq-pub` meta (name and file id) and the old preload, even if the short link now points to another file or the scene is no longer public.
- **Suggested fix**: Fetch the asset without the conditional headers and send the rewritten page without `ETag`/`Last-Modified` (or with an ETag that includes file id and name).
- **Update 2026-11-13 (specs)**: Moved here from the scene-object area: the shared page (`handleSharedPage` in `shared.ts`) stays.
- **Status**: fixed 2026-11-13 (asset fetched without If-None-Match / If-Modified-Since, rewritten page sent without ETag / Last-Modified)

### B64. A short link of a deleted or binned scene can never be freed
- **Area**: Worker: routes, auth, OAuth, folders, stats
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `online/worker/pubLinks.ts:63-73`, `:145-156`, `:106-116`
- **Description**: Freeing or moving a name requires `canEdit`, which answers "no-access" when the file is trashed or gone (`capabilities.canEdit && !trashed`). So once a scene with a short link is deleted, `DELETE /api/pub/<name>` is refused even for its owner, a new claim of the name answers "already taken", and nothing ever removes the row. Global, first-come names are lost for good.
- **Suggested fix**: Allow the delete when Drive says the file is trashed and owned by the caller; free names whose file is gone (404 with a valid token is ambiguous under drive.file, so do it for `trashed` at least) or expire them in the retention job after a check.
- **Status**: fixed 2026-11-13 (the owner may free the name of a trashed file; claiming still needs edit rights on a file outside the bin)

### B65. A command to a tab that disconnects waits out the full timeout
- **Area**: Worker: routes, auth, OAuth, folders, stats
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `online/worker/pairing.ts:123-141`, `:308-312`
- **Description**: `webSocketClose` does not look at `pending`. If the tab that received a command closes (tab closed, reload, network loss), the agent's request hangs for 30 or 75 seconds and then reports "did not answer ... may be busy", although the object knows the tab is gone and another tab may be open. Also, when `sendMessage` throws inside the promise executor (socket already closing), the promise rejects but its timer and `pending` entry stay until the timeout.
- **Suggested fix**: In `webSocketClose` reject (and clear the timers of) all pending entries whose `tab` is the closed socket's tab id, with a 409 "the tab was closed"; wrap `sendMessage` in try/catch that cleans up.
- **Status**: fixed 2026-11-13 (webSocketClose rejects the closed tab's pending commands with 409; a failed send cleans up at once)

### B66. Malformed percent-encoding in a path gives a 500
- **Area**: Worker: routes, auth, OAuth, folders, stats
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `online/worker/folderRules.ts:168`, `:331`; `online/worker/pubLinks.ts:176`
- **Description**: `decodeURIComponent` throws `URIError` for input such as `%E0%A4%A`. In `classifyRead` / `classifyWrite` the path comes from the request body, in `handlePubApi` from the URL (`GET /api/pub/%zz`, no sign-in needed). `dispatch` in folders.ts rethrows everything that is not a 503, so the Worker answers with an unhandled exception instead of a refusal (stats.ts `entryOf` guards the same call with try/catch).
- **Suggested fix**: Catch the error and answer `{ refused: "call not allowed" }` / 404.
- **Update 2026-11-13 (specs)**: Only `pubLinks.ts` remains (malformed percent-encoding → 400); `folderRules.ts` goes.
- **Status**: fixed 2026-11-13 (pubLinks: malformed percent-encoding → 400)

### B67. The contact form's IPv6 rate-limit key is wrong for compressed addresses
- **Area**: Worker: routes, auth, OAuth, folders, stats
- **Severity**: low
- **Confidence**: confirmed (checked with node: `2001:db8::1:2` -> `2001:db8::1::/64`)
- **Location**: `online/worker/contact.ts:76`
- **Description**: `ip.split(":").slice(0, 4)` assumes four written-out groups. When "::" falls inside the first four groups, host bits end up in the key, so addresses of one /64 get different keys (and the result is not a valid prefix). Only prefixes with zero groups are affected and the global daily cap still holds, hence low.
- **Suggested fix**: Expand "::" to the full eight groups before taking the first four.
- **Also in the Astra review**: F30.
- **Status**: fixed 2026-11-13 (senderKey expands "::" first; shared by contact and feedback)

### B68. Folder and scene routes buffer large bodies before any sign-in check
- **Area**: Worker: routes, auth, OAuth, folders, stats
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `online/worker/folders.ts:542-552` (limit `DRIVE_BODY_BYTES` = 35 MB), `online/worker/index.ts:141-145`, `online/worker/oauth.ts:312-319`, `:333`, `online/worker/pubLinks.ts:89-92`
- **Description**: sceneRoutes.ts deliberately checks the cookie before parsing a body (`:653-660`). `/folders/<id>/drive` does not: any client that sends `Origin: https://kurviq.com` gets up to 35 MB read, decoded and `JSON.parse`d before `signedIn` runs (memory and CPU of the isolate). `handleUpload` trusts `Content-Length` and then calls `arrayBuffer()` on whatever arrives (a chunked body is read fully before the size check), and `/oauth/register`, `/oauth/token` and `POST /api/pub` read unbounded bodies (`request.json()` / `request.text()`).
- **Suggested fix**: In `handleFolderRoutes` check `cookieSession` (non-local) before reading, as sceneRoutes does; use one bounded reader (see the duplication finding) for upload, OAuth and pub bodies.
- **Update 2026-11-13 (specs)**: Only `/oauth/register`, `/oauth/token`, `POST /api/pub` and uploads remain; the folder route goes.
- **Status**: fixed 2026-11-13 (one bounded reader for /oauth/register, /oauth/token, POST /api/pub and uploads)

### B69. OAuth: a loopback registration also matches other URL schemes
- **Area**: Worker: routes, auth, OAuth, folders, stats
- **Severity**: low
- **Confidence**: confirmed (checked with node: `javascript://localhost/%0Aalert(1)//` has hostname `localhost` and the same pathname as `http://localhost/%0Aalert(1)//`)
- **Location**: `online/worker/oauth.ts:82-95`, used at `:260`, `:360`; sinks at `:242`, `:247-248`, `:274-277`
- **Description**: `redirectMatches` checks the registered URI's protocol (`a.protocol === "http:"`) but not the presented one. A client registered with `http://localhost/x` may therefore present `javascript://localhost/x`, `myapp://localhost/x` or `https://localhost/x`. The page then assigns that value to `location.href` (deny and allow). Script execution is stopped only by the page's nonce CSP; a custom scheme would deliver the code to whatever app handles it, while the page tells the user "It asks from localhost".
- **Suggested fix**: Require `b.protocol === "http:"` in the loopback branch (and run `allowedRedirect(uri)` on the presented URI as well).
- **Also in the Astra review**: F27 (reproduced there: `/oauth/approve` returned a redirect to `ftp://localhost:1234/callback` for a client registered with `http://`). It adds: credentials and fragment of the presented address are not compared either.
- **Status**: fixed 2026-11-13 (the presented URI must pass allowedRedirect too: http only for loopback, no credentials, no fragment)

### B73. Statistics: the counters are deleted from the Durable Object before D1 confirmed them (Astra F29)
- **Area**: Worker: routes, auth, OAuth, folders, stats
- **Severity**: low
- **Confidence**: confirmed (found by the Astra review; traced in code by me)
- **Location**: `online/worker/stats.ts:562-580`
- **Description**: `flush` reads all pending hourly rows, deletes them, then awaits `db.batch`. They are put back only in the `catch` of the same invocation. If the object is evicted or crashes during the D1 call the counts are lost; if D1 committed but the answer was lost, they are put back and counted twice at the next flush. Usage numbers only, no scene data.
- **Suggested fix**: Delete the rows only after D1 answered, and make the write idempotent (a batch id per flush, or write absolute per-hour values instead of increments).
- **Status**: fixed 2026-11-13 (counts move to an "inflight" table under a batch id, D1 notes the id in stats_flushes in the same transaction; deleted only after D1 confirmed)

## Code smells

### S1. COOKIE_KEY is the key for a dozen unrelated things, and secrets.mjs rotates everything by default
- **Area**: Worker: routes, auth, OAuth, folders, stats
- **Severity**: medium
- **Confidence**: confirmed (traced in code)
- **Location**: `online/secrets.mjs:1-13`, `:33-44`; uses of the key: `online/worker/auth.ts:128-137` (session and state cookies, local sessions), `:374-379` (watch secret, raw key reused for HMAC), `online/worker/oauth.ts:147`, `:153`, `:256`, `:322-325`, `:339`, `:366` (client ids, codes, access/refresh tokens, upload tokens), `online/worker/sceneRoutes.ts:383-384` (tickets, proofs), `online/worker/feedback.ts:36`, `online/worker/contact.ts:96` (sender hashes), `online/worker/folders.ts:119` (member hashes)
- **Description**: The comment in secrets.mjs says a new COOKIE_KEY "signs every browser out of Google". In fact it also invalidates every agent's OAuth registration and tokens (agents must be removed and added again), every upload address, all Drive watch secrets (notifications of live scenes are dropped until the next renewal), the rate-limit history, and all `shared_folder_members` hashes (shared folders become undiscoverable until each owner registers again). There is no `COOKIE_KEY_PREVIOUS` as for TOKEN_KEY. And `npm run secrets` without arguments sets all five secrets, i.e. it generates a new COOKIE_KEY, TOKEN_KEY and PSEUDONYM_KEY, although the same file says of PSEUDONYM_KEY "never rotate it". The same AES key bytes are also used directly as an HMAC key (`watchSecret`), while `keyedHash` derives a sub-key first.
- **Suggested fix**: Make secrets.mjs require explicit names (no arguments: print usage, set nothing) and refuse to overwrite PSEUDONYM_KEY without a `--force`. Document the real blast radius; derive purpose keys (HKDF) from one master, or use separate secrets for agent tokens and hashes.
- **Also in the Astra review**: F46. It adds: a misspelled secret name makes the command succeed without setting anything.
- **Update 2026-11-13 (specs)**: `TOKEN_KEY`, `PSEUDONYM_KEY`, watch secrets and folder hashes go; COOKIE_KEY still covers cookies, agents' OAuth, uploads and rate limits, so `COOKIE_KEY_PREVIOUS` and a safer `npm run secrets` are still worth it.
- **Status**: fixed 2026-11-13 (COOKIE_KEY_PREVIOUS accepted by unseal; npm run secrets needs explicit names, refuses unknown names and PSEUDONYM_KEY without --force; blast radius documented. Purpose keys via HKDF not done)

### S13. "Is this a local development address" is decided by four different rules
- **Area**: Worker: routes, auth, OAuth, folders, stats
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `online/worker/auth.ts:52-71` (`devGate`), `:401-417` (`isLocalOrigin`: localhost, 127.0.0.1, *.localhost, *.test, http or https), `online/worker/google.ts:14-21` (`isLocal`: no *.test), `online/worker/stats.ts:217`, `:356` (regex: http://localhost or 127.0.0.1 only), `online/worker/sceneRoutes.ts:184` (`DEV_ORIGIN || origin`, no check), `online/worker/pubLinks.ts:136`
- **Description**: `devGate` accepts a `DEV_ORIGIN` of `http://x.test` (via `isLocalOrigin`), `googleUrls` then still uses the real Google (via `isLocal`), stats test hooks use a third rule, and `keepWatch` uses `DEV_ORIGIN` unchecked. `isLocalOrigin` also serves two different purposes: "the user's local install" (security boundary for sessions) and "this is a dev server". The differences are invisible at the call sites.
- **Suggested fix**: One exported `isDevOrigin` (loopback only) for the dev gates and `isLocalInstall` for the local install; use them everywhere.
- **Update 2026-11-13 (specs)**: Without `sceneRoutes.ts`; the other rules remain.
- **Status**: fixed 2026-11-13 (online/worker/origins.ts: isDevOrigin (loopback) for dev gates, google.ts, stats, the fake; isLocalInstall for the local install)

### S15. Doc comments separated from their functions
- **Area**: Worker: routes, auth, OAuth, folders, stats
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `online/worker/contact.ts:43-44` (the `senderKey` comment sits above `MAX_BODY`), `online/worker/stats.ts:501-502` (the `flush` comment sits above `closePeriods`), `online/worker/sceneRoutes.ts:255-256` (the `claimsOf` comment above `roleOf`), `online/worker/auth.ts:459-464` (two stacked comments above `Flow`), `online/worker/driveApi.ts:161` ("null: Drive did not answer", the function returns the `DriveAnswer`), `online/worker/stats.ts:213` ("daily retention job": it is hourly), `online/worker/index.ts:122-128`, `:195-199` (uploads documented as `POST /mcp/<key>/upload`, the real address is `/mcp/upload/<token>`), `online/wrangler.jsonc:4-6` (secrets list lacks TOKEN_KEY and PSEUDONYM_KEY)
- **Description**: Leftovers of extracting helpers: the comments now describe the wrong declaration or behaviour that changed.
- **Suggested fix**: Move or correct them.
- **Update 2026-11-13 (specs)**: Without the parts in `sceneRoutes.ts`.
- **Status**: fixed 2026-11-13

### S16. Tables are created at request time, per module, with a module-level flag
- **Area**: Worker: routes, auth, OAuth, folders, stats
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `online/worker/feedback.ts:33`, `:66-69`; `online/worker/contact.ts:93`, `:275-278`; `online/worker/folders.ts:102-116`; `online/worker/pubLinks.ts:41-50`; `online/worker/stats.ts:489-499`; consequence in `online/worker/retention.ts:34`
- **Description**: Five modules each run `CREATE TABLE IF NOT EXISTS` on the first request of every isolate (extra D1 round trips on cold starts, in the request path) and keep a global `schemaReady`. Because of it retention must parse "no such table" from error messages. A schema change (new column) has no place to go.
- **Suggested fix**: D1 migrations (`wrangler d1 migrations`) in the deploy; remove the flags and the error-message parsing.
- **Update 2026-11-13 (specs)**: Without `folders.ts`.
- **Status**: partly 2026-11-13: one schema module (online/worker/database.ts) makes all tables in one batch per isolate, used by feedback, contact, short links, stats and retention (no more "no such table" parsing); real `wrangler d1 migrations` in the deploy not adopted (needs the CI token's D1 permission checked: lead)

### S17. String surgery on SKILL.md / REFERENCE.md fails silently
- **Area**: Worker: routes, auth, OAuth, folders, stats
- **Severity**: low
- **Confidence**: confirmed (a test exists, `scenes-plugin/test/agentDocs.test.ts`, which limits the risk)
- **Location**: `online/worker/skill.ts:104-119`, `:122-133`
- **Description**: The online texts are made by regex replacements of exact sentences of the local skill. When a sentence in SKILL.md is reworded, `.replace` does nothing and the online agent is told about local file paths or `export_pdf` again; `text.indexOf("## Golden rules")` returning -1 would cut the text at the wrong place (`slice(-1)`).
- **Suggested fix**: Mark the local-only passages in the Markdown (e.g. `<!-- local -->…<!-- /local -->`) and cut by marker; throw at build time when a marker or heading is missing.
- **Status**: fixed 2026-11-13 (every replacement and heading is checked and throws "SKILL.md changed …"; agentDocs.test runs it before every deploy. Markers in the Markdown would need scenes-mcp: lead, optional)

## Dead code

### D7. The old agent link (key in the URL) is still routed through the whole MCP path
- **Area**: Worker: routes, auth, OAuth, folders, stats
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `online/worker/index.ts:76`, `:256-259`, `:335-348`, `:368-374`, `:491-495`; `online/worker/pairing.ts:28`, `:59-60`, `:85-88`, `:113-121`, `:147`, `:201`
- **Description**: `via: "link"` can never reach a tab (`tabs("link")` is always `[]`), yet `/mcp/<key>` still builds an upload token, a full MCP server and transport per request, counts the calls in `mcp_calls`, and asks the pairing object for its state; `/mcp/<key>/upload` reads and hashes up to 10 MB before the pairing refuses it. With no tab open the agent is first told "ask the user to open Kurviq (in the browser this agent link was made in)", and only after the user did so that the link does not work any more. The `Via` type, the `X-Kurviq-Via` header, `tabs(via)`, `notOpen()`'s second branch and the `unreachable` variant exist only for this.
- **Suggested fix**: Answer `/mcp/<key>` and `/mcp/<key>/upload` directly with the `legacyRefused` text (410 / a JSON-RPC error for tool calls) in index.ts and remove `via` from the pairing.
- **Status**: fixed 2026-11-13 (/mcp/<key> answers tool calls with the explanation, anything else 410; /mcp/<key>/upload 410 without reading the body; `via` removed from the pairing)

### D8. Exports nobody imports
- **Area**: Worker: routes, auth, OAuth, folders, stats
- **Severity**: low
- **Confidence**: confirmed (repo-wide `rg`, without excalidraw/, excalidraw-mcp/, node_modules, build output)
- **Location**: `online/worker/oauth.ts:97` (`protectedResourceMetadata`); `online/worker/folders.ts:86` (`FOLDERS_SCHEMA`); `online/worker/contact.ts:82` (`CONTACT_SCHEMA`); `online/worker/folderRules.ts:35` (`normalEmail`), `:107` (`Refusal`), `:244` (`isSceneFileName`), `:268` (`checkMetadata`); `online/worker/auth.ts:84` (`SCOPES`); `online/worker/driveApi.ts:55` (`DriveObserver`), `:142` (`FILE_FIELDS`, only the default of `getFile`; sceneRoutes.ts:69 has its own, different `FILE_FIELDS`); `online/worker/stats.ts:100-104` (`Count`, `StatsBatch`, `statsEnabled`), `:109` (`recordStats`), `:130` (`deviceOf`), `:140` (`entryOf`), `:168` (`isPageLoad`), `:285` (`hllPosition`), `:301` (`hllEstimate`)
- **Description**: These are used only inside their own file. The stats exports look made for unit tests, but no test imports them: stats.ts (page-load detection, entry mapping, HyperLogLog, hour/day rollover) has no unit test in the repo, although CLAUDE.md says the estimate is "tested: within ±3 %" and asks for unit tests with new logic.
- **Suggested fix**: Drop the `export` keywords, or add the tests the exports were meant for (stats first).
- **Update 2026-11-13 (specs)**: Without the exports of `folders.ts`, `folderRules.ts` and the scene routes.
- **Status**: fixed 2026-11-13 (exports dropped; the stats helpers kept exported and now tested: scenes-plugin/test/stats.test.ts)

### D9. `sessionCookieHeader` only renames `sessionCookie`
- **Area**: Worker: routes, auth, OAuth, folders, stats
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `online/worker/auth.ts:244-245`, `:611-612`
- **Description**: A second function with the same arguments and result, to export under another name.
- **Suggested fix**: Export `sessionCookie`.
- **Status**: fixed 2026-11-13

## Duplications

### U10. Four bounded body readers, and several unbounded reads
- **Area**: Worker: routes, auth, OAuth, folders, stats
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `online/worker/auth.ts:533-560` (`readBody`, "" when too big), `online/worker/driveApi.ts:24-50` (`readLimited`, null when too big), `online/worker/contact.ts:47-74` (`readBounded`, bytes); unbounded: `online/worker/feedback.ts:98`, `online/worker/pubLinks.ts:89`, `online/worker/oauth.ts:312-319`, `online/worker/index.ts:144`
- **Description**: The same stream loop three times with three conventions for "too big", while four other handlers read without a limit.
- **Suggested fix**: One `readLimited(body, max): Uint8Array | null` (text on top of it), used by all handlers.
- **Also in the Astra review**: its closing notes.
- **Status**: fixed 2026-11-13 (online/worker/bytes.ts readBytes / readText / readJson, used everywhere)

### U11. The request preamble of the cookie-or-local-session routes exists three times
- **Area**: Worker: routes, auth, OAuth, folders, stats
- **Severity**: low
- **Confidence**: confirmed
- **Location**: CORS preflight: `online/worker/auth.ts:742-753`, `online/worker/sceneRoutes.ts:689-699`, `online/worker/folders.ts:520-530`; "POST only, same site or local, read and parse the body": `online/worker/sceneRoutes.ts:645-673`, `online/worker/folders.ts:532-552`; "cookie session or local session": `online/worker/auth.ts:520-531`, `online/worker/sceneRoutes.ts:123`, `:471`, `:579`
- **Description**: Identical blocks; the copies already differ in a security-relevant detail (sceneRoutes checks the cookie before reading the body, folders does not, see above).
- **Suggested fix**: One `routeContext(request, env, maxBody)` in sceneRoutes.ts that returns the `Ctx` or the answer, and one `sessionOf(ctx)`.
- **Update 2026-11-13 (specs)**: `auth.ts` plus the relay's join check; `folders.ts` and most of `sceneRoutes.ts` go.
- **Status**: partly 2026-11-13: auth.ts exports requestSession and localPreflight for the relay; the other copies are in sceneRoutes.ts / folders.ts, which go

### U12. `refresh` and `accessFromRefresh`
- **Area**: Worker: routes, auth, OAuth, folders, stats
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `online/worker/auth.ts:248-263`, `:347-353`
- **Description**: Both exchange a refresh token and map the error to "unreachable" / "expired" with the same expression and the same expiry formula. `exchange` also has no timeout, while `revokeAtGoogle` has 15 s (`:194-203`, `:362`).
- **Suggested fix**: Build `refresh` on `accessFromRefresh` (which returns the scope and ID token too); add `AbortSignal.timeout` to `exchange`.
- **Also in the Astra review**: F31 (the token exchange has no timeout).
- **Status**: fixed 2026-11-13 (refresh built on accessFromRefresh; 15 s timeout on the token exchange)

### U13. The Drive id pattern, the scene MIME type and the multipart body are repeated
- **Area**: Worker: routes, auth, OAuth, folders, stats
- **Severity**: low
- **Confidence**: confirmed
- **Location**: id regex `^[A-Za-z0-9_-]{10,200}$`: `online/worker/account.ts:27`, `sceneRoutes.ts:61`, `folders.ts:74`, `folderRules.ts:95`, `pubLinks.ts:33`, `stats.ts:81`, inline `stats.ts:204`, `index.ts:381`; agent key regex: `index.ts:68`, `oauth.ts:32`; `.excalidraw`: `folders.ts:76`, `folderRules.ts:218`, `sceneRoutes.ts:168`; `application/vnd.excalidraw+json`: `folderRules.ts:217`, `driveApi.ts:187`; multipart/related builder: `driveApi.ts:183-193`, `folderRules.ts:376-382`; base64 of bytes in chunks: `index.ts:160-163`, `contact.ts:106-113` (and `scenes-mcp/googleFonts.mjs:10`); base64 key decoding: `auth.ts:130`, `:285`, `:375`, `:390`, `feedback.ts:44`
- **Description**: Eight copies of the file-id rule means a change (Drive ids longer than 200, say) must be found eight times.
- **Suggested fix**: Export `FILE_ID_RE`, `SCENE_MIME`, `SCENE_EXTENSION`, `multipartBody()` and `bytesFromBase64()` from one module (driveApi.ts / auth.ts).
- **Status**: fixed 2026-11-13 (FILE_ID_RE, SCENE_MIME, SCENE_EXTENSION, multipartBody in driveApi.ts; base64 helpers in bytes.ts; AGENT_KEY_RE in oauth.ts; left in code that goes: account.ts live ids, sceneRoutes, folders)

### U14. Six hand-written partial D1 types
- **Area**: Worker: routes, auth, OAuth, folders, stats
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `online/worker/feedback.ts:9-13`, `contact.ts:18-22`, `folders.ts:60-68`, `pubLinks.ts:24-29`, `stats.ts:87-88`, `retention.ts:9`
- **Description**: Each module declares its own slice of the D1 API under the same name `D1`, all for the one binding `FEEDBACK`; the intersection type `Env` in index.ts then merges six shapes.
- **Suggested fix**: One shared type (or `D1Database` from the Workers types that already provide `DurableObjectNamespace` and `ExecutionContext`).
- **Status**: fixed 2026-11-13 (one D1 type in database.ts)

## Over-engineering

### O5. Stateless OAuth for agents needs a whole legacy branch and a second token type for uploads
- **Area**: Worker: routes, auth, OAuth, folders, stats
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `online/worker/index.ts:332`, `:348` (a new sealed upload token on every `/mcp` request, also for requests that never show it), `online/worker/oauth.ts:151-158`
- **Description**: `uploadToken` (an AES-GCM seal) is computed for every MCP request, including `initialize`, `tools/list` and notifications, although only `read_me` and the server instructions print it.
- **Suggested fix**: Pass a lazy `uploadUrl: () => Promise<string>` (or compute it only when `read_me` / instructions are built). Together with removing the legacy link this shrinks `handleMcpRoute` to one path.
- **Status**: fixed 2026-11-13 (the upload token is sealed only for requests that call read_me)

### O6. `/api/pdf` is refused in two places
- **Area**: Worker: routes, auth, OAuth, folders, stats
- **Severity**: low
- **Confidence**: likely (the MCP's `savePdf` override in index.ts makes the pairing's branch unreachable as far as tools.mjs was followed)
- **Location**: `online/worker/index.ts:305`, `online/worker/pairing.ts:220-225`
- **Description**: The Worker replaces `savePdf` with a rejection, so the pairing object's own 501 for `/api/pdf` is defensive handling of a call that is not made.
- **Suggested fix**: Keep one of them.
- **Status**: fixed 2026-11-13 (the pairing's /api/pdf branch removed; the MCP's savePdf rejection stays)
