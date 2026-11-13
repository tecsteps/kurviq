# Kurviq code review (Fable, with the Astra review merged in)

Status: open (triaged 2026-11-13 against the specs of the same day; findings split into one file per area)

Date: 2026-11-13, at commit `1692b09` (main). Review only: nothing in the repo was changed.

## Scope and method

Reviewed: our own code in `scenes-plugin/` (source and build config), `online/` (Worker, Durable Objects, scripts),
`scenes-mcp/`, `scenes-server/` and `scripts/`: about 53,000 lines. Not reviewed: the upstream clones `excalidraw/` and
`excalidraw-mcp/`, and the tests (read only to confirm findings).

- Nine reviewers each read one area completely, file by file, and traced every finding through callers and callees
  before reporting it. Each finding states its confidence: "confirmed" means traced in the code, not run in the app,
  unless it says so.
- I re-checked 12 of these findings against the code myself (three of the four rated high, seven medium, two low).
  All 12 are as described. The other findings of the nine reviewers were not re-checked by a second reader.
- Two tool scans across all areas: a copy-paste detector (jscpd) finds only 0.3 % textually duplicated lines (15
  clones), so the duplications listed here are mostly the same rule written twice in different words; and a search
  for exports without any reference outside their file.
- Things SonarQube already reports (complexity, nested ternaries, unused imports) are left out on purpose.

### The Astra review

A second, independent review (`astra_review.md`, 52 findings, F01 to F52, plus closing notes) was merged into this
file and then deleted. I checked every one of its findings against the code; none had to be dropped.

- 32 of them were already in this review. Those findings now carry a line "Also in the Astra review" with the F
  number and whatever Astra adds.
- 20 were new. They are included as their own findings, marked "(Astra Fxx)" in the title, each traced in the code
  by me; one more comes from Astra's closing notes (the 32-bit comment fingerprint). For F19 I confirmed the parts
  in the code but not the end-to-end case, so it is marked "likely".
- Severity is mine. Where Astra rated higher, the finding says so: F01, F02, F19 (high there, medium here) and
  F03, F04 (high there, medium here: the window is the conversion time of one agent edit).
- Astra ran the existing unit tests (31 files, 497 passed) and the typecheck (the known 17 upstream errors), and
  reproduced several findings with scripts; those reproductions are named in the findings and were not repeated by me.


## Files

| File | Area | Open findings | high / medium / low |
|---|---|---|---|
| [2026-11-13-code-review-worker-routes.md](2026-11-13-code-review-worker-routes.md) | Worker: routes, auth, OAuth, folders, stats | 26 | 0 / 4 / 22 |
| [2026-11-13-code-review-fake-google-local-server-build.md](2026-11-13-code-review-fake-google-local-server-build.md) | Fake Google, local server, build config | 22 | 1 / 3 / 18 |
| [2026-11-13-code-review-browser-drive-client-online-ui.md](2026-11-13-code-review-browser-drive-client-online-ui.md) | Browser: Drive client and online UI | 32 | 0 / 4 / 28 |
| [2026-11-13-code-review-browser-controller.md](2026-11-13-code-review-browser-controller.md) | Browser: controller, storage, router, merge | 29 | 0 / 8 / 21 |
| [2026-11-13-code-review-browser-agent-coworking.md](2026-11-13-code-review-browser-agent-coworking.md) | Browser: main UI, agent co-working | 20 | 0 / 8 / 12 |
| [2026-11-13-code-review-browser-slides-richtext-comments.md](2026-11-13-code-review-browser-slides-richtext-comments.md) | Browser: slides, rich text, comments | 34 | 2 / 8 / 24 |
| [2026-11-13-code-review-mcp-shared-modules.md](2026-11-13-code-review-mcp-shared-modules.md) | MCP server and shared modules | 31 | 1 / 9 / 21 |
| [2026-11-13-code-review-superseded.md](2026-11-13-code-review-superseded.md) | Superseded by the specs (not fixed, kept for the lessons) | 68 | |

## Triage against the specs of 2026-11-13

Specs: `2026-11-13-drive-collaboration-without-server-data.md` (no customer data or tokens on our servers: one
editor at a time, a memory-only relay, no shared-folder proxy, no public content cache) and
`2026-11-13-own-database.md` (a scene's home: browser, Drive or the user's database, through an adapter).

- **Superseded (68)**: entirely inside code the Drive spec removes; in their own file. B1, B3, B4, B8, B9, B10, B11, B12, B13, B15, B17, B19, B21, B22, B23, B24, B25, B26, B27, B28, B29, B30, B56, B57, B58, B59, B60, B61, B62, B70, B71, B72, B81, B82, B83, B84, B85, B86, B87, S3, S9, S10, S11, S12, S14, S23, S24, S25, S43, D3, D4, D5, D6, D12, D13, D14, D35, U1, U2, U7, U8, U9, U19, U26, O3, O4, O8, O9.
- **Smaller than written or moved (17)**: marked with "Update 2026-11-13 (specs)" in their area file; only the
  named part remains (B63 and B80 moved to the area where their code stays).
- **With the database adapter (11)**: controller findings best fixed in the adapter refactor, marked
  "When" in their area file: B34, B35, B102, B103, S5, S31, S32, D21, U27, U28, U29.
- **Lessons for the new code** (from superseded findings):

| From | Lesson |
|---|---|
| B1 | The relay's join check: a Drive rate limit (429 / 403 rateLimit) is "try again", never "no access". |
| B12 | The relay's join check: a Drive rate limit (429 / 403 rateLimit) is "try again", never "no access". |
| B3 | The relay connection: timeouts by progress (bytes still buffered), not a fixed 10 s. |
| B23 | The relay connection: detect dead connections both ways (ping / pong), limit the handshake. |
| B4 | Offline edits merged into Drive: decide "changed here" by content against the base, never by version numbers. |
| B27 | No known base: make a copy of local changes, never drop them. |
| B30 | The viewer reading Drive directly: compare the version of what was actually loaded. |
| B126 | The editor tab's commenter check (see B126 in the comments area). |
| B107, B127 | Comment merges by `u` stay; device clocks can be wrong in both new designs. |

## Read this first (after the triage)

1. **B2 is a one-line fix**: `execFile` is not imported in `scenes-server/server.mjs`, so the local `export_pdf`
   tool always fails.
2. **B5, B6, B7** (high): formatted notes and agent markdown lose formatting on a round trip; the template sync
   fails in a loop for old templates without headlines; `edit_scene` refuses calls with only comments or only
   `isPresentation` / `restyle` / `reset` / `addTitleBlock`.
3. **Lost or overwritten work** (medium): controller and merge B34, B35 (with the adapter), B36, B38; agent edits
   B41, B42, B54, B55; slides B45, B48, B50.
4. **Security and privacy** (medium): B14 (a Drive session for any `*.test` address in a link), B18 (OAuth codes
   reusable for 60 s), B16 (feedback without an overall cap).
5. **Biggest clean-up levers**: two element canonicalizers instead of four (U3), the two parallel tool sets in
   `tools.mjs` (U6) and the opt-in "live" agent mode (O2), the unused half of the fake Google (O1, grows with the
   relay), the dead legacy agent link in the Worker (D7), and tests before the deploy (S2).

## Counts (open findings, after the triage)

| Category | high | medium | low | total |
|---|---|---|---|---|
| Potential bugs | 4 | 29 | 56 | 89 |
| Code smells | 0 | 7 | 26 | 33 |
| Dead code | 0 | 2 | 26 | 28 |
| Duplications | 0 | 4 | 29 | 33 |
| Over-engineering | 0 | 2 | 9 | 11 |
| **All** | 4 | 44 | 146 | 194 |

Before the triage: 262 findings (7 high, 66 medium, 189 low); 68 superseded.

## High and medium findings at a glance

| Id | Severity | Area | Finding |
|---|---|---|---|
| B2 | high | [Fake Google, local server, build config](2026-11-13-code-review-fake-google-local-server-build.md) | PDF printing in the local server always fails: `execFile` is not imported |
| B5 | high | [Browser: slides, rich text, comments](2026-11-13-code-review-browser-slides-richtext-comments.md) | Formatted notes and agent markdown do not survive a round trip (bold + italic, italic with `*`, links with `)`) |
| B6 | high | [Browser: slides, rich text, comments](2026-11-13-code-review-browser-slides-richtext-comments.md) | Adding headline and eyebrow to an old template fails, again and again, when no slide has a headline (Astra F37) |
| B7 | high | [MCP server and shared modules](2026-11-13-code-review-mcp-shared-modules.md) | `edit_scene` with only comments, or only `isPresentation` / `restyle` / `reset` / `addTitleBlock`, is refused (Astra F33) |
| B14 | medium | [Worker: routes, auth, OAuth, folders, stats](2026-11-13-code-review-worker-routes.md) | The local-install sign-in hands a Drive session to any `*.test` / localhost address named in a link |
| B16 | medium | [Worker: routes, auth, OAuth, folders, stats](2026-11-13-code-review-worker-routes.md) | Feedback can be stored without limit: per-IP check only, not atomic, no overall cap |
| B18 | medium | [Worker: routes, auth, OAuth, folders, stats](2026-11-13-code-review-worker-routes.md) | OAuth authorization codes can be redeemed more than once (Astra F26) |
| B20 | medium | [Fake Google, local server, build config](2026-11-13-code-review-fake-google-local-server-build.md) | Fault injection never matches a query string, so the "slow reads" variant of new-scene.mjs tests nothing |
| B31 | medium | [Browser: Drive client and online UI](2026-11-13-code-review-browser-drive-client-online-ui.md) | "Copy link" / "Copy prompt" do nothing on a non-secure origin and leave an unhandled rejection |
| B32 | medium | [Browser: Drive client and online UI](2026-11-13-code-review-browser-drive-client-online-ui.md) | "Shared with me" reads only the first 200 files (Astra F17) |
| B33 | medium | [Browser: Drive client and online UI](2026-11-13-code-review-browser-drive-client-online-ui.md) | The public viewer keeps the old background when the scene's background changes (Astra F06) |
| B34 | medium | [Browser: controller, storage, router, merge](2026-11-13-code-review-browser-controller.md) | Opening a scene is not serialized with sync: a pull or merge of the scene being left is applied after it was stashed |
| B35 | medium | [Browser: controller, storage, router, merge](2026-11-13-code-review-browser-controller.md) | `onFocus` / `onStorage` replace `this.meta` while operations hold references to the old scene records: sync results are lost |
| B36 | medium | [Browser: controller, storage, router, merge](2026-11-13-code-review-browser-controller.md) | The three-way merge keeps only my scene settings: Drive's background / grid change is reverted |
| B37 | medium | [Browser: controller, storage, router, merge](2026-11-13-code-review-browser-controller.md) | Scene names that collide with pages and object properties: `/features`, `/about`, `/constructor` |
| B38 | medium | [Browser: controller, storage, router, merge](2026-11-13-code-review-browser-controller.md) | Moving an account's scenes: a failed write of the target's scene list still deletes the source (Astra F01) |
| B39 | medium | [Browser: controller, storage, router, merge](2026-11-13-code-review-browser-controller.md) | The clean-up of old "features" copies can delete a copy the visitor changed (Astra F02) |
| B40 | medium | [Browser: main UI, agent co-working](2026-11-13-code-review-browser-agent-coworking.md) | Comment operations are validated after the element edit was already applied (live scenes and the open scene) |
| B41 | medium | [Browser: main UI, agent co-working](2026-11-13-code-review-browser-agent-coworking.md) | An agent edit of an open local-only scene replaces the canvas with a state computed from an older read (user edits in between are lost) |
| B42 | medium | [Browser: main UI, agent co-working](2026-11-13-code-review-browser-agent-coworking.md) | editOpenScene applies the edit to whatever scene is open after its awaits |
| B43 | medium | [Browser: main UI, agent co-working](2026-11-13-code-review-browser-agent-coworking.md) | The open-scene `edit` command is neither queued nor protected by a requestId |
| B44 | medium | [Browser: main UI, agent co-working](2026-11-13-code-review-browser-agent-coworking.md) | Unmounting the scene pill tells the controller that the editor is gone |
| B45 | medium | [Browser: slides, rich text, comments](2026-11-13-code-review-browser-slides-richtext-comments.md) | A template element that leaves the template wipes every slide's own version of it (headline texts included) |
| B46 | medium | [Browser: slides, rich text, comments](2026-11-13-code-review-browser-slides-richtext-comments.md) | Formatted text keeps a stale size: the size cache ignores formatting and late fonts |
| B47 | medium | [Browser: slides, rich text, comments](2026-11-13-code-review-browser-slides-richtext-comments.md) | PDF tab: "This slide" exports slide 1 after the slide is deselected |
| B48 | medium | [Browser: slides, rich text, comments](2026-11-13-code-review-browser-slides-richtext-comments.md) | Duplicating a slide loses the slide's own headline, eyebrow and changed template elements (Astra F38) |
| B49 | medium | [Browser: slides, rich text, comments](2026-11-13-code-review-browser-slides-richtext-comments.md) | A formatted template text with a placeholder loses its formatting on the slides (Astra F39) |
| B50 | medium | [Browser: slides, rich text, comments](2026-11-13-code-review-browser-slides-richtext-comments.md) | The open notes editor does not show notes changed elsewhere and overwrites them at the next keystroke (Astra F42) |
| B51 | medium | [MCP server and shared modules](2026-11-13-code-review-mcp-shared-modules.md) | Retrying an applied edit with the same requestId and basedOn reports the agent's own edit as a user conflict |
| B52 | medium | [MCP server and shared modules](2026-11-13-code-review-mcp-shared-modules.md) | A failed flush is read as "up to date" and as "not local-only" |
| B53 | medium | [MCP server and shared modules](2026-11-13-code-review-mcp-shared-modules.md) | Images whose size cannot be read become 1 x 1 px (or square), including simple WebP files |
| B54 | medium | [MCP server and shared modules](2026-11-13-code-review-mcp-shared-modules.md) | save_scene(replace: true) drops the scene's comments and custom fonts; new scenes never carry their fonts |
| B55 | medium | [MCP server and shared modules](2026-11-13-code-review-mcp-shared-modules.md) | Checkpoints hold only the elements: pictures, background and fonts are lost (Astra F34) |
| S1 | medium | [Worker: routes, auth, OAuth, folders, stats](2026-11-13-code-review-worker-routes.md) | COOKIE_KEY is the key for a dozen unrelated things, and secrets.mjs rotates everything by default |
| S2 | medium | [Fake Google, local server, build config](2026-11-13-code-review-fake-google-local-server-build.md) | The deploy runs no test and no typecheck (Astra F49) |
| S4 | medium | [Browser: Drive client and online UI](2026-11-13-code-review-browser-drive-client-online-ui.md) | Five hand-built modal dialogs without focus handling; `NOSONAR S6819` silences the finding that would have fixed it |
| S5 | medium | [Browser: controller, storage, router, merge](2026-11-13-code-review-browser-controller.md) | Two sources of truth for the open scene and two operation queues |
| S6 | medium | [Browser: main UI, agent co-working](2026-11-13-code-review-browser-agent-coworking.md) | Comment and tool description promise an undoable agent edit; the code keeps it out of the undo history |
| S7 | medium | [Browser: slides, rich text, comments](2026-11-13-code-review-browser-slides-richtext-comments.md) | Five per-frame polling loops, two of them always running |
| S8 | medium | [MCP server and shared modules](2026-11-13-code-review-mcp-shared-modules.md) | Tool descriptions and comments describe an architecture and tools that no longer exist |
| D1 | medium | [MCP server and shared modules](2026-11-13-code-review-mcp-shared-modules.md) | `agentSide`, `agentCommand` and `renderImage({ userTab })` no longer do anything |
| D2 | medium | [MCP server and shared modules](2026-11-13-code-review-mcp-shared-modules.md) | The Node fallback conversion can only run in one case, where it harms |
| U3 | medium | [Browser: controller, storage, router, merge](2026-11-13-code-review-browser-controller.md) | Four element canonicalizers with different rules |
| U4 | medium | [Browser: main UI, agent co-working](2026-11-13-code-review-browser-agent-coworking.md) | Three copies of the detached edit pipeline in cowork.ts |
| U5 | medium | [Browser: slides, rich text, comments](2026-11-13-code-review-browser-slides-richtext-comments.md) | Three resolvers for "which slide does this reference name" |
| U6 | medium | [MCP server and shared modules](2026-11-13-code-review-mcp-shared-modules.md) | Two parallel tool sets and repeated blocks inside tools.mjs |
| O1 | medium | [Fake Google, local server, build config](2026-11-13-code-review-fake-google-local-server-build.md) | The fake Google implements far more of Google than the app or any test uses |
| O2 | medium | [Browser: main UI, agent co-working](2026-11-13-code-review-browser-agent-coworking.md) | A second agent mode ("live") with its own edit path, used only by an opt-in env variable of the local MCP |

## Appendix: checked and found sound

Notes of the reviewers on what they read and what they checked without a finding.

### Worker: scene Durable Object (scene.ts, serverMerge.ts, shared.ts)

All three files were read completely. Nothing was executed; "confirmed" means traced in the code (callers, callees and the client in `scenes-plugin/src/online/liveSync.ts` where the behaviour depends on it).

### Worker: routes, auth, OAuth, folders, stats

Scope read completely: `online/worker/` index.ts, auth.ts, oauth.ts, sceneRoutes.ts, folders.ts, folderRules.ts,
pairing.ts, account.ts, pubLinks.ts, driveApi.ts, google.ts, contact.ts, feedback.ts, retention.ts, stats.ts, skill.ts,
fonts.ts, shims/fs-promises.js; `online/` wrangler.jsonc, build-worker.mjs, dev-vars.mjs, secrets.mjs, with-env.mjs,
licenses.mjs; `online/pages/` _layout, contact, about, imprint, terms (complete), privacy.html (only scanned for
scripts, forms and template placeholders: none found, not read line by line).
`scene.ts` was read only at the places named below, to confirm findings.

Things checked and found sound (no finding): SQL is bound everywhere (the only interpolations are constants);
the contact page is filled with HTMLRewriter's escaping setters; the OAuth approval page escapes its values, has a
nonce CSP and frame protection; state cookie + sealed flow for Google sign-in; PKCE S256 enforced; tickets are single
use (nonce in the scene object); CSRF/Origin checks on all cookie POST routes; dev hooks are behind `devGate`;
`MCP_TOOLS` in stats.ts matches the registered tool names; the HyperLogLog position/estimate maths.

### Fake Google, local server, build config

Files read completely: `online/worker/fakeGoogle.ts`, `scenes-server/server.mjs`, `scripts/setup.mjs`,
`scripts/start.mjs`, `scenes-plugin/vite.config.mts`, `scenes-plugin/tsconfig.json`, `scenes-plugin/src/env.d.ts`.
Read for confirmation: `online/worker/index.ts`, `auth.ts` (devGate, isLocalOrigin), `google.ts`, `online/build-worker.mjs`,
`online/wrangler.jsonc`, `online/dev-vars.mjs`, `online/package.json`, `.github/workflows/deploy-kurviq.yml`, parts of
`scenes-plugin/src/online/drive.ts`, `pdfExport.ts`, `slidesUI.tsx`, `scenes-mcp/tools.mjs`, `online/test/live-server.mjs`,
`scenes-plugin/test/e2e/*.mjs`.

**Can the fake Google be reached in production? No (traced).** Three independent conditions must hold, and production
meets none of them:
1. `env.FAKE_GOOGLE === "1"`: only written by `online/dev-vars.mjs` into `.dev.vars` (wrangler dev). It is not in
   `wrangler.jsonc` `vars`, and the deploy workflow sets nothing like it.
2. A local `DEV_ORIGIN` (`handleFakeGoogle`, `fakeGoogle.ts:133`), also only in `.dev.vars`.
3. `index.ts:442`: with `FAKE_GOOGLE=1` every request must pass `devGate` (loopback `CF-Connecting-IP` or a localhost
   host), else 503. On Cloudflare neither can be forged, so a mis-set flag fails closed (the whole site answers 503).
`googleUrls` (`google.ts:23`) switches to the fake under the same flag + local origin. What remains is listed under
"Code smells" (the fake ships in the production bundle) and "Potential bugs" (the app build flag).

No finding in `scripts/setup.mjs`, `scripts/start.mjs`, `scenes-plugin/tsconfig.json`, `scenes-plugin/src/env.d.ts`.
In `scenes-server/server.mjs` there is no path traversal (no request-derived file paths; PDFs use fixed names in a
`mkdtemp` directory), the server binds to 127.0.0.1 only, and Host / Origin / JSON checks are in place; the gaps are below.

### Browser: live sync

Files read completely: `scenes-plugin/src/online/liveSync.ts`, `liveProtocol.ts`, `liveMerge.ts`, `liveQueue.ts`, `liveCrypto.ts`, `frames.ts`, `version.ts`.
Read for confirmation only: parts of `online/worker/scene.ts`, `online/worker/serverMerge.ts`, `online/worker/sceneRoutes.ts`, `scenes-mcp/elementContent.mjs`, `scenes-plugin/src/merge.ts`, `scenes-plugin/src/controller.ts`, `scenes-plugin/src/online/drive.ts`, `docs/live-sync/PROTOCOL.md`.

Nothing was run; every finding is from reading the code. No finding concerns key derivation or nonce use: each event gets a fresh random 96-bit IV and the AAD binds scene, kind, id and key id.

### Browser: Drive client and online UI

Files read completely: `scenes-plugin/src/online/drive.ts`, `ui.tsx`, `tabServer.ts`, `folderAccess.ts`,
`pairing.ts`, `md5.ts`, `pubName.ts`, `linkTarget.ts`, `linkHint.ts`, `online.scss`, `scenes-plugin/src/publicScene.tsx`.
Nothing was run; every finding is traced in the code (and in the callers / Worker code named in it).

Checked and found fine (no finding): no `dangerouslySetInnerHTML` / `innerHTML` in these files, names and
bylines are rendered as text, `href`s are constants or built from ids; the token refresh is serialised
across tabs (`navigator.locks`) and matches the Worker's 10-minute refresh window; the 401 retry in
`drive()` is bounded to one; folder and revision listings paginate; the home-grown MD5 is needed (Drive's
version id is an MD5, Web Crypto has none, no dependency provides one), see the smell about its tests.

### Browser: controller, storage, router, merge

Files read completely: `scenes-plugin/src/controller.ts`, `storage.ts`, `router.ts`, `api.ts`, `merge.ts`, `spaces.ts`, `sceneGroups.ts`, `leanFiles.ts`, `uploads.ts`, `editorYield.ts`, `presentation.ts`, `fontSize.ts`, `viewTarget.ts`. Read for comparison: `scenes-plugin/src/online/liveMerge.ts` (all), `scenes-mcp/elementContent.mjs`, `sceneName.mjs`, `presentation.mjs` (all), parts of `online/worker/serverMerge.ts`, `scenes-mcp/editConflicts.mjs`, `scenes-plugin/src/online/drive.ts`, `online/ui.tsx`, `online/pubName.ts`.

All findings are from reading the code (nothing was run). Checked and found fine: account spaces cannot sync into another account's Drive (every Drive call refuses via `otherAccount()` in `online/drive.ts:467`), listeners and intervals are removed in `detach()`, `pushScene` re-checks the open scene after its network call.

### Browser: main UI, agent co-working (index, live, cowork)

All assigned files were read completely. Context for several findings: the MCP has two modes. "detached" (default, and the only one online) sends `scene-edit` / `local-edit`; "live" (local install only, opt-in with `SCENES_AGENT_MODE=live`, documented in README.md:535) sends `read` / `edit` / `preview`.

### Browser: slides, rich text, comments

Scope: `scenes-plugin/src/` slides.ts, slidesUI.tsx, present.tsx, deck.ts, deckCheck.ts, notes.tsx, pdfExport.ts, render.ts, fonts.ts, fontsUI.tsx, textTips.tsx, textPadding.tsx, titleTips.ts, richText/*.ts, comments/store.ts, comments/ui.tsx, and the three SCSS files (dead selectors, duplicated blocks only). All files were read completely. Nothing was run in the app; one finding (markdown round trip) was reproduced with a throwaway script in the scratchpad (model.ts bundled with esbuild, no repo change).

Checked and found sound (no finding): XSS through `innerHTML` / `dangerouslySetInnerHTML` (every doc passes `normalizeDoc`, `docToHtml` escapes text and attributes, links pass `safeLink`), paste handling (custom MIME JSON, HTML and plain text all end in `normalizeDoc`), font data and names (`DATA_RE`, `RANGE_RE`, `FAMILY_RE` are checked before a name or URL reaches CSS), the PDF page (CSP `default-src 'none'`), and duplicated SCSS rule blocks (none of 60+ characters).

### MCP server and shared modules (scenes-mcp)

Scope read completely: `scenes-mcp/tools.mjs`, `server.mjs`, `convert.mjs`, `editConflicts.mjs`, `elementContent.mjs`, `feedback.mjs`, `googleFonts.mjs`, `inspect.mjs`, `media.mjs`, `presentation.mjs`, `richDoc.mjs`, `richText.mjs`, `sceneComments.mjs`, `sceneName.mjs`, `slideRules.mjs`, all `*.d.mts`, `skill/kurviq-scenes/SKILL.md` + `REFERENCE.md`, `README-AGENTS.md`, `online/llms.txt`. Read for confirmation only: `scenes-server/server.mjs`, `online/worker/index.ts`, `pairing.ts`, `skill.ts`, `shims/fs-promises.js`, parts of `scenes-plugin/src/cowork.ts`, `live.ts`, `agentRequests.ts`, `online/tabServer.ts`, `online/drive.ts`, `online/worker/scene.ts`.

The `*.d.mts` files match the exports and signatures of their `.mjs` files (no finding).
