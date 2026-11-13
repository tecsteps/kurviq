# QA results: the November 2026 project

Run: 2026-11-13, QA agent (did not write the code). HEAD `fc21a8c` (working tree clean except an unrelated edit of
`specs/2026-11-13-own-database.md` that is not mine). Logs: `/private/tmp/claude-501/-Users-fabianwesner-Workspace-excalidrawlocal/c6a587f6-9521-46c1-9a5f-6da49c9692f3/scratchpad/qa/`
(called `qa/` below). Environments used: fake Google (`wrangler dev --port 8790` with `--var DRIVE_NEW:on --var GOOGLE_APPDATA:on`, and once without),
the real Supabase test project (through `own-database.mjs`), kurviq.com read-only (curl). The local install (MCP, PDF) and https were NOT driven
(see "blocked"/UAT): the local tab belongs to the owner's real scenes, and `https://draw.test` is not set up (connection refused).

## Baseline runs

| Run | Result | Evidence |
|---|---|---|
| Unit tests | 65 files, 618 tests passed | `qa/unit.log` |
| `npm run typecheck` | 17 errors (the expected upstream ones) | `qa/typecheck.log` |
| `online/test/relay-server.mjs` | 30 passed, 0 failed | `qa/relay.log` |
| e2e (all scripts, fake Google, switches on) | account-spaces, agent-image-missing, byline, commenter-mailbox, comments-polish, drive-new, drive-previews, empty-local-scene, frame-move, own-database (real Supabase, 69 checks), presentation-flag, public-viewer, reopen-last, share-panel, shared-folder, text-size: all exit 0, no FAIL | `qa/e2e-*.log`, `qa/summary.txt` |
| e2e share-panel, pen, shared-folder with the switches OFF | exit 0 | `qa/e2e-share-panel-noswitch.log`, `e2e-pen-noswitch.log`, `e2e-sf-noswitch.log`; `/drive/new` answers 404 and the sign-in scope has no `drive.appdata` |
| `pen.mjs` five times in a row | **FAILED**: runs 1-3 pass (32/32), runs 4 and 5 fail case 15 (2 checks each); two more runs afterwards (6, 7) passed | `qa/e2e-pen1..7.log` |
| SonarCloud open issues (`tecsteps_kurviq`, main) | 0 issues | curl at start of run |
| Production Worker bundle (`build-worker.mjs --production`) | no fake Google code (O1) | `online/build/worker.js` grep: only the agent OAuth routes and one doc string match |

## Summary table

| Part | pass | fail | blocked | UAT (Fabian) |
|---|---|---|---|---|
| Drive collaboration without server data (22 criteria) | 17 | 3 (3 partial, see below: 1, 3 partly; 15 flaky) | 0 | 2 (4 partly, 19 picker, 22 text) |
| Own database (15) | 12 | 0 | 0 | 3 (4 real Connect, 7 second browser on real Google, 11 real email) |
| Thumbnails (7) | 7 | 0 | 0 | 0 (real Drive look: UAT list) |
| Search text (5) | 4 | 0 | 0 | 1 (4) |
| Share with organization (4) | 4 | 0 | 0 | 0 (real domain: UAT list) |
| New scene from Drive (4) | 4 | 0 | 0 | 0 (real Drive menu: UAT list) |
| Access end date (3) | 3 | 0 | 0 | 0 |
| Comment polish (7) | 6 | 0 | 0 | 1 (7: S38/S39 only unit-level) |
| Local install https (4) | 1 (4: README) | 0 | 0 | 3 |
| Code review table (about 38 rows) | 12 first pass + 26 second pass = 38 (second pass: 25 pass, 1 pass with observation (S7), 0 fail; B2 with a stand-in for headless Chrome, see "Code review checks, second pass") | 0 | 0 | 1 (B2 with the real `Google Chrome`, UAT 14) |
| Own checks (UI at 390 px, Tab, Esc, console) | 5 | 3 observations | 0 | 0 |

Counting note: where a criterion is partly proven and partly real-Google only, it is listed as pass with the UAT item named.

## Failures (one line each)

1. **pen.mjs case 15 (offline edit) is flaky: 2 of 5 consecutive runs failed** (runs 4 and 5), 0 of 2 later runs. The plan requires five in a row. In the failing runs the tab that goes offline is already a viewer ("Pene took over editing", `relay: connected`), so it draws nothing offline and `wanted` has one id, not two. See criterion 15.
2. **Criterion 3 not met as written**: `TOKEN_KEY` is still read by the Worker (`online/worker/auth.ts:324-376`, `sceneRoutes.ts:321`, `scene.ts:119`). The spec itself leaves the follow-up release unchecked (spec line 186), so this is "known, pending the drain", not a regression.
3. **Criterion 1 partly**: `online/worker/sceneRoutes.ts:321` + `account.ts:104` write a **sealed Google refresh token** (`retryRevoke`, meta key `revoke`) into the account Durable Object for up to 30 days when "sign out everywhere" cannot revoke at Google. The spec lists only short links, sign-out records, statistics, feedback and contact as writes. Documented in the file header of `account.ts`, but not in the privacy page and not in the criterion.

Observations (not failures): (a) `online/pages/privacy.html` says nothing about the own-database feature (the Worker passes a Supabase management token through for the setup, `online/worker/supabase.ts`) or the sealed refresh token above. (b) The "Move to…" dialog of a new scene while the setting is "in Google Drive" shows the pill with the browser (laptop) icon and "Not in Drive yet", and the dialog says "Google Drive (it is here now)", "This browser only" preselected: consistent internally but the pill icon does not show the scene's home (criterion 2 of the own-database spec) until the first save (`qa/shots/phone-move-to.png`). (c) Scene-list/Databases/Drive flyovers on the 390 px layout did not close with Esc in my script after I had moved focus out with Tab (desktop did): flyovers are not modal and Esc works only with focus inside; the modal dialogs close with Esc in both sizes. Not a spec requirement.

## Per spec

### Drive collaboration without server data (`2026-11-13-drive-collaboration-without-server-data.md`)

| # | Result | Evidence |
|---|---|---|
| 1 | **fail (partial)** | Code read of every storage / D1 / KV write in `online/worker/*.ts` (grep `storage\.`, `.prepare(`, `sql.exec`): writes are: D1 `pub_links` (pubLinks.ts), `feedback`, `contact_messages` (feedback.ts, contact.ts), stats tables (stats.ts, DO `Stats` SQLite: counters, HLL registers, day key), retention deletes (retention.ts); DO `AccountGuard` (account.ts: epoch + account id, old scene ids until drained, revocations), `Pairing` (pairing.ts: one-time agent code ids `code:`; socket attachments hold the tab's state), `SceneRoom` (scene.ts: drain only, deletes). No KV namespace in `wrangler.jsonc`. No scene content, comments or tokens written, **except** the sealed refresh token (failure 3). A live check that every scene DO is empty needs production: UAT item 9 (drain). |
| 2 | pass | `online/worker/relay.ts:3-4`, grep of `relay.ts`/`relayRoom.ts` for `storage|acceptWebSocket|getWebSockets|serializeAttachment|setAlarm` empty; `scenes-plugin/test/relay.test.ts:215-287` (storage proxy that throws, source grep). |
| 3 | **fail (pending follow-up)** | `TOKEN_KEY` still read (see failure 2); `PSEUDONYM_KEY` is not read (grep: only dev-vars/secrets). Shared-folder route is gone: `shared-folder.mjs` "no folder route on the server any more 405"; no `folders.ts` in `online/worker`. |
| 4 | pass | `public-viewer.mjs`: `/api/public/<id>` metadata only, uncached; viewer reads Drive with the browser key, not through the Worker; not public: 404. Production: `/api/public/<random>` answers `{"error":"Not a public scene"}` 404. |
| 5 | pass | `pen.mjs` case 5 (runs 1-3, 6, 7). |
| 6 | pass | `pen.mjs` case 6. |
| 7 | pass | `pen.mjs` case 7 (same account other tab) + `pen.test.ts` (5 idle minutes). |
| 8 | pass | `pen.mjs` case 8; `relay-server.mjs` "exactly one of two claims wins". |
| 9 | pass | `pen.mjs` case 9; relay-server "holder leaving frees the pen". |
| 10 | pass | `pen.mjs` case 10. |
| 11 | pass | `pen.mjs` case 11. |
| 12 | pass | `pen.mjs` (pointers are part of case 5/11 checks) and `own-database.mjs` pointers; relay-server payload routing. |
| 13 | pass | `pen.mjs` case 13 (mark decides, md5 / modifiedTime unchanged). |
| 14 | pass | `pen.mjs` case 14. |
| 15 | **fail (flaky)** | `pen.mjs` case 15 failed in runs 4 and 5 of 7 (`qa/e2e-pen4.log`, `e2e-pen5.log`); passes alone and in runs 1-3, 6, 7. Steps to reproduce: run `pen.mjs` repeatedly against one long-running `wrangler dev`. Expected: the tab that holds the pen goes offline (relay blocked and socket closed), keeps `me: holder`, draws, and merges on return. Actual: at the time of the check the tab is `me: viewer`, relay still `connected`, holder = the other editor, notice "took over editing": the pen was taken over before the offline step took effect (the "Edit" click of the other tab, or a takeover offered during the blocked-socket window). Likely place: pen state machine in `scenes-plugin/src/online/pen*.ts` (takeover while a holder's socket is being closed) or the test's sequencing; the plan already flagged this case. |
| 16 | pass | `commenter-mailbox.mjs` ("comment through the relay is in the Drive file after the holder's save", recorded on the commenter's behalf). |
| 17 | pass | `commenter-mailbox.mjs` (Drive comment, "waiting", editor takes it in and deletes the Drive comment). |
| 18 | pass | `commenter-mailbox.mjs` ("forged change refused, owner's comment unchanged"); `commenterMailbox.test.ts`. |
| 19 | pass (fake) / UAT (real picker) | `shared-folder.mjs` (picks, "2 new scenes in this folder: open them"). Does Google's real picker grant files inside a folder: UAT 3. |
| 20 | pass | `shared-folder.mjs` "no folder route on the server any more"; no folder tables in the worker. |
| 21 | pass | `workerRoutes.test.ts`, `stats.test.ts`, `pubLinks.test.ts` green; short link e2e in `public-viewer.mjs`; feedback flood (own check): 25 parallel posts from one address: 10 x 200, 15 x 429 (hourly limit 10). |
| 22 | UAT (Fabian) | Production `https://kurviq.com/privacy` lists: short links, sign-out record (400 days), statistics, feedback/contact, memory-only relay. Matches the criterion; missing: sealed refresh token, own database (observation a). Fabian to confirm the wording. |

### Own database (`2026-11-13-own-database.md`), `own-database.mjs`, 69 PASS against the real Supabase test project (`qa/e2e-own-database.log`)

| # | Result | Evidence |
|---|---|---|
| 1 | pass | "New scenes are kept: in this browser / in Google Drive / in Test", "the setting survives a reload". |
| 2 | pass | "the pill shows the database icon"; scene-list icon: seen in `qa/shots/*` (switcher list shows icons per scene). See observation b for an unsaved Drive scene. |
| 3 | pass | "Move to Google Drive / from Drive to the database / from the database to this browser", everything kept, 'moved' notes, link to old place says moved, deleting the old copy is offered and works. |
| 4 | pass (fake OAuth) / UAT (real) | "Supabase's OAuth with PKCE (S256)", project created, schema run, password shown once, "neither the management token nor the password is kept in the browser's storage". Real Connect: UAT 6. |
| 5 | pass | Code read `online/worker/supabase.ts` (header, `ALLOWED` list of 8 Management API calls, same-origin only, secret keys stripped by `publicKeysOnly`, nothing stored); `workerRoutes.test.ts`; e2e "the code and its verifier go to the Worker's exchange". |
| 6 | pass | "not even the setup's pass-through was used (paste URL + key)". |
| 7 | pass (same account, fake Drive app data) / UAT | "the connection follows through Drive's app data". Real second browser: UAT 7. |
| 8 | pass | "a paused project: Your database is paused: open Supabase to wake it". |
| 9 | pass | latency 103 ms, pointers with name, selection, different elements both kept, same element later version wins, nothing else lost. |
| 10 | pass | "offline ... database-pending", "back online, the offline edit is written". |
| 11 | pass (admin link) / UAT (real mail) | invitation through the mailer, invitee signs in with the email's code, viewer read-only, commenter comments only (forged comment refused), editor edits. Real email: UAT 8. |
| 12 | pass | removed viewer reads nothing and the open scene stops; end date ends access. |
| 13 | pass | public scene opens without account, no comments, anonymous write refused by row-level security. |
| 14 | pass | "no database content, key or session in any request to Kurviq's server []", browsers talked to `*.supabase.co` directly. Note: during setup the management token and the code pass through the Worker (not stored), as the spec says. |
| 15 | pass | read_scene / edit_scene through the tab incl. comments, scene not open too. |

### Thumbnails (`drive-previews.mjs`, 21 PASS)

1 pass (PNG 400 px wide, shows the red box; `thumbnailLink` serves 200). 2 pass (deck: 16:9, first slide; empty scene: no thumbnail, no error). 3 pass. 4 pass (agent edit). 5 pass (12 MB picture, scene 16.5 MB saves, preview 531 KB). 6 pass (local-only sends nothing). 7 pass (no request to Kurviq's server carries a preview; 40 hint requests went to Google's endpoints). Real Drive rendering of the hint: UAT 1.

### Search text (`drive-previews.mjs` + `driveContentHints.test.ts`)

1 pass (name, text, label, slide titles; deleted words absent). 2 pass (comments not, speaker notes not). 3 pass at unit level (`cutAtWord` at a word boundary in bytes, 128 KB limit; the e2e did not save a 128 KB scene: only the unit test and the 12 MB picture save). 4 UAT (real Drive search, UAT 2). 5 pass (agent edit updates; local-only sends nothing).

### Share with organization (`share-panel.mjs`, 21 PASS)

1-4 pass (domain option for the Workspace account, none for gmail.com; `domain` permission reader, `allowFileDiscovery:false`; colleague opens with the role, outsider cannot; back to restricted removes it). Real domain sharing: UAT 4.

### New scene from Drive (`drive-new.mjs`, 21 PASS)

1 pass (fake redirect), 2 pass (other account told which account; nothing created; signed out asked to sign in with `login_hint`), 3 pass ("Other folders", after reload), 4 pass (302 to the app, no cookie, route has no storage; `driveNew.ts`). Real Drive "New → More → Kurviq": UAT 5. Production `drive/new` answers "Not enabled yet" 404 (switch off) and the sign-in asks for no new scope (`drive.file`, `drive.install`, as before; no `drive.appdata`).

### Access end date (`share-panel.mjs`)

1 pass ("Access until…" on viewer row, "until 23 Nov", Drive's `expirationTime` 2026-11-23T22:59:59Z), 2 pass (No end date removes it; editor row has no option), 3 pass (expired access opens nothing). Real `expirationTime` behaviour: UAT 4.

### Comment polish (`comments-polish.mjs`, 27 PASS; `commenter-mailbox.mjs`)

1 pass (Shift+C, Esc, no trigger while typing in text, filter, comment box). 2 pass (counts open 3 / resolved 2 / mine 1 / mentions 1 and lists match). 3 pass (unread dot, cleared on open, another browser keeps its own). 4 pass (scene list "3 open comment threads"). 5 pass (resolved 8 days ago hidden, pin too; turned off shows them). 6 pass ("waiting for an editor" in `commenter-mailbox.mjs`). 7 **UAT / unit only**: S38 (failed delete keeps popover) and S39 (mentions in the viewer) have no e2e; not driven by me; U21 `useCopy.ts` exists (code read).

### Local install on https (`2026-11-13-local-install-https.md`)

1 UAT (`https://draw.test` refuses the connection here: `npm run setup:domain` not run; `http://draw.test` answers 200). 2 UAT (the move needs both origins; `browserMove.test.ts` green at unit level; the dialog opens and traps focus, `qa/shots/desk-movebrowser.png`). 3 UAT. 4 pass (README lines 194, 272-281 describe `npm run setup:domain` and the move).

## Code review table (plan)

Driven by me and passed: **B14** (production `auth/login?return=http://evil.test/` shows a confirmation page naming `http://evil.test`; loopback goes on; no hand-over without click), **B16** (own flood test, 10 stored then 429; `feedback.ts` daily cap 500), **B37** (`/constructor`, `/toString`, `/__proto__`, `/hasOwnProperty`, `/features`, `/about` on the fake: no crash, no page error; the odd names open the start page exactly like any unknown name, no message was shown), **B33** and public viewer (`public-viewer.mjs` "the change shows, with its background"), **B38** (`account-spaces.mjs` 24 PASS), **B39/B36/B34/B35** (green unit tests `routerCopies`, `mergeFixes`, `controllerQueue`, `controllerFixes`), **O1** (bundle grep above), **S1** (code read: `online/secrets.mjs:34-50` prints help and sets nothing without names; `COOKIE_KEY_PREVIOUS` in `auth.ts:148-189`, test in `workerRoutes.test.ts`; I did not run the script: setting secrets was refused by the sandbox), **S2** (`.github/workflows/deploy-kurviq.yml`: typecheck and `npm test` steps before deploy; a failing step stops the release; no CI log of a failing push seen), **S4** (dialog focus: `useDialogFocus` used by 9 dialogs; Move browser scenes, Move to… and the database dialogs: Tab never left the dialog, Esc closed them at desktop and 390 px; `dialogFocus.test.ts`).

**Blocked / not driven (26 rows)**: B2 (local `export_pdf`: the local tab holds the owner's real scenes; `localPdf.test.ts` green), B5, B6, B7, B18, B31, B32 (250 shared scenes), B40, B41, B42, B43, B44, B45, B46, B47, B48, B49, B50, B51, B52, B53, B54, B55, S7. For each, the corresponding unit tests pass (618 green) but I found no finding-id-to-test mapping (the tests do not carry the ids) and did not write a script per row within this run. Re-check these (agent / slides / richtext rows) before declaring the review done. "Superseded findings": not checked, per the plan.

## Points noted during the build

| Point | Result |
|---|---|
| pen.mjs five times, and once after all others | **fail** (3/5; see failure 1) |
| Sign-in dialog together with New-scene dialog (cosmetic) | not driven (`drive-new.mjs` signed-out path shows only the sign-in dialog) |
| Reload after a pull keeps new comments | pass (`comments-polish.mjs` "after a reload: still read", `commenter-mailbox.mjs` "after a reload: the waiting comment is listed") |
| Esc in the shared viewer closes popover first | not driven (UAT 10) |
| Opening a scene waits for a running operation | pass at unit level (`controllerQueue.test.ts`, `openOrCreate.test.ts`); `reopen-last.mjs` passes |
| Kurviq page names refused for new scenes on kurviq.com | partly: `/features` and `/about` open the pages (production 200). Creating a scene named `about` in the UI not driven |
| `DRIVE_NEW` / `GOOGLE_APPDATA` with `--var` on, and production sign-in asks for no new scope | pass: with the vars the drive-new, own-database (Drive app data) and shared-folder scripts pass; without, `/drive/new` 404 and scope has no appdata; production sign-in scope is `drive.file` + `drive.install` only |

## UI check at desktop and 390 px (`qa/ui.mjs`, screenshots in `qa/shots/`)

Dialogs/panels: scene switcher, Databases flyover, Google Drive flyover, scene manage panel (icon row incl. Move to…), Move to… dialog, Comments list, Move browser scenes dialog. No horizontal page overflow at 390 px in any of them; no console error or page error during the whole UI run (`errors: []`). Modal dialogs: Tab stays inside, Esc closes. The share panel (Share) and the pen bar were covered functionally by e2e but not screenshotted at 390 px by me (my click on "Share" did not find the control in the unsaved-scene panel): UAT 12 look-over. The "New Kurviq scene" dialog was only exercised in `drive-new.mjs` (desktop).

## UAT for Fabian

1. **Thumbnails on real Drive.** Sign in on kurviq.com, make a scene with a shape, wait for the save, open Drive (grid view): the file shows a preview of the drawing; edit, save again: the preview updates; a deck shows slide 1; an empty scene has the generic icon.
2. **Search.** In Drive's search box type a word that is only inside a scene's text: that scene is found (indexing can take minutes); a word you deleted stops finding it.
3. **Picker and shared folders.** Share a Kurviq folder with a second account; as that account choose "Shared with you…", pick the folder in Google's picker: its scenes should open without another pick; add a scene as the owner: the guest sees "1 new scene in this folder: open them".
4. **Domain sharing and expiry.** With the Tecsteps account: General access shows "Anyone at tecsteps.com ..."; a colleague opens the link with that role; a gmail account cannot. "Access until…" a viewer: Drive's "Share" dialog shows the expiry; at the date the person loses access.
5. **New → More → Kurviq (after the console setup for `DRIVE_NEW` and the Workspace Marketplace SDK "New" action).** Click it in a Drive folder: the name dialog names the folder, the scene is created there and opens signed in as that account; with another account signed in, Kurviq asks to switch.
6. **Real Connect with Supabase** (after `npm run secrets -- SUPABASE_CLIENT_SECRET`): Settings, Databases…, Connect, approve at Supabase, create a project, note the password dialog, the scene works; the browser storage has no management token (DevTools, Application).
7. **Second browser:** sign in with the same Google account on another browser: the database connection is listed (needs `GOOGLE_APPDATA` on and the consent screen with `drive.appdata`).
8. **Real invitation:** invite an email address as viewer, open the mail's link, enter the 6-digit code: viewer cannot edit. (The default Supabase mailer sends only a few mails per hour.)
9. **Production drain:** signed in on kurviq.com, in the console run `fetch("/live/drain",{method:"POST"})`: it should answer that nothing is left to drain; afterwards the follow-up release (delete the `SceneRoom` class, remove `TOKEN_KEY`) can go out, which closes failures 2 and 3.
10. **Shared viewer:** open a `/s/...` link of a public scene, add a comment placement, press Esc: the popover/placing closes first, the viewer stays.
11. **Console setups:** `DRIVE_NEW` (Workspace Marketplace SDK "Drive UI integration" with the new-file URL `https://kurviq.com/drive/new`) and `GOOGLE_APPDATA` (add the scope on the consent screen, then set the var). Then re-run steps 5 and 7.
12. **Look at the share panel and the pen bar on your phone** (390 px width): readable, buttons reachable, no horizontal scroll.
13. **Local install on https:** `npm run setup:domain` (Herd), open `https://draw.test`: `crypto.subtle` exists (`!!crypto.subtle` in the console), sign in with Google works; on `http://draw.test` main menu "Move browser scenes…" saves a file; on `https://draw.test` import it: the same scenes; open a Drive scene in two tabs: the pen bar appears (relay works over https).
14. **Local agent checks** (I did not touch your open tab): in your tab ask the local MCP to `export_pdf` of a deck (B2), and to `edit_scene` while you draw (B41).
15. **Privacy wording:** decide whether `online/pages/privacy.html` should name the own database / Supabase pass-through and the sealed refresh token that is kept up to 30 days when "sign out everywhere" cannot reach Google.

## Environment restored

`.dev.vars` restored from `dev.vars.mine` (diff clean), `npm run build:online` and `cd online && node build-worker.mjs` run again, my wrangler stopped, lock released. No product code, spec or test changed; no commit, push or deploy.

## Code review checks, second pass

Run: 2026-11-13, same QA agent, after the first pass. Setup, all throwaway: a **second local install** next to the owner's (scenes server on port 3199, Vite app on port 3201, a fresh browser profile per run, scenes created only there), the real stdio MCP server (`scenes-mcp/server.mjs`, detached and live mode) driven by the MCP SDK client, and for the online rows the fake-Google Worker (`wrangler dev --port 8790`, fake app build). The owner's install (3001 / 3101) and its open tab were not touched. Scripts and logs: `/private/tmp/claude-501/-Users-fabianwesner-Workspace-excalidrawlocal/c6a587f6-9521-46c1-9a5f-6da49c9692f3/scratchpad/qa2/` (`a1.mjs` ... `b52.mjs`, logs in `qa2/logs/<script>.log`, called `logs/` below). Unit tests again: 65 files, 618 tests green (`qa2/unit.log`). No finding failed. The Status lines of the findings do not name tests; the test names below are the ones I found by grep and read.

Unit test per row (name = `file > describe > it`) and the app check that was driven:

| Row | Result | Unit test | Driven in the app (script, log) |
|---|---|---|---|
| B2 | **pass, with a caveat** | `localPdf.test.ts > printPdf > runs Chrome and returns the PDF it wrote` | `a4.mjs` (`logs/a4.log`): MCP `export_pdf` of a 3-slide deck from the second local install returned a 3-page PDF (12.8 KB, `%PDF-`, `pdftotext`: "Selectable slide one text", "Page 1 of 3"), `slides: [2]` gave a 1-page PDF; no `execFile is not defined`, no "PDF export failed". **Caveat:** in this agent session neither real headless Chrome could print: `Google Chrome` 157 (the first candidate of `findChrome`) exits 0 without writing a file for any HTML, Chrome for Testing hangs (`CVDisplayLinkCreateWithCGDisplay failed` in the log), also with a one-line page and with the server's flags removed one by one. So the run used `CHROME_PATH` = `qa2/fakechrome.mjs`, a stand-in that takes the same arguments and prints the same file with puppeteer. That proves the server code path, the app's HTML (CSP prefix, meta check) and the MCP tool, not Chrome's own printing: UAT 14 on the owner's desktop (real Chrome). Observation: when Chrome exits 0 without a file, `pdf.mjs` resolves (`error && !existsSync(out) ? reject : resolve()`) and the user gets `PDF export failed: {"error":"ENOENT: no such file or directory, open '.../slides.pdf'"}` instead of "Chrome printed nothing". |
| B5 | pass | `richMarkdown.test.ts > markdown round trip > writes bold + italic so that it reads back (the reported case)`, `> keeps a link address with parentheses, balanced or not`, `> keeps plain paragraphs that look like headings or list items`, `> keeps random documents` | `a5.mjs` (`logs/a5.log`): agent texts with bold + italic (`**bold and *italic inside* more** and ***both***`), italic with `\*`, `[x](https://example.test/a_(b))`, a list: `read_scene` markdown sent back via `edit_scene` is identical (5/5). `a6.mjs` (`logs/a6.log`): slide notes with all of these plus a paragraph `\- plain dash paragraph`: opened and closed, a letter typed and deleted (saved through the editor), twice: stored notes identical to the seed; the editor shows the dash paragraph as a paragraph, not a bullet. Not driven: the presenter-view window (only `notesHtml` at unit level, `presentationNotes.test.ts`). |
| B6 | pass | `slidesSync.test.ts > addTitleBlock > adds headline and eyebrow to an old template whose slides have no headline (no crash)` | `a7.mjs` (`logs/a7.log`): deck without headline/eyebrow roles and without slide headlines: `edit_scene(addTitleBlock: true)` adds exactly one headline and one eyebrow to the template, a second call adds nothing, no error; opening an old-style deck in the app adds each once, console empty for 6 s (no error loop). |
| B7 | pass | `scenesMcp.test.ts > edit_scene and edit_open_scene: every operation alone is an edit > sends comments, isPresentation, restyle, reset or addTitleBlock without element changes` | `a1.mjs` (`logs/a1.log`): through the real MCP, each alone: `comments` (listed by `read_scene`), `isPresentation` true and false (saved), `reset: ["foot~s1"]` and `reset: "all"` and `restyle: true` (changed copies back to the template colour), `addTitleBlock` (accepted, no-op on a deck that has them); an edit with no operation is still refused ("Nothing to do"). The one `FAIL` line in `logs/a1.log` is a wrong assertion of my script (it expected the word "title" in an empty result); the call was not refused. |
| B18 | pass | `workerRoutes.test.ts > agent sign-in (OAuth) > redeems a code once` | curl against the fake-Worker (real Pairing Durable Object): register, approve, `/oauth/token` twice with one code: first 200 with tokens, second and third `400 invalid_grant "The code was used already: sign in again"` (output in this section's evidence, not saved to a log file). |
| B31 | pass | `commentList.test.ts > copy to clipboard (one helper) > answers whether it worked, never throws` | `b31.mjs` (`logs/b31.log`): signed in on the fake, share panel "Copy link" and MCP dialog "Copy prompt" with `navigator.clipboard` undefined and with `writeText` rejecting (NotAllowedError): the button says "Could not copy" (tooltip: "your browser refused the clipboard"), no page error, no `unhandledrejection`; with a working clipboard "Copied". There is no fallback copy (`execCommand`): the spec only asks for "copy or say why not". Limit: a real non-secure origin was not reachable (Wrangler listens on localhost only), emulated by removing the clipboard. |
| B32 | pass | none (grep for `sharedWithMe`/`nextPageToken` in the tests: no unit test) | `b32.mjs` (`logs/b32.log`): 1100 scenes shared with and granted to a guest on the fake (the plan says 250; the fake pages at 1000, so 1100 also needs the next page): the guest opens `/Shared scene 0000 / 0199 / 0200 / 0249 / 0999 / 1000 / 1099` and each opens its own file (`/s/<its id>/...`); the Drive log shows 14 `sharedWithMe` requests, 7 with `pageToken`. (A first attempt with 250 scenes also passed but cannot tell paging from a bigger page size.) |
| B40 | pass | `coworkEdits.test.ts`/`scenesMcp.test.ts`: `checks the comment operations before the elements are changed` (`coworkEdits.test.ts:458`) | `a2.mjs` (`logs/a2.log`): `edit_scene` with an added element plus a `reply` to a missing thread: refused (`comments[0]: no thread "no-such-thread"`), the element is not there; the open-scene `edit` command with the same: refused, element count unchanged. |
| B41 | pass | `coworkEdits.test.ts > agent edits merged with what the user did meanwhile` (`keepUserChanges`: keeps user changes, a clash refuses) | `a2.mjs`: an open-scene edit adding 40 texts (conversion takes time), the user's rectangle added through `updateScene` in the same tick: result ok, the user's rectangle and the 40 texts are all on the canvas. The detached local-only path has no await between read and write, so it cannot be raced from outside; covered by the unit tests. |
| B42 | pass | `coworkEdits.test.ts > agent edits of the open scene and of local-only scenes > does not apply an edit to another scene the user switched to meanwhile` | `a2.mjs`: `edit` with `expectScene: "sc1"` while `sc2` is open: refused "The user switched scenes: the app now shows "sc2", not "sc1"", nothing in `sc2`. Race (switch right after sending a 40-text edit): the texts landed nowhere in the scene switched to. |
| B43 | pass | none for the requestId dedupe at tab level; `scenesMcp.test.ts` covers detached `requestId` only | `a2.mjs`: the open-scene `edit` with one requestId twice: applied once ("This request ... was applied at ...; nothing was applied again"); two concurrent edits: both land. `b43.mjs` (`logs/b43.log`): the real MCP in live mode (`SCENES_AGENT_MODE=live`) through a logging proxy: `edit_open_scene` sends `requestId: "edit-<revision>"` in the `edit` command (the remainder named in the finding's Status is done in `tools.mjs`: `requestId: \`edit-${revision}\``), the same command sent again is not applied twice. The finding's Status line still says "partly fixed ... remains"; the text is outdated. |
| B44 | pass | `editorRelease.test.ts > the editor is gone only when nothing holds it any more` (3 tests) | `b44.mjs` (`logs/b44.log`): signed in on the fake, 7 resizes between 1300, 390, 500, 1024 px: "the editor is gone" never logged, the editor stays attached, an edit made afterwards reaches Drive (revision content has the new element). |
| B45 | pass | `slidesSync.test.ts > template sync > keeps a slide's hand-changed copy when its template element leaves the template, and drops unchanged ones` | `a7.mjs`: slide 1's copy with own text and slide 2's copy with own colour stay (not deleted) after the template element is deleted; an unchanged copy of another removed template element goes. |
| B46 | pass (size part driven; late-font part by code read) | none (no test for `sizes`/`richMeasure`) | `a8.mjs` (`logs/a8.log`): one word of a formatted text set to size 2, 3, 2, 1: the box is 197x60, 229x90, 197x60, 164x30 (re-measured each time, back to the first value). The late-font half (`sizes.clear()` in the `loadingdone` handler, `richId` in `sizeKey`) is in `richText/layout.ts` (read), not driven: loading a Google font after a measure could not be forced from outside. |
| B47 | pass | none (UI) | `a8.mjs`: PDF tab, no slide selected: "This slide (select one first)" disabled; slide 2 selected: "This slide (2: s2)" enabled; chosen, then deselected: radio disabled and "Download PDF" disabled (nothing exported, not slide 1). |
| B48 | pass | `slidesSync.test.ts > duplicating a slide keeps its own versions of template elements > renames the duplicated copies to the new slide's copy ids, references included` | `a7.mjs`: the card's "Duplicate slide 1" button: the duplicate has the slide's own headline ("Our own headline") and the changed template copy (own logo text). |
| B49 | pass | `slidesSync.test.ts > template sync > fills placeholders inside formatted template text and keeps the formatting` (and `... leaves formatting whose placeholder is split across pieces`) | `a7.mjs`: template text `**Page {page}** and *{title}*`: the slide copies read `**Page 1** and *s1*`, `**Page 2** and *s2*`. |
| B50 | pass (one tab) | `browserHelpers.test.ts > notes changed elsewhere while the notes popover is open > are shown when nothing typed is unsaved, and wait for the user's choice when something is` | `a8.mjs`: notes popover open: an agent edit of the notes shows in the editor when nothing is typed; with unsaved typing and another agent change the bar "These notes were changed elsewhere while you typed. Show theirs / Keep mine" appears, the stored notes stay the other version, "Show theirs" shows it. The "elsewhere" was an agent edit in the same tab, not a second tab (cross-tab sync of local-only scenes was not driven). |
| B51 | pass | `scenesMcp.test.ts > edit_scene: retries and conflicts` (the `alreadyApplied` test, line 191) | `a3.mjs` (`logs/a3.log`): `edit_scene` with `basedOn` + `requestId` twice: the second answer has `alreadyApplied`, and no `conflicts`, `warning` or `userChanges`. The `FAIL` lines about B51 in `logs/a2.log` (my assertion expected `true`, the field is a string) and `logs/a3.log` (my second scenario had the user change the element before the first edit, so that edit was correctly rejected and the retry correctly rejected again: not "an applied edit") are mistakes of my scripts, not findings. |
| B52 | pass | `scenesMcp.test.ts > a flush the user's app did not answer` | `a3.mjs`: tab frozen with the debugger (flush times out after 15 s): `read_scene`, `edit_scene`, `save_scene` all refused ("The user's app did not answer ... Nothing was read or changed"), nothing applied. `b52.mjs` (`logs/b52.log`): no tab at all: `read_scene`, `edit_scene`, `save_scene`, `get_scene`, `view_scene` refused "Kurviq is not open in a browser". |
| B53 | pass | `mcpMedia.test.ts > image sizes > reads lossy (VP8) and lossless (VP8L) WebP`, `> reads SVG sizes in single quotes` | `a2.mjs`: real WebP files from Chrome's canvas (both came out as `VP8X`, i.e. the extended header, not the plain VP8/VP8L chunk of the finding; those two plain formats are only in the unit test), height 16 given: 32x16; SVG with single-quoted width/height 60x30; single-quoted viewBox with height 10: 20x10. None is 1x1. |
| B54 | pass | `scenesMcp.test.ts > save_scene > replace keeps the scene's comments and fonts`, `coworkEdits.test.ts > local-only scenes: comments > a replacing scene keeps the replaced scene's comments, merged with its own` | `a2.mjs`: local-only scene with a comment and the Inter font: `save_scene(replace: true)`: comments and `kurviqFonts` (Inter) still in the stored scene, elements replaced. The Drive variant was not driven (unit test). |
| B55 | pass | `scenesMcp.test.ts > checkpoints hold the whole scene > get_scene(checkpoint) stores pictures, background and fonts; view_scene and save_scene use them` | `a2.mjs`: scene with a picture, background `#fdf6e3` and Inter: `get_scene(checkpoint: true)`, `view_scene(checkpointId)` returns an image (`qa2/pdfout/b55-checkpoint.png`), `save_scene(checkpointId, local: true)`: the copy has the background, the picture's file and the font. |
| S7 | **pass with an observation** | none | `a9.mjs` (`logs/a9.log`): `requestAnimationFrame` calls counted per source file over 3 s while idle: empty scene, no threads: 0 calls; deck with the slides sidebar open, no threads: no call from `comments/ui.tsx` (the finding's always-running pin loop is gone; with a thread it runs, as the control shows), but **`notes.tsx` still runs a rAF loop at 60/s (180 in 3 s) in every deck** (`useNameSpots`; `HiddenVeils` only with hidden slides). The fix made the loop cheap (early return while the camera is unchanged, `SETTLE_FRAMES`), which is what the finding's suggested fix allows ("or at least skip the work"), but the plan's wording "no requestAnimationFrame loop runs" is not literally met for a deck. The `FAIL` line in `logs/a9.log` is this. Decide whether that is acceptable. |

Counts: 26 rows checked: **25 pass** (B2 with the stand-in Chrome), **1 pass with an observation** (S7), **0 fail**, 0 blocked. Reasons that were open in the first pass: no per-finding script. Now each row has a driven check except where written above (B46 late font, B5 presenter view, B50 second tab, B54 Drive variant, B31 real non-secure origin).

Observations (not findings, not failures):
- Scenes server (`scenes-server/server.mjs`) after a QA run: a Kurviq tab of a Chrome helper process that I did not start was connected to my port 3199 (a leftover of someone's tab at `localhost:3201`); it answered some of my first calls. It was gone after a server restart. I found no rule in `serveEvents` that drops a tab that is no longer there other than the socket closing.
- While tidying up, one `pkill -n -f scenes-server/server.mjs` of mine ran when the owner's scenes server was also running. The owner's server on port 3101 was restarted by `npm start` at 22:31 (new pid), so I may have caused that restart (or something else did); the owner's tab may have shown a short reconnect. I did not use pattern kills afterwards (only the pids of my own processes).
- `logs/a2.log`'s B52 failure lines belong to the stray tab above, not to the code (`a3.mjs`/`b52.mjs` cover B52).

## Environment restored (second pass)

My Vite (3201), scenes server (3199), Wrangler (8790) and workerd stopped by pid; `online/.dev.vars` restored from `dev.vars.mine` (diff clean), `npm run build:online` and `cd online && node build-worker.mjs` run again, lock released. No product code, spec (except this file) or repo test changed, no commit, push or deploy. The working tree also shows other agents' changes (`online/pages/privacy.html`, `online/worker/account.ts`, `auth.ts`, `sceneRoutes.ts`, `scenes-plugin/test/signOutEverywhere.test.ts`, two specs): not mine.
