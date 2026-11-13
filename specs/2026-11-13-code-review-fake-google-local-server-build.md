# Code review: Fake Google, local server, build config

Status: open

Findings of the code review of 2026-11-13 (see `2026-11-13-code-review.md`) in the area **Fake Google, local server, build config**, still open after the triage against the two specs of the same day. 22 findings: 1 high, 3 medium, 18 low. Ids as in the review (B bug, S smell, D dead code, U duplication, O over-engineering). A finding that is fixed gets a line "- **Status**: fixed in <commit>".

## Potential bugs

### B2. PDF printing in the local server always fails: `execFile` is not imported
- **Area**: Fake Google, local server, build config
- **Severity**: high
- **Confidence**: confirmed (traced in code; `git show dbed69a` removed `execFile` from the import, the call stayed)
- **Location**: `scenes-server/server.mjs:23` (imports only `spawn`), `scenes-server/server.mjs:257`
- **Description**: `printPdf` calls `execFile(chrome, …)`, which is not defined in the module. The Promise executor throws
  `ReferenceError: execFile is not defined`, so every `POST /api/pdf` answers 500. Consequences: the MCP tool `export_pdf`
  of the local install always fails (`scenes-mcp/tools.mjs:1687-1693`, "PDF export failed: …"); the app's PDF button
  silently falls back to the browser print dialog (`scenes-plugin/src/slidesUI.tsx:121-129` catches the error), so the
  breakage is not visible there. Broken since the Drive migration commit (dbed69a).
- **Suggested fix**: `import { execFile, spawn } from "node:child_process";`. Add a small test (or a startup self-check)
  for `/api/pdf`, since nothing covers this file.
- **Also in the Astra review**: F32 (reproduced there with the extracted `printPdf`).
- **Status**: fixed 2026-11-13 (printPdf in scenes-server/pdf.mjs imports execFile; tested with a stand-in Chrome: localPdf.test.ts)

### B20. Fault injection never matches a query string, so the "slow reads" variant of new-scene.mjs tests nothing
- **Area**: Fake Google, local server, build config
- **Severity**: medium
- **Confidence**: confirmed (traced in code)
- **Location**: `online/worker/fakeGoogle.ts:876`, `:935-943`, `:1575`; `scenes-plugin/test/e2e/new-scene.mjs:43-44`, `:103-104`
- **Description**: `fault()` matches `path.includes(fault.path)` against the pathname only (`route` builds `path` from
  `url.pathname`; `drive()` passes it on as `fullPath`). `new-scene.mjs slow` registers
  `{ count: 30, delayMs: 2500, path: "alt=media" }` to make file reads slow; `alt=media` is in the query, so this fault
  never fires and its 30 uses stay queued until the test deletes all faults. The variant passes while only uploads are
  delayed: "a slow Drive (uploads … and file reads take 2.5 s)" is not what runs. The request log makes it look as if it
  should work, because it logs `fullPath + query` under `path` (`:1589-1590`).
- **Suggested fix**: match faults against `pathname + search` (the same string that is logged), and document it; or
- **Status**: fixed 2026-11-13 (faults match path + query; DELETE /admin/faults lists faults that never fired)
  change the test to a path fault plus `method: "GET"`. Consider answering `POST /admin/faults` with a hint when a
  fault was never used at `DELETE /admin/faults`.

### B74. Two concurrent render commands without an open tab start two headless Chromes; one is orphaned
- **Area**: Fake Google, local server, build config
- **Severity**: low
- **Confidence**: confirmed (traced in code, not run)
- **Location**: `scenes-server/server.mjs:187-220`, `:283-288`
- **Description**: `ensureRenderer` checks `!renderer`, then awaits `fs.mkdtemp` before it assigns `renderer`. Two
  commands arriving together (an agent's parallel `view_scene` / `measure_text` calls with no Kurviq tab open) both
  pass the check and both spawn Chrome; the second assignment overwrites the first. The first process is no longer
  tracked: `stopRenderer` kills only the second on exit, and when either exits its handler sets `renderer = null`
  although the other still runs, so a third Chrome can be started later. Both renderer tabs register as clients.
- **Suggested fix**: keep the start as one shared promise (`renderer = { ready: startRenderer() }` assigned
- **Status**: fixed 2026-11-13 (renderer start stored before any await; exit handler clears only its own entry)
  synchronously before any await), and let the exit handler clear `renderer` only if it is still that process.

### B75. `KURVIQ_FAKE_GOOGLE` means two different things in the app build and the Worker; nothing stops a fake app build from being deployed
- **Area**: Fake Google, local server, build config
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/vite.config.mts:932`, `online/dev-vars.mjs:28`, `package.json:15-16`, `online/package.json` (`deploy`)
- **Description**: The app build switches to `/fake-google` when `process.env.KURVIQ_FAKE_GOOGLE` is any non-empty
  string (`"0"`, `"false"` included); the Worker side needs exactly `"1"`. `KURVIQ_FAKE_GOOGLE=0 npm run build:online`
  therefore builds an app for the fake against a Worker using real Google. Both builds write to the same
  `online/dist/app`: after `npm run build:online:fake`, `cd online && npm run deploy` (which rebuilds only the Worker)
  would publish an app whose Drive calls go to `kurviq.com/fake-google/…`, where no fake answers. The GitHub Actions
  deploy is safe (it runs `build:online` without the variable); the risk is the manual path only.
- **Suggested fix**: compare with `=== "1"` in `vite.config.mts`, and let `online`'s `deploy` script refuse when
  `dist/app` was built for the fake (e.g. grep the bundle for `/fake-google/drive`, or write a marker file).
- **Also in the Astra review**: F48.
- **Status**: fixed 2026-11-13 (=== "1" in vite.config.mts; the app build writes online/dist/app-build.json, online/check-deploy.mjs refuses a fake build in `npm run deploy`)

### B76. The scenes server trusts every request without an `Origin` header, which includes cross-site no-cors GETs
- **Area**: Fake Google, local server, build config
- **Severity**: low
- **Confidence**: likely (browser behaviour not tested: `<img>`, `<script>`, `<link>` GETs send no `Origin`; newer
  Chrome versions may ask for local network permission first)
- **Location**: `scenes-server/server.mjs:416-423`, `:435-449`, `:393`
- **Description**: `refuse` treats a missing `Origin` as "local tool". A web page the user visits can issue
  `<img src="http://localhost:3101/api/events?tab=x">`: it passes the Host and Origin checks and `serveEvents`
  registers a phantom "user" tab that never answers. With no real tab open, agent commands then wait 30 s for a 504
  instead of the immediate 409 "not open", and `ensureRenderer` returns early (it sees a tab), so pictures are never
  rendered; each such request also holds a connection and a 25 s timer. GET `/api/scenes…` is relayed to the user's
  tab the same way (the answer is not readable cross-site, but the tab does the Drive reads). Separately,
  `corsOrigin` answers `Access-Control-Allow-Origin: null` for disallowed origins; `null` is the origin of sandboxed
  iframes, so that value should never be sent (today it only exposes the 403 body).
- **Suggested fix**: also refuse when `Sec-Fetch-Site` is present and is `cross-site` (browsers always send it, local
- **Status**: fixed 2026-11-13 (no-Origin requests with Sec-Fetch-Site cross-site/same-site refused; no Access-Control-Allow-Origin: null)
  tools never do); omit the `Access-Control-Allow-Origin` header instead of sending `null`.

### B77. `/api/pdf` prints any HTML that starts with the expected prefix; top-level navigation is not blocked
- **Area**: Fake Google, local server, build config
- **Severity**: low
- **Confidence**: uncertain (not run: whether headless Chrome prints the page a `<meta http-equiv="refresh">` leads to
  within the virtual time budget was not checked)
- **Location**: `scenes-server/server.mjs:240-242`, `:259-272`, `:485-489`
- **Description**: The only validation is `html.startsWith(PDF_START)`. The CSP in that prefix blocks scripts,
  subresources and frames, and `--host-resolver-rules` blocks the network, but neither restricts a top-level
  navigation by meta refresh to another `file://` URL. The page is opened as `file://…/slides.html`, so a caller
  could have a local file printed and returned as PDF. Callers must be the app's origin or a local process, so this
  needs script injection in the app (or scene content reaching the export HTML unescaped) to matter: defence in depth.
- **Suggested fix**: reject HTML containing `http-equiv` other than the one CSP meta (or build the document in the
- **Status**: fixed 2026-11-13 (pdfHtmlProblem: exactly the two <meta> tags of the prefix)
  server from the pages / styles the app sends), and add `--disable-features=…`/`--allow-file-access-from-files`-free
  flags only after checking; simplest is a check that `<meta` occurs exactly twice (charset, CSP).

### B78. A fake `files.update` that fails halfway leaves the file half-updated
- **Area**: Fake Google, local server, build config
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `online/worker/fakeGoogle.ts:2026-2034`, `:1970-1989`, `:2002-2009`
- **Description**: `updateFile` writes the trash flag (and `version + 1`) before `updateFileProperties`, which can
  still fail: more than 30 app properties (403), a key/value over 124 bytes, an unknown `addParents` folder (404 thrown
  from `checkParents`), after the name / description were already written. The caller gets an error, the file is
  changed, and no watch notification is sent. Real Drive applies an update atomically, so a test of an error path can
  see state that production never has.
- **Suggested fix**: validate first (maps, parents), then write everything; or wrap the writes in
- **Status**: fixed 2026-11-13 (files.update checks everything first (updatePlan), then writes)
  `ctx.storage.transactionSync`.

### B79. The PWA manifest announces a share target nobody handles
- **Area**: Fake Google, local server, build config
- **Severity**: low
- **Confidence**: likely (no handler found in `scenes-plugin/src`, `online/worker`, or upstream's app sources; what the
  assets binding answers to the POST was not run)
- **Location**: `scenes-plugin/vite.config.mts:879-884`
- **Description**: `share_target` (copied from upstream's manifest) makes the installed app a share destination for
  `.excalidraw` files: the OS then POSTs the file to `/web-share-target`. Nothing handles that path: the service
  worker's page rule passes the POST to the network, the Worker has no such route and hands it to the static assets.
  The shared file is dropped. `file_handlers` (action `/`) is the working path.
- **Suggested fix**: remove `share_target` from the manifest, or handle the POST in the service worker and hand the
  file to the app.
- **Also in the Astra review**: F47.
- **Status**: fixed 2026-11-13 (share_target removed)

## Code smells

### S2. The deploy runs no test and no typecheck (Astra F49)
- **Area**: Fake Google, local server, build config
- **Severity**: medium
- **Confidence**: confirmed (found by the Astra review; workflow read by me)
- **Location**: `.github/workflows/deploy-kurviq.yml:43-66`
- **Description**: Every push to main builds and deploys; nothing runs the 31 unit test files, the typecheck or the e2e scripts first. The check after the deploy only fetches the home page and the first line of `llms.txt`. CLAUDE.md asks for these checks before a push, but only as a manual step, so a failing sync or auth test does not stop a release.
- **Suggested fix**: Add a job before the deploy that runs the unit tests and the typecheck (compared with the known 17 upstream errors); keep the browser e2e scripts in a separate job if they take too long.
- **Status**: fixed 2026-11-13 (deploy workflow runs npm run typecheck:ci (scripts/typecheck.mjs: fails on errors outside excalidraw/ or more than 17 upstream) and npm test before building)

### S18. The fake Google (2535 lines, a Durable Object class and its binding) is part of the production Worker
- **Area**: Fake Google, local server, build config
- **Severity**: low
- **Confidence**: confirmed (traced in code; `online/build/worker.js` contains the `/fake-google` code)
- **Location**: `online/worker/index.ts:35`, `:58`, `:442-449`; `online/wrangler.jsonc:31`, `:38`; `online/worker/fakeGoogle.ts:128-138`
- **Description**: Not reachable (see the top of this file), but the only thing between a complete, unauthenticated
  OAuth + Drive + admin implementation and the internet is runtime configuration. The class is exported, bound
  (`FAKE_GOOGLE_STORE`) and migrated in production; the test hooks in `scene.ts` / `sceneRoutes.ts` rely on the same
  flag. Every future route added before line 442 of `index.ts`, or a gate that checks only `FAKE_GOOGLE`
  (e.g. `scene.ts:1547` checks the flag and a non-empty `DEV_ORIGIN`, not `devGate`), weakens it.
- **Suggested fix**: build it out of the production bundle: an esbuild `define` (e.g. `__KURVIQ_DEV__`) set by
- **Status**: fixed 2026-11-13 (__KURVIQ_DEV__ define: `build-worker.mjs --production` (npm run deploy) leaves the fake out, a stub FakeGoogle class keeps the binding; dev hooks in scene.ts / sceneRoutes.ts go with that code)
  `build-worker.mjs` only for the fake build, with `handleFakeGoogle` and the dev hooks behind it so they are dropped
  as dead code; keep a stub `FakeGoogle` class (or a `deleted_classes` migration) for the existing migration.

### S19. The fake's admin API is open to every website in the developer's browser
- **Area**: Fake Google, local server, build config
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `online/worker/fakeGoogle.ts:848-858`, `:893-895`
- **Description**: Every answer reflects the request's `Origin` into `Access-Control-Allow-Origin` and preflights are
  approved for all methods, yet the app calls the fake same-origin (`VITE_APP_GOOGLE_API_BASE` is the relative
  `/fake-google`) and the tests are Node scripts: nothing needs CORS. While `wrangler dev` runs, any page open in the
  same browser can call `/fake-google/admin/*` (reset, read all files and revisions with `?content=1`, write, share)
  and `oauth/approve`. Only test data, but developers do paste real scenes into test accounts.
- **Suggested fix**: drop the CORS headers (or allow only `DEV_ORIGIN`).
- **Status**: fixed 2026-11-13 (CORS only for DEV_ORIGIN)

### S20. `anonymousOnly()` does the opposite of its name
- **Area**: Fake Google, local server, build config
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `online/worker/fakeGoogle.ts:1756-1761`, passed through `:1594`, `:1655`, `:1674`, `:1685`, `:1712`
- **Description**: The helper fails with 401 "Login Required" when the caller is anonymous (API key) and returns the
  signed-in user. Every call site reads as "this route is for anonymous callers only", which is the reverse.
- **Suggested fix**: rename to `requireUser` (and resolve it once in `driveResourceCall` instead of threading a
- **Status**: fixed 2026-11-13 (requireUser(caller), no closure threaded through)
  closure through five functions).

### S21. Text-padding patch: three replacements are not checked, unlike every other patch
- **Area**: Fake Google, local server, build config
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `scenes-plugin/vite.config.mts:163-179`
- **Description**: All other source patches count their anchors and fail the build when upstream changed. Here
  `code.indexOf("\nexport const ")` is used unchecked, and the inner `replaceAll("BOUND_TEXT_PADDING * 2", …)` and
  `.replace(": BOUND_TEXT_PADDING) *", …)` inside `getBoundTextMaxWidth/Height` do nothing silently if upstream
  rewrites those expressions: the build stays green and custom text padding stops applying to the wrap width while
  the position patches still apply (text overflows its shape). The file's stated rule is "fails loudly".
- **Suggested fix**: express these as counted steps of `patch()` too (or assert that the result differs from the input).
- **Status**: fixed 2026-11-13 (counted steps of patchSource, helper prepended as a function declaration)

### S22. The scenes server reads request bodies without any size limit
- **Area**: Fake Google, local server, build config
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `scenes-server/server.mjs:369-375`, used by `:355`, `:524`
- **Description**: `readBody` buffers the whole body. Callers are local (the app, the MCP server), so this is not an
  exposure, but one runaway caller (an agent posting a huge payload, a tab posting a multi-hundred-MB render result)
  takes the server down with it, and the online counterpart has explicit caps (10 MB images, 1 MB payloads in
  `online/worker/index.ts:104`, `:193`).
- **Suggested fix**: a generous cap (e.g. 64 MB) with a 413 answer and `req.destroy()`.
- **Status**: fixed 2026-11-13 (64 MB cap, 413, connection closed)

## Dead code

### D10. Leftovers in the scenes server from before the Drive migration and the rename
- **Area**: Fake Google, local server, build config
- **Severity**: low
- **Confidence**: confirmed (repo-wide search)
- **Location**: `scenes-server/server.mjs:177-188`, `:222`, `:554-562`, `:67-68`, `:201`, `:251`, `:314`, `:327`, `:385`
- **Description**: (1) `ensureRenderer({ dedicated })` and `rendererTab()`: the only caller is `ensureRenderer()`
  without arguments (`:306`), so the `dedicated` branches and `rendererTab` never run. (2) `sendError` copies
  `remoteMd5`, `offline` and `exists` from the error: no error thrown in this file carries them any more (the server
  relays the tab's answer verbatim in `relayScene`); they date from when the server did the sync itself.
  (3) `httpError(status, message, extra)` is used once, without `extra`, while six other places build the same error
  by hand (`new Error` + `.status`). (4) `[::1]:PORT` is an allowed host although the server listens on 127.0.0.1 only.
  (5) Old names: temp directories `excalidraw-scenes-renderer-` / `excalidraw-scenes-pdf-`, messages "The Excalidraw
  app is not open…" / "did not answer in time" next to "Kurviq is not open…" (`:516`) for the same condition.
- **Suggested fix**: delete (1), (2) and the unused `extra`; use `httpError` everywhere; unify the wording.
- **Also in the Astra review**: F36.
- **Status**: fixed 2026-11-13

### D11. Unused parameters and no-op constructs in the fake
- **Area**: Fake Google, local server, build config
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `online/worker/fakeGoogle.ts:434` (`_what`), `:2398` + `:2523` (`path`), `:1940-1942`, `:632-638`, `:105` + `:1753`, `:165` + `:1284` + `:1520`
- **Description**: `checkKeys(…, _what)` never reads its third argument (seven call sites pass a label);
  `adminFaults(body, path)` never reads `path`; `deleteFile` loops over the one-element list `["files"]`; the
  `fullText contains` branch is identical to `name contains`; `DRIVE_FULL` is accepted although Kurviq never asks for
  the full Drive scope (project decision: stay on `drive.file`); `Caller.clientId` is set and never read.
- **Suggested fix**: remove them.
- **Status**: fixed 2026-11-13

## Duplications

### U15. Six copies of the `.env` reader
- **Area**: Fake Google, local server, build config
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `scenes-server/server.mjs:35-52`, `scenes-plugin/vite.config.mts:26-41`, `scenes-mcp/server.mjs:28-40`, `online/with-env.mjs:18-28`, `online/dev-vars.mjs:10-21`, `online/secrets.mjs:21-31`
- **Description**: The same "read `.env` then `.env.local`, split lines, strip quotes" loop exists six times, in three
  variants (a regex over the whole line; `server.mjs` slices after the `=` and has an extra line-separator check;
  `with-env.mjs` keeps only Cloudflare settings and lets the file win over `process.env`, the others the reverse). A
  change to the format (comments after a value, `export KEY=`) has to be made six times, and the app, the server and
  the MCP server must agree on values such as `SCENES_SERVER_URL` and `SCENES_APP_URL`.
- **Suggested fix**: one `scripts/env.mjs` (`loadEnv(root)`) imported by all six.
- **Also in the Astra review**: F50.
- **Status**: partly 2026-11-13: scripts/env.mjs used by the scenes server, vite.config.mts, with-env.mjs, dev-vars.mjs, secrets.mjs; scenes-mcp/server.mjs still has its copy (needs lead: not my files)

### U16. The source-patching helper exists three times in the Vite config, with different strictness
- **Area**: Fake Google, local server, build config
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `scenes-plugin/vite.config.mts:148-161`, `:226-240`, `:561-571`
- **Description**: `textPadding` and `richText` each define the same counted `patch` (the second adds an import
  line); `kurviqOnline` has a third that only checks "found at least once" and replaces the first occurrence. If
  upstream duplicates one of the `kurviqOnline` anchors (e.g. a second `onExportToBackend,` line), only the first is
  patched and the build passes.
- **Suggested fix**: one module-level `patchSource(code, name, steps, importLine?)` with the count check, used by all.
- **Also in the Astra review**: F50.
- **Status**: fixed 2026-11-13 (one patchSource with the count check)

### U17. `kurviqBuild()` is defined in both builds and must give the same answer
- **Area**: Fake Google, local server, build config
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `scenes-plugin/vite.config.mts:778-785`, `online/build-worker.mjs:17-24`
- **Description**: The app and the Worker compare this value to tell an outdated tab. The two copies already differ
  (`cwd: HERE` only in the Vite config). A change to one (length, source) silently breaks the comparison.
- **Suggested fix**: move it next to `thirdPartyNotices` in `online/licenses.mjs` (already imported by both) or a
- **Status**: fixed 2026-11-13 (online/build-info.mjs)
  small shared module.

### U18. The fake's admin calls re-implement its Drive calls
- **Area**: Fake Google, local server, build config
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `online/worker/fakeGoogle.ts:2294-2334` vs `:1970-2052`; `:2336-2355` vs `:2157-2199`; `:2357-2368` vs `:2252-2264`; `:2378-2386` vs `:2029-2031`, `:2044-2046`
- **Description**: `adminWrite` merges app properties and renames without `stringMap`'s validation and the 30-key
  limit; `adminShare` / `adminUnshare` / `adminTrash` repeat the permission and trash writes with their own
  `version + 1` and `notify` calls. A behaviour fixed in the Drive path (e.g. what a notification carries) has to be
  fixed in the admin path too, or "a change from outside Kurviq" behaves differently from a change through the API.
- **Suggested fix**: let the admin calls run the Drive implementation as that user (an internal `Caller` with app
- **Status**: fixed 2026-11-13 (admin write/share/unshare/trash use the Drive path's checks and writes: updatePlan, mergedMap, setTrashed, permissionsChanged)
  access bypassed), keeping only the "no app access needed" difference.

## Over-engineering

### O1. The fake Google implements far more of Google than the app or any test uses
- **Area**: Fake Google, local server, build config
- **Severity**: medium
- **Confidence**: confirmed for "no caller in `online/worker`, `scenes-plugin/src`, `scenes-mcp`, `online/test`, `scenes-plugin/test`" (searched); manual QA use can't be ruled out
- **Location**: `online/worker/fakeGoogle.ts:477-728` (query language), `:1027-1035` (prompt=none), `:1107-1114` (userinfo), `:1253-1258` (Basic auth), `:416-444` (field key lists), `:1714-1717` (about), `:2002-2010` (addParents/removeParents), `:2148-2167`, `:2213-2219` (ownership transfer), `:2388-2396`, `:2417-2430`, `:2446-2459`, `:2468-2484`
- **Description**: What the real code sends: three `q` shapes (`'<id>' in parents and trashed=false`,
  `appProperties has {…} and mimeType=… and trashed=false`, `sharedWithMe and trashed=false and mimeType=…`),
  `orderBy=createdTime`, `prompt=consent|select_account`. Implemented but never called by app, Worker or tests:
  `or` / `not` / parentheses, `contains`, `fullText`, `visibility`, `in owners|writers|readers`, `starred`, date and
  `!=`/`<`/`>` comparisons, `properties has`, six `orderBy` keys; OAuth `prompt=none` with `login_hint`,
  `/userinfo`, HTTP Basic client auth, `cancel=1`; Drive `about.get`, `addParents`/`removeParents`, ownership
  transfer, `PUT` uploads, a whitelist of ~70 file field names; admin `ungrant`, `users`, `files`,
  `purge-revisions`, `expire-tokens`, `log`, `inbox`; fault filters `target`, `email`, `method`, `reason`. Tests use
  admin `reset`, `share`, `unshare`, `grant`, `write`, `revoke`, `trash`, `untrash`, `delete`, `file`, `revisions`,
  `channels` and faults with `count`, `status`, `delayMs`, `path`. The unused half is untested itself, so when the app
  starts to use one of these (say `name contains`), a test would trust behaviour nobody compared with Google: the
  fake is built from memory of the API in exactly the places where no test pins it down.
- **Suggested fix**: cut the query language to the operators the app sends (answer anything else with a clear
  "not supported by the fake" 400, as `uploadType` already does at `:1850`), and drop the unused OAuth and admin
  routes; keep `log` if it is used for debugging by hand, and say so in the header.
- **Update 2026-11-13 (specs)**: Grows: the fake's revisions, keepForever pins and watch channels were used by the scene object; cut them too.
- **Status**: partly 2026-11-13: query language cut to what Kurviq sends (online/worker/fakeGoogleQuery.ts, refused otherwise), orderBy to createdTime/modifiedTime/name; dropped prompt=none, /userinfo, Basic auth, about.get, add/removeParents, ownership transfer, PUT uploads, admin users/files/ungrant/purge-revisions/expire-tokens/inbox, fault filters. Kept: the field whitelist (it checks what the app sends), cancel (the page's Cancel button), log (debugging by hand). Revisions, keepForever and watch channels still serve scene.ts: cut them when it goes (lead)

### O7. Fidelity gaps of the fake worth knowing when a test passes
- **Area**: Fake Google, local server, build config
- **Severity**: low
- **Confidence**: likely (the fake's side is traced; Google's side is from the API's documented behaviour, not re-checked against the live API)
- **Location**: `online/worker/fakeGoogle.ts:1991-2018`, `:2030`, `:2041-2043` (modifiedTime); `:1213-1217` (refresh token); `:1783-1788` (listing)
- **Description**: (1) Metadata-only updates (rename, app properties, trash) raise `version` but leave `modifiedTime`
  unchanged, while Drive moves `modifiedTime` on a rename; the app orders same-named files by it
  (`scenes-plugin/src/online/drive.ts:740`) and shows it as `updatedAt`. (2) Everything is immediately consistent: a
  file is in `files.list` in the same instant it was created, and there is never a second writer between a read and a
  write unless a test asks for it (`devRace`). Drive's listing lags, so "find the Kurviq folder, else create it"
  (`drive.ts:684`) can't produce its duplicate-folder case here. (3) A new consent returns the old refresh token
  instead of a new one. None of these makes a current test wrong that I could show; they are the places where green
  tests say least.
- **Suggested fix**: bump `modified` on metadata changes; optionally a fault kind "list lags by N ms" for the folder
- **Status**: fixed 2026-11-13 (rename moves modifiedTime; the other gaps listed under "Not like Google" in the header)
  lookup. Otherwise list these in the header comment under a "not like Google" heading.
