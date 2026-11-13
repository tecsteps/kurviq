# Code review: Browser: Drive client and online UI

Status: done (2026-11-13: all 32 findings fixed, B33 before; see each finding's Status)

Findings of the code review of 2026-11-13 (see `2026-11-13-code-review.md`) in the area **Browser: Drive client and online UI**, still open after the triage against the two specs of the same day. 32 findings: 0 high, 4 medium, 28 low. Ids as in the review (B bug, S smell, D dead code, U duplication, O over-engineering). A finding that is fixed gets a line "- **Status**: fixed in <commit>".

## Potential bugs

### B31. "Copy link" / "Copy prompt" do nothing on a non-secure origin and leave an unhandled rejection
- **Area**: Browser: Drive client and online UI
- **Severity**: medium
- **Confidence**: likely (the local install is documented as `http://draw.test`; not run)
- **Location**: `scenes-plugin/src/online/ui.tsx:598-604`, `1609-1614`
- **Description**: `navigator.clipboard.writeText(...).then(...)` has no guard and no catch. On a plain-http origin (the local install; `liveProblem` already has an "insecure-context" message for it) `navigator.clipboard` is undefined, so the click throws a TypeError and the button gives no feedback. On https a refused write (document not focused, permission denied) is an unhandled rejection, again without feedback. `comments/ui.tsx:408`, `541` already use `navigator.clipboard?.writeText(...).catch(...)`.
- **Suggested fix**: one `copyText()` helper (clipboard API, fallback `document.execCommand("copy")` or showing the link selected), used by `CopyLink`, `CopyButton` and the comments UI; show "Could not copy" on failure.
- **Status**: fixed 2026-11-13: CopyLink and CopyButton use the shared `useCopy()` (src/useCopy.ts: never throws); a refused or missing clipboard shows "Could not copy" (✗ on the icon button) instead of an unhandled rejection.

### B32. "Shared with me" reads only the first 200 files (Astra F17)
- **Area**: Browser: Drive client and online UI
- **Severity**: medium
- **Confidence**: confirmed (found by the Astra review; traced in code by me; not tried against Google)
- **Location**: `scenes-plugin/src/online/drive.ts:1449-1464` (`sharedWithMe`); users `:1612-1632` (`sceneElsewhere`), `scenes-plugin/src/online/ui.tsx:1227-1240`
- **Description**: The query asks for `pageSize=200`, does not ask for `nextPageToken` and makes one request, unlike the folder listing and the revision listing, which follow the pages. With more than 200 shared scene files the later ones are not found by name: a scene link then offers to create a new scene instead of opening the shared one, and the picker follow-up cannot find the picked file's name.
- **Suggested fix**: Follow `nextPageToken` as `fetchFolderScenes` does.
- **Status**: fixed 2026-11-13: `sharedWithMe` reads every page through `listAll` (nextPageToken), like the folder listings; a refusal still answers an empty list, offline still throws.

### B33. The public viewer keeps the old background when the scene's background changes (Astra F06)
- **Area**: Browser: Drive client and online UI
- **Severity**: medium
- **Confidence**: confirmed (found by the Astra review; traced in code by me)
- **Location**: `scenes-plugin/src/publicScene.tsx:327-332`, `:485`
- **Description**: The poll parses the new version (including `background`) and updates elements and files with `updateScene`, but `viewBackgroundColor` is passed only in `initialData` when the viewer mounts. After the author switches a scene from a light to a dark background, a viewer that stays open shows the new (light) text and shapes on the old background.
- **Suggested fix**: Pass `appState: { viewBackgroundColor: next.background }` in the same `updateScene`.
- **Status**: fixed before 2026-11-13 (with the viewer reading Drive directly): the poll's `updateScene` passes `appState.viewBackgroundColor` (publicScene.tsx); nothing left to do.

### B80. The part receiver discards a message that takes longer than 120 s to arrive
- **Area**: Browser: live sync
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/online/frames.ts:60-65`, `:69`
- **Description**: `entry.at` is set when the first part arrives and never refreshed. The clean-up loop runs on every part, also for parts of the same message, so once 120 s have passed since the first part, the next part deletes its own entry and starts a new one that can never complete. A 30 MB welcome state on a slow downlink (below about 2 Mbit/s) is lost this way, and the tab then waits in `handshake` (see the liveness finding). The same code runs in the Worker for incoming batches.
- **Suggested fix**: Refresh `entry.at` on every part, or skip the entry of the part being handled in the clean-up.
- **Update 2026-11-13 (specs)**: Moved here from the live sync area: `frames.ts` stays if the relay sends large "catch me up" messages in parts; then this fix is needed there.
- **Status**: fixed 2026-11-13: an entry's time is refreshed on every part and the clean-up skips the message being received, so only messages that stopped arriving for 2 minutes are dropped (test: driveClient.test.ts).

### B88. A person who may comment on the scene but only view the folder is shown as "Whole folder" and can't be changed
- **Area**: Browser: Drive client and online UI
- **Severity**: low
- **Confidence**: confirmed (traced in code; `test/sharePanel.test.ts:42` pins the rank)
- **Location**: `scenes-plugin/src/online/folderAccess.ts:14-25`, `59-61`; `scenes-plugin/src/online/ui.tsx:1106-1108`, `1122-1139`
- **Description**: `roleRank` gives `commenter` and `reader` the same rank. Folder shared with X as reader, scene shared with X as commenter (the select offers "Can comment", and commenting is a real permission since the comments feature): `rowAccess` returns `{ kind: "folder" }` because `1 >= 1`, the row becomes `fixed` (no select, note "Whole folder"), so the owner can neither lower nor see that this is the scene's own grant.
- **Suggested fix**: rank `commenter` between reader and writer (reader 1, commenter 2, writer 3, owner 4) and adjust `folderAudience`'s "editors" test and the unit test.
- **Status**: fixed 2026-11-13: `roleRank` is reader 1, commenter 2, writer 3, owner 4; `folderAudience` counts editors from rank 3; a scene's commenter in a folder shared to view is "This scene; can view the whole folder" with its own select (sharePanel.test.ts).

### B89. Kept versions of deleted scenes are never removed from IndexedDB
- **Area**: Browser: Drive client and online UI
- **Severity**: low
- **Confidence**: confirmed (no other reader or writer of the two stores in the repo)
- **Location**: `scenes-plugin/src/online/drive.ts:606-619`
- **Description**: `keepVersion` keeps up to 4 full scene JSONs (embedded images included) per Drive file id in `kurviq-drive-versions`, pruned only when the same file gets a 5th version. For a file that is deleted, trashed, or a shared scene the user never opens again, the copies stay for good; the stores are also not per account. A user who creates and deletes image-heavy scenes fills the origin's quota with data nothing can reach, which is the quota the scenes themselves need.
- **Suggested fix**: delete a file's entries in `remove` / `trashFile`, and prune index entries whose file id is not in the current listing (own folder) once per session.
- **Status**: fixed 2026-11-13: `remove` and `trashFile` delete a file's kept versions; the index notes when a file was last read or written, and once per tab the versions of files unused for 90 days go (older index entries get today's time first, so nothing in use is dropped).

### B90. Short-link availability check: an older answer arriving last leaves the dialog on "Checking…"
- **Area**: Browser: Drive client and online UI
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/online/ui.tsx:730-742`, `756-757`
- **Description**: the effect's cleanup clears the timer but not a request already sent. Typing "abc" then "abcd": if the answer for "abcd" arrives before the one for "abc", `check` ends as `{ name: "abc", … }`; `state` for the wanted name is null, the status shows "Checking…" and Save stays disabled until the user types again.
- **Suggested fix**: a `cancelled` flag in the effect (set in cleanup) so only the latest request sets `check`.
- **Status**: fixed 2026-11-13: the check effect has a `current` flag cleared in its cleanup: only the answer for the name typed last sets the state.

### B91. Share and short-link dialogs close when a text selection ends outside the dialog
- **Area**: Browser: Drive client and online UI
- **Severity**: low
- **Confidence**: likely (standard click-target behaviour; not run)
- **Location**: `scenes-plugin/src/online/ui.tsx:781`, `1080` (compare `1634`, `1764`)
- **Description**: these two overlays close on `onClick` with `event.target === event.currentTarget`. A click's target is the common ancestor of mousedown and mouseup, so selecting the short name in the input and releasing the mouse over the backdrop closes the dialog and drops the typed name. The MCP and feedback dialogs use `onPointerDown`, which doesn't have this problem.
- **Suggested fix**: use `onPointerDown` in all four (or one shared overlay component).
- **Status**: fixed 2026-11-13: the share and short-link overlays close on `onPointerDown` on the backdrop, like the MCP and feedback dialogs.

### B92. A sign-in check error stays on screen after the check succeeded as "signed out", and is hidden while it matters
- **Area**: Browser: Drive client and online UI
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/online/drive.ts:203-207`, `222-227`, `234-236`, `256-262`; `scenes-plugin/src/online/ui.tsx:457-459`, `470`, `486`
- **Description**: `checkConnection` stores `error` on failure; only the "signed in, user or drive changed" path clears it. Page opened offline by a signed-out user: `error = "Kurviq server not reachable"`, `user` stays `undefined`, so the panel says "Checking Google sign-in…" (the error is not shown in that branch). Back online the next check answers `connected: false` and sets `{ user: null, drive: false }` without `error: null`: the signed-out panel now shows the red "Kurviq server not reachable" until reload.
- **Suggested fix**: set `error: null` in every successful answer of `requestToken` (both `connected: false` paths and the unchanged-user path), and show the error in the `user === undefined` branch.
- **Status**: fixed 2026-11-13: every successful token answer clears `error` (signed out, and an unchanged user), and the "Checking Google sign-in…" card shows the error.

### B93. `switchOwnSpace` latches `switching` for good if leaving the scene fails
- **Area**: Browser: Drive client and online UI
- **Severity**: low
- **Confidence**: confirmed (traced in code; that `leaveForReload` can reject, e.g. IndexedDB quota in `stashCurrent`, is likely)
- **Location**: `scenes-plugin/src/online/ui.tsx:174-181`
- **Description**: `switching = true` is set before `await scenesController.leaveForReload()`, which is outside the try. If it rejects, the tab never reloads into the account's space, `setSignedIn(false)` was already called (`ui.tsx:278`), and every later attempt returns at `if (switching)`. The tab shows another account's scenes, not syncing, until a manual reload.
- **Suggested fix**: wrap the body in try/finally that resets `switching` when no navigation happened.
- **Status**: fixed 2026-11-13: `switchOwnSpace` resets `switching` when leaving the scene or moving the scenes fails (the work moved to `moveToSpace`), so a later sign-in can try again.

### B94. Malformed agent requests are answered with 500
- **Area**: Browser: Drive client and online UI
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/online/tabServer.ts:67-68`, `110`, `174`, `190-196`
- **Description**: `decodeURIComponent` on a path like `/api/scenes/%E0%A4%A` throws URIError, and `const { to } = parseRequestBody(body)` throws TypeError for the body `null`; both have no `status`, so `serveRequest` answers 500 "URI malformed" / "Cannot destructure…" instead of 400. An agent reads a 500 as "server broken, retry". Also `renameScene` echoes the untrimmed `to` while renaming to the trimmed one (`71-76`).
- **Suggested fix**: a `sceneNameOf(match)` helper that throws `{status: 400}`; check `typeof parsed === "object" && parsed`; return the trimmed name.
- **Status**: fixed 2026-11-13: one `sceneNameOf` (a malformed escape is 400) for the three routes and `renameTarget` (a body that is not a JSON object is 400); the rename answers the trimmed name (tabServerNames.test.ts).

### B95. In a shared scene, any 403 / 404 on save is reported as "its owner changed the sharing" and makes the scene read-only
- **Area**: Browser: Drive client and online UI
- **Severity**: low
- **Confidence**: confirmed in code; that Drive answers 403 `storageQuotaExceeded` to an editor when the owner's Drive is full is from Drive's documentation, not tested
- **Location**: `scenes-plugin/src/online/drive.ts:1045-1051`
- **Description**: the branch doesn't look at the reason. A full Drive of the owner (403 `storageQuotaExceeded`) sets `readOnly = "you can't change this scene any more (its owner changed the sharing)"`, which the editor then shows as the reason; it is wrong and hides the real cause. The inner `fail(...)` in that branch is also redundant (the next `if` does the same).
- **Suggested fix**: only treat 404 and 403 with reason `insufficientFilePermissions` / `forbidden` as lost access; let the others go to `fail` with Drive's message.
- **Status**: fixed 2026-11-13: only 404 and 403 `insufficientFilePermissions` / `forbidden` count as lost access (read only); others (e.g. the owner's Drive full) go to `fail` with Drive's message; the redundant inner `fail` is gone.

### B96. "Find it in Drive…" silently ignores a selection of several files
- **Area**: Browser: Drive client and online UI
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/online/ui.tsx:1204-1208`; `scenes-plugin/src/online/drive.ts:1794-1796`
- **Description**: `pickFiles({ shared: true })` always enables multi-select; `findShared` returns without a word when `ids.length !== 1`. The user ticks two scenes, clicks Select, the hint is gone and nothing happens (the files were granted, but nothing opens).
- **Suggested fix**: open the first picked file whose name matches (else the first), or give `pickFiles` a `multiple` option and leave it off here.
- **Status**: fixed 2026-11-13: `pickFiles` has a `single` option (no multi-select); "Find it in Drive…" uses it.

### B97. The byline is cut at 80 characters, Drive's limit is 124 bytes
- **Area**: Browser: Drive client and online UI
- **Severity**: low
- **Confidence**: likely (Drive's documented limit for a property is 124 bytes of key + value in UTF-8; not tested)
- **Location**: `scenes-plugin/src/online/drive.ts:1339-1343`
- **Description**: `name.slice(0, 80)` counts UTF-16 units. With the 8-byte key `kurviqBy`, a name of 39 or more CJK characters (3 bytes each) or 59 or more Cyrillic ones exceeds the limit and Drive refuses the PATCH: "Could not change who is named on the public page". The slice can also cut a surrogate pair in half.
- **Suggested fix**: cut by encoded bytes (at most 116) on a code point boundary.
- **Status**: fixed 2026-11-13: the byline is cut to 116 bytes of UTF-8 on a code point boundary (`cutBytes` in the new online/driveNames.ts, shared with the Worker's public metadata; driveClient.test.ts).

## Code smells

### S4. Five hand-built modal dialogs without focus handling; `NOSONAR S6819` silences the finding that would have fixed it
- **Area**: Browser: Drive client and online UI
- **Severity**: medium
- **Confidence**: confirmed for the code; the effect on the editor is likely (Excalidraw is mounted with `handleKeyboardGlobally`, so its keydown handler is on `document`)
- **Location**: `scenes-plugin/src/online/ui.tsx:781-782`, `1080-1081`, `1580-1581`, `1634-1635`, `1764-1765`; Escape effects at `744-754`, `1036-1040`, `1519-1526`, `1627-1631`, `1736-1740`
- **Description**: each dialog is a `div role="dialog" aria-modal="true"` with `NOSONAR S6819: existing layout … must stay unchanged`. None moves focus into the dialog, traps it, or gives it back on close, so `aria-modal` is not true: focus stays on the page behind. Only the feedback dialog stops key events (`onKeyDown stopPropagation`); with the share, setup or MCP dialog open and focus on a button, keys still reach Excalidraw's document handler (Backspace / Delete deletes the selection, letters switch tools, arrows move elements) behind the backdrop. The comments UI was already moved to `<dialog>` (commit 1692b09). The five copies also differ in how they close (see the click / pointerdown bug).
- **Suggested fix**: one `Modal` component (a `<dialog>` with `showModal()`, or the div plus focus trap, Escape, backdrop pointerdown, key isolation) used by all five; drop the NOSONARs.
- **Status**: fixed 2026-11-13: the share, short-link, setup, MCP and feedback dialogs are `<dialog open>` elements with the shared `useDialogFocus` (focus in, Tab trapped, Escape, focus back); the hook now also keeps keys typed in a dialog away from the editor's document shortcuts, gives the keys to the topmost of nested dialogs (short link over share) and reads the latest onClose; the NOSONAR S6819 / S6847 / S6848 comments are gone.

### S26. Opening the MCP dialog writes the pairing key during render
- **Area**: Browser: Drive client and online UI
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/online/ui.tsx:1623`; `scenes-plugin/src/online/pairing.ts:26-36`, `55-60`
- **Description**: `usePairingKey() ?? pairing.ensureKey();` runs in the render body. `ensureKey` writes localStorage and notifies the store's listeners, among them `McpButton`, while `McpDialog` renders (React: "Cannot update a component while rendering a different component"; it runs twice in StrictMode). It also means that only looking at the dialog turns agent access on in this browser, which the tooltip then reports.
- **Suggested fix**: create the key in `McpButton`'s click handler (or in an effect) before opening the dialog.
- **Status**: fixed 2026-11-13: the MCP button creates the key in its click handler before opening the dialog; the dialog only reads it.

### S27. Every save drops the cached folder id, and every load / save lists the whole folder
- **Area**: Browser: Drive client and online UI
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/online/drive.ts:653-656`, `675-682`, `708-719`, `826`, `1056`, `1089`, `1125`, `1296`
- **Description**: `forgetListing()` is the sign-out reset and also the "listing is stale" reset after save, remove, rename and `setLinkAccess`; it sets `folderRequest = null` too. So after each save the next listing takes the cross-tab lock and asks Drive for the folder again (`/files/<id>?fields=id,trashed`). `locate()` defaults to `force = true`, so `load` and `save` each list the complete folder (one request per 1000 files) to find one file; syncing N scenes costs about 3N Drive requests where N + 1 would do, against the per-user rate limit that `checkDriveResponse` then reports as "offline".
- **Suggested fix**: split `forgetListing` (listing only) from the sign-out reset; for a known file id, refresh that one file (`files.get`) instead of the folder.
- **Status**: fixed 2026-11-13: `forgetListing` only drops the listing (the folder id stays until sign-out); save, rename and delete update the listing in place; `locate` asks Drive for a known file alone (files.get) and lists the folder only for an unknown or renamed one.

### S28. The MD5 that versions everything has no test, and is computed where it is not used
- **Area**: Browser: Drive client and online UI
- **Severity**: low
- **Confidence**: confirmed (`md5.ts` is imported only by `drive.ts`; no test imports it)
- **Location**: `scenes-plugin/src/online/md5.ts:1-61`; `scenes-plugin/src/online/drive.ts:1008-1017`
- **Description**: the implementation is needed, but a mistake in it (e.g. for inputs of 56-63 bytes mod 64, or above 512 MB) would make every loaded scene report a version Drive doesn't have, i.e. permanent conflicts; the project rule is "new logic comes with unit tests". In `save`, `md5(encodeBytes(json))` (a synchronous pass over the whole scene, images included, on the main thread) runs before the live-scene branch, which returns without using it.
- **Suggested fix**: a test with the RFC 1321 vectors plus lengths 55, 56, 63, 64, 65 and a multi-byte string; move the checksum below the `isLiveFile` branch.
- **Status**: fixed 2026-11-13: md5 tests with the RFC 1321 vectors, lengths 55 to 128 and multi-byte text against Node's MD5 (driveClient.test.ts); the second half is gone with the live-scene branch (the checksum is used right after it is computed).

### S29. `folderUrl()` reads `drive.ts`'s private localStorage key and ignores `driveWebLink`
- **Area**: Browser: Drive client and online UI
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/online/ui.tsx:307-314`, `535-544`, `1559`; `scenes-plugin/src/online/drive.ts:667`, `1579-1583`
- **Description**: the UI rebuilds the key `kurviq-drive-folder:<email>` by hand (hidden coupling: renaming it in `drive.ts` silently turns the link into "My Drive"). The link has no `authuser`, although `driveWebLink(id, true)` exists for exactly the reason given in its comment (the browser's first Google account may be another one). In a shared folder's tab the card links to the user's own folder under the name "Kurviq" while the scenes shown are someone else's.
- **Suggested fix**: export an `ownFolderLink()` from `drive.ts` built on `driveWebLink`; in a folder space link `sharedFolderId`.
- **Status**: fixed 2026-11-13: `ownFolderLink()` in drive.ts (built on `driveWebLink`, with authuser; a shared folder's tab links that folder); the UI no longer reads drive.ts's localStorage key.

### S30. Shapes left behind by lint-driven refactors
- **Area**: Browser: Drive client and online UI
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `scenes-plugin/src/online/drive.ts:443-460`, `844-850`, `1244-1257`; `scenes-plugin/src/online/ui.tsx:644`
- **Description**: `linkAccessOf` defines an inner function that reads `anyone` before the `const anyone` below it and is called once on the next line; `drive()` declares two inner helpers that take the `isJson` flag computed later in the loop; `download` assigns to `res` only to return it; `closeShareDialog` passes `null as unknown as string` to a function typed `(name: string)`. Each hides a three-line piece of logic behind indirection a reader has to undo.
- **Suggested fix**: `const role = anyone?.role; return !anyone ? "restricted" : role === "writer" || role === "commenter" ? role : "reader"` written as early returns; compute `isJson` once before the loop; type the share store as `string | null`.
- **Status**: fixed 2026-11-13: `linkAccessOf` is plain early returns (now in shareAccess.ts), `drive()` computes the body type once before its loop, `download` returns the call, the share store is `string | null` (`createStore`).

## Dead code

### D15. `driveScenes.fileOf` and the fields only it reads
- **Area**: Browser: Drive client and online UI
- **Severity**: low
- **Confidence**: confirmed (no caller in scenes-plugin, online, scenes-mcp, scenes-server, tests)
- **Location**: `scenes-plugin/src/online/drive.ts:1209-1213`, `44` (`capabilities(…canShare)`, `ownedByMe`), `640`, `643`
- **Description**: nothing calls `fileOf`; `canShare` and `ownedByMe` are requested from Drive with every listing and read nowhere else. The share dialog therefore never checks `canShare` and shows Drive's raw 403 text to someone who may not share.
- **Suggested fix**: delete it and the two fields, or use it in `ShareDialog` to say "only the owner can share this scene".
- **Status**: fixed 2026-11-13: `fileOf` is used by the share dialog: someone who may not share sees who decides and the link (no Drive 403); `ownedByMe` is no longer requested.

### D16. Exports nobody imports
- **Area**: Browser: Drive client and online UI
- **Severity**: low
- **Confidence**: confirmed (repo-wide search, upstream and node_modules excluded)
- **Location**: `scenes-plugin/src/online/drive.ts:38` (`API`), `40` (`SCENE_MIME`), `51` (`fileSpace`), `60` (`folderSpace`), `241` (`getToken`), `393` (`notConnectedError`), `930` (`isLiveFile`), types at `105`, `932`, `1516`, `1639`; `scenes-plugin/src/online/ui.tsx:72` (`GoogleIcon`), `219` (`leaveSharedScene`); `scenes-plugin/src/online/pubName.ts:6` (`PUB_MIN`); `scenes-plugin/src/online/folderAccess.ts:14` (`roleRank`, test-only outside its file)
- **Description**: all are used only inside their own file. `PUB_MIN` is exported "shared by the app and the Worker" but the dialog writes the literal `{3}` (`ui.tsx:828`), so the rule text and the rule can drift.
- **Suggested fix**: drop the `export`s; use `PUB_MIN` in the dialog text.
- **Status**: fixed 2026-11-13: no longer exported: `fileSpace`, `folderSpace`, `ConnectionState`, `Role`, `PickOptions`, `SharedScene`, `SharedFolderScene` (deleted), `GoogleIcon`, `leaveSharedScene`; the dialog uses `PUB_MIN`. Kept: `API`, `SCENE_MIME`, `getToken`, `notConnectedError` (now imported by online/driveNew.ts), `roleRank` (its unit test); `isLiveFile` was already gone.

### D17. Props and parameters that are never read
- **Area**: Browser: Drive client and online UI
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `scenes-plugin/src/online/ui.tsx:1184` (prop `disabled`, passed at `scenes-plugin/src/index.tsx:1627`), `614-623` (`what`, and `item` typed `| undefined`)
- **Description**: `SceneSharing` declares `disabled` in its props type and ignores it, so `disabled={isBusy}` at the call site does nothing. `notShareable` has one caller, which always passes a defined item and `"scene"`.
- **Suggested fix**: remove the prop (or honour it), inline the word, drop the `!item` branch.
- **Status**: fixed 2026-11-13: `SceneSharing` has no `disabled` prop (index.tsx no longer passes it); `notShareable` became `isShareable(item)` without the word and the impossible branch.

### D18. SCSS rules that match nothing
- **Area**: Browser: Drive client and online UI
- **Severity**: low
- **Confidence**: confirmed (searched all .ts / .tsx, vite.config.mts, Worker pages)
- **Location**: `scenes-plugin/src/online/online.scss:420-422`, `771-773`
- **Description**: `.kq-dialog a.scenes-btn` (no anchor carries `scenes-btn` anywhere) and `.kq-share__folder p` (the element with that class is itself the `<p>`, `ui.tsx:950`, `961`; it has no paragraph inside). The file's first line says "online build" but it also carries the font dialog's styles (`443-486`, used by `src/fontsUI.tsx`).
- **Suggested fix**: delete the two rules; move the font dialog's block next to `fontsUI.tsx`.
- **Status**: fixed 2026-11-13: both dead rules deleted; the font dialog's styles moved to src/fonts.scss (imported by fontsUI.tsx); the file's first line says what it styles.

### D19. Comments that describe something else
- **Area**: Browser: Drive client and online UI
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `scenes-plugin/src/online/ui.tsx:352-353`, `1713-1714`; `scenes-plugin/src/online/drive.ts:785`, `1276`
- **Description**: "the welcome screen's text (injected …)" sits above the font registration; "bottom right of the canvas" is stacked on `KurviqSocials` (it belongs to `KurviqLegalLinks`); `fetchFolderSpace` says a shared folder is "read-only for now" while the next lines make it writable for the `writer` role; `setLinkAccess` says "off, can view, or can edit" but also sets "can comment".
- **Suggested fix**: move or correct the four comments.
- **Status**: fixed 2026-11-13: the welcome-screen and "bottom right" comments sit on the right code, `setLinkAccess`'s comment names every option; the folder-space comment no longer exists.

## Duplications

### U20. The "name to slug" pipeline exists three times
- **Area**: Browser: Drive client and online UI
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `scenes-plugin/src/online/drive.ts:1299-1313` (`trimHyphens` + `slug`), `scenes-plugin/src/online/pubName.ts:37-45` (`toPubName`), `scenes-plugin/src/online/ui.tsx:810-818` (the input's `onChange`)
- **Description**: NFKD, strip combining marks, lowercase, non-alphanumerics to hyphens, trim, cut: the same steps with small differences (60 or 40 characters, leading / trailing hyphens). A fix in one (e.g. for "ß" or "ø", which all three turn into a hyphen) won't reach the others.
- **Suggested fix**: one `slugify(text, max, { keepTrailingHyphen })` in `pubName.ts`, used by all three.
- **Status**: fixed 2026-11-13: one `slugify(text, max, { keepTrailingHyphen })` in pubName.ts for scene links, short names and the short-name field; it also folds ß, ø, æ, œ, ł, đ, þ (driveClient.test.ts).

### U21. Two copy-to-clipboard buttons, a third way in the comments UI
- **Area**: Browser: Drive client and online UI
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `scenes-plugin/src/online/ui.tsx:577-611` (`CopyLink`), `1603-1619` (`CopyButton`); `scenes-plugin/src/comments/ui.tsx:408`, `541`
- **Description**: the same "write, show Copied for 1.5 s" logic twice with the same missing error handling (see the bug), and a safer variant elsewhere.
- **Suggested fix**: one `useCopy()` hook returning `[copied, copy]`.
- **Status**: fixed 2026-11-13: both buttons use `useCopy()` from src/useCopy.ts (the comments UI's agent made it the shared one).

### U22. Constants shared with the Worker are copied instead of imported
- **Area**: Browser: Drive client and online UI
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `scenes-plugin/src/online/drive.ts:40` and `online/worker/shared.ts:30`, `online/worker/folderRules.ts:217`, `online/worker/driveApi.ts:187` (scene MIME type); `drive.ts:1327`, `1342` and `online/worker/shared.ts:38`, `66` (`kurviqBy`, 80 characters); `drive.ts:685`, `695` and `online/worker/folders.ts:274` (`kurviqRoot`); `drive.ts:667` and `ui.tsx:311` (folder key)
- **Description**: the wire contract between app and Worker (property names, MIME type, limits) is spelled out in each place. `pubName.ts` shows the pattern that avoids it (one module imported by both sides).
- **Suggested fix**: a small shared constants module (like `scenes-mcp/sceneName.mjs`) for the Drive property names, MIME type and limits.
- **Update 2026-11-13 (specs)**: Only the constants the Worker still needs (`driveApi.ts`, the shared page in `shared.ts`, `pubLinks.ts`).
- **Status**: fixed 2026-11-13: online/driveNames.ts (SCENE_MIME, the byline property, its byte limit, cutBytes, cleanByline) is imported by drive.ts, the Worker's shared.ts and driveApi.ts; the folder key is no longer rebuilt in the UI.

### U23. The signed request to Kurviq's server is built three times
- **Area**: Browser: Drive client and online UI
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `scenes-plugin/src/online/drive.ts:201-214` (`requestToken`), `320-327` (`disconnectGoogle`), `343-355` (`authPost`); also `193-199` vs `329-333`
- **Description**: "local install: session in the JSON body and `credentials: omit`, else the cookie" is repeated, and `disconnectGoogle` removes the local session by hand next to `clearLocalSession()`. A change of how the local install authenticates has to be made in three places.
- **Suggested fix**: one `authFetch(path, body)` used by all three; call `clearLocalSession()` in `disconnectGoogle`.
- **Status**: fixed 2026-11-13: one `authFetch(path, body)` (cookie, or the local session in the JSON body) for the token, logout and `authPost`; `disconnectGoogle` uses `clearLocalSession()`.

### U24. Seven hand-written external stores and five Escape effects
- **Area**: Browser: Drive client and online UI
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `scenes-plugin/src/online/drive.ts:118-124`, `137-144`, `1357-1373`; `scenes-plugin/src/online/ui.tsx:112-127`, `638-659`; `scenes-plugin/src/online/linkHint.ts:9-24`; `scenes-plugin/src/online/pairing.ts:9`, `46-53`; `scenes-plugin/src/publicScene.tsx:49-67`; Escape effects listed in the dialog smell
- **Description**: `let value; const listeners = new Set(); set → forEach; subscribe → add / delete` is written out seven times, the "Escape closes" effect five times.
- **Suggested fix**: a ten-line `createValueStore<T>(initial)` (`get`, `set`, `subscribe`) and a `useEscape(onClose)` hook.
- **Status**: fixed 2026-11-13: the connection, short names, link hint, pairing key, public viewer, setup and share stores use src/externalStore.ts `createStore` (their public get / subscribe kept); the five Escape effects are gone (`useDialogFocus`).

### U25. Repeated rule blocks in online.scss
- **Area**: Browser: Drive client and online UI
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `scenes-plugin/src/online/online.scss:509-520` and `633-644` (button that looks like a link); `425-440`, `489-506`, `568-591` (fixed, centred island banner)
- **Description**: `.kq-legal__feedback` and `.kq-share__textbtn` are the same reset (and `scenes-link` already exists for this); `.kq-readonly`, `.kq-update` and `.kq-live__item` repeat position, transform, island background, shadow, radius and colour with different offsets.
- **Suggested fix**: use `scenes-link` for both buttons; a shared `%kq-banner` placeholder (or mixin) for the three banners.
- **Status**: fixed 2026-11-13: `%kq-text-button` (the two link-like buttons) and `%kq-banner` (read-only note and update banner; the live banner is gone) placeholders in online.scss.

## Over-engineering

### O10. A generic gapi module loader for one module
- **Area**: Browser: Drive client and online UI
- **Severity**: low
- **Confidence**: confirmed (`loadGapi` has one caller, `loadPicker`, which has one caller)
- **Location**: `scenes-plugin/src/online/drive.ts:1726-1756`
- **Description**: a script promise, a `Map` of module promises with eviction on failure, and a `what` parameter for the message, to load exactly `"picker"`.
- **Suggested fix**: one `let picker: Promise<void> | null` that loads the script and then `gapi.load("picker")`, reset on failure.
- **Status**: fixed 2026-11-13: one `picker` promise loads api.js and `gapi.load("picker")`, reset on failure.

