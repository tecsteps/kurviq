# Code review: Browser: controller, storage, router, merge

Status: done 2026-11-13 (all 29 findings have a Status line: 24 fixed, 1 partly by design, 4 superseded)

Findings of the code review of 2026-11-13 (see `2026-11-13-code-review.md`) in the area **Browser: controller, storage, router, merge**, still open after the triage against the two specs of the same day. 29 findings: 0 high, 8 medium, 21 low. Ids as in the review (B bug, S smell, D dead code, U duplication, O over-engineering). A finding that is fixed gets a line "- **Status**: fixed in <commit>".

## Potential bugs

### B34. Opening a scene is not serialized with sync: a pull or merge of the scene being left is applied after it was stashed
- **Area**: Browser: controller, storage, router, merge
- **Severity**: medium
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/controller.ts:1642-1664` (`open` runs on `openChain`, not `exclusive`), `1785-1800` (`openInner`: stash, then await the load, then apply), `2388-2413` (`pullScene`), `1592-1615` (`setBaselineFromCanvas`, `writeLocal`), `2321-2337` (`recordPushedScene`), `1705-1721` (`checkOpenedScene`)
- **Description**: `openInner` stashes scene A first (`stashCurrent`), then awaits `loadOpeningScene(B)`. For a scene never downloaded this is a Drive download of up to seconds. During that time A is still `meta.current` and still on the canvas. Sync steps check `name === this.meta.current` only before their own awaits.
  1. Stale copy taken for the latest version: a `pullScene(A)` whose download returns in that window sees A as current and clean, applies Drive's version to the canvas and sets `meta.scenes[A].baseMd5 = latest.md5`. Then the open finishes and replaces the canvas with B. A's snapshot is the old content (stashed before the pull, `dirty: false`), but its base says "latest". Reopening A shows the old content, and `checkOpenedScene` finds `latest.md5 === meta.baseMd5` and leaves it. The next edit pushes old content plus the edit with a matching base, so Drive accepts it and the collaborator's changes are overwritten without a merge.
  2. Same window with `mergeScene(A, { pushAfter: true })`: the merged version is pushed, then `recordPushedScene` finds the open moved on, compares the pre-merge snapshot with the pushed JSON, takes the difference for "edited while the push was on its way" and marks it dirty on the new base. The next sync pushes the pre-merge version and removes what Drive's side added.
  3. `setBaselineFromCanvas` awaits 50 ms (`nextFrame`) and then writes `this.meta.baseline` from whatever the canvas shows. If the open switched to B in between (B opened from a dirty snapshot), B's baseline becomes its own canvas and B's unpushed changes count as clean. A later "behind" pull then replaces them.
  4. Edits made on A while B downloads are after the stash and are dropped when B is applied (`onSceneChange` only ignores changes while `busy === "loading"`; I did not check whether the UI blocks input meanwhile).
  5. `openInner` running inside `exclusive` (`remove`, `clone`) can interleave with a user `open` on `openChain`; `setState({ current: name })` after the awaits can then leave `state.current` different from `meta.current`.
- **Suggested fix**: Load the target first and stash immediately before `applyScene` (no network await between stash and switch). Mark "switching" so sync steps skip the current scene meanwhile. Re-check `name === this.meta.current` after every await in `writeLocal`, `setBaselineFromCanvas` and `checkOpenedScene`. Run the stash-and-apply part through the same queue as the other operations.
- **When**: together with the database adapter (`2026-11-13-own-database.md`), which rewrites this part of the controller.
- **Status**: fixed 2026-11-13: one queue for everything (`scenes-plugin/src/opQueue.ts`), opening in its priority lane; `openInner` loads the new scene first, then stashes the open one (after `recomputeDirty`, so edits made while loading count) and shows the new one with no await between; `setBaselineFromCanvas(name)` and `writeLocal` re-check the open scene after their awaits; the background check of a just-opened copy applies through the queue. Tests: `controllerQueue.test.ts` (pull during a slow open, edits during the download, opens in order).

### B35. `onFocus` / `onStorage` replace `this.meta` while operations hold references to the old scene records: sync results are lost
- **Area**: Browser: controller, storage, router, merge
- **Severity**: medium
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/controller.ts:607-615`, `622-633` (new object from `loadMeta()`); holders across awaits: `2375-2384` + `2307-2316` (`pushScene` → `recordPushedScene`), `2575-2606` and `2491-2504` (merge), `2441-2446`, `2525-2529`, `3089-3094`, `3055-3061`
- **Description**: `pushScene` takes `const meta = this.sceneMeta(name)`, awaits the Drive save, then `recordPushedScene` writes `meta.baseMd5 = result.md5` to that object and calls `persistMeta()`, which saves `this.meta`. If a window `focus` or a `storage` event arrived during the save, `this.meta` is a fresh object, so the new base is written to a detached record and never stored. This is easy to hit: tab 1 pushes when it becomes hidden (`onVisibility`), the user clicks in tab 2 showing another scene (`onInteract` → `persistMeta` writes another `current`) → `storage` event in tab 1 mid-push. A single tab hits it when the user returns to the window while a push is in flight.
  Result: Drive has the pushed version, the local base is the old one. A clean scene shows "behind" and re-downloads its own push (heals). If the user edited meanwhile it is "diverged" and merged against the old base with its own push as "theirs": an element pushed and then deleted comes back (`mineChanged` false → `pick = te`, or "an edit beats a delete" in `newestWins`). In "ask" mode a conflict with oneself is raised.
  The same loss applies to `meta.conflict` set in `mergeScene`, the base set in `applyMergedScene` / `refuseEmptyPush` / `takeTheirs`, and to in-memory changes not yet persisted (`createLocalOnly` sets `meta.scenes[name]` before `await setSnapshot`: a focus in between drops the entry and leaves a snapshot nobody lists).
- **Suggested fix**: Take stored metadata over by mutating the existing records in place, or postpone the takeover until the operation queue is idle. Otherwise look the record up again (`this.sceneMeta(name)`) after each await instead of passing `meta` along.
- **When**: together with the database adapter (`2026-11-13-own-database.md`), which rewrites this part of the controller.
- **Status**: fixed 2026-11-13: operations look their scene's record up again after every await and store a change before the next await (`recordPushedScene`, `handlePushError`, merge, pending ops, `takeTheirs`, `createLocalOnly`, `saveAs`, `adoptEmptyLocalOnly`, `dropScenesDeletedInDrive`; `stashCurrent` stores its change itself); the takeover is one method (`takeOverStored`). Test: `controllerQueue.test.ts` (storage + focus event during a push).

### B36. The three-way merge keeps only my scene settings: Drive's background / grid change is reverted
- **Area**: Browser: controller, storage, router, merge
- **Severity**: medium
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/controller.ts:2473-2482` (`applyMergedScene`)
- **Description**: The merged file is built as `{ ...mine, elements: merged, appState: { ...mine.appState, ...mergePresentation(...) } }`. Elements are merged three-way and the presentation flag by timestamp, but `viewBackgroundColor`, `gridSize`, `gridStep` and `gridModeEnabled` always come from the local side, although the base version is loaded and `viewBackgroundColor` is part of `sceneHash`. Scenario: device 1 changes the background and pushes; device 2 has unpushed element edits → "diverged" → merge → push: the file has the old background again, with no clash and no log line. The live path does this correctly (`liveWriteSettings`, `1336-1365`).
- **Suggested fix**: Merge these settings three-way against `base.appState` (mine if I changed it, else theirs), as `liveWriteSettings` does.
- **Status**: fixed 2026-11-13: `mergeSceneSettings` (`merge.ts`) merges background and grid three-way against the base's appState (mine if I changed it, else Drive's). Tests: `mergeFixes.test.ts`, `controllerFixes.test.ts` (Drive's background change survives a diverged merge). Found by the pen e2e while doing it: a merge that takes nothing of mine (only how the editor wrote the same content differed, e.g. `boundElements: null` / `[]`) pushed a new Drive version; it now takes Drive's version as it is (`nothingOfMine`, test in `controllerFixes.test.ts`).

### B37. Scene names that collide with pages and object properties: `/features`, `/about`, `/constructor`
- **Area**: Browser: controller, storage, router, merge
- **Severity**: medium
- **Confidence**: confirmed for the router logic; likely for the plain pages (I did not verify how the Worker's assets answer `/about`)
- **Location**: `scenes-plugin/src/router.ts:75-93`, `104`, `262-272`, `309-312`; `scenes-plugin/src/publicScene.tsx:35`; `scenes-mcp/sceneName.mjs:5-8` (no reserved names; short links have a list in `online/pubName.ts:10-14`)
- **Description**: A scene's URL is `/<name>` and any name matching `NAME_RE` is accepted.
  1. `isPublicScene` is `name in PUBLIC_SCENES` on a plain object, so `constructor`, `toString`, `valueOf`, `hasOwnProperty` (all valid scene names) count as public scenes, also in the local install where the object is empty. Loading `/constructor` calls `publicScene.show("constructor")` and skips `navigateTo`, so the user's scene never opens from its link, and `PUBLIC_SCENES[name].title` is read from a function.
  2. On kurviq.com a scene named `features` shows Kurviq's feature deck on reload or from a link. Scenes named `about`, `imprint`, `privacy`, `terms`, `contact` get URLs that are Kurviq's plain pages.
  In-app switching works, so the user only notices when sharing or reloading.
- **Suggested fix**: Use `Object.hasOwn(PUBLIC_SCENES, name)`. Add a reserved list to scene naming for the online build (reuse `RESERVED` from `pubName.ts`), or give colliding names a URL the pages cannot take.
- **Also in the Astra review**: F09. It adds: `exists()` (`scenes-plugin/src/controller.ts:1951-1957`) and `sceneMeta()` (`:719-721`) read `this.meta.scenes[name]` on a plain object, so a new scene named `constructor` or `toString` is refused as already existing (checked by me).
- **Status**: fixed 2026-11-13: `isPublicScene` uses `Object.hasOwn`; the stored scene and pending-delete records are prototype-free (`storage.ts` `loadMeta`) and `exists` uses `Object.hasOwn`; online, new scenes can't take the names of Kurviq's pages (`features`, `about`, `imprint`, `privacy`, `terms`, `contact`: `sceneNameProblem` in `controller.ts`). Tests: `storageMigration.test.ts`, `controllerFixes.test.ts`.

### B38. Moving an account's scenes: a failed write of the target's scene list still deletes the source (Astra F01)
- **Area**: Browser: controller, storage, router, merge
- **Severity**: medium
- **Confidence**: confirmed (found by the Astra review, which rates it high; traced in code by me; needs a failing `localStorage` write, e.g. a full storage)
- **Location**: `scenes-plugin/src/storage.ts:223-229` (`saveMeta` swallows the error), `:378-381` (`moveSpaceData`); caller `scenes-plugin/src/online/ui.tsx:185-198`
- **Description**: `moveSpaceData` copies the snapshots, then calls `saveMeta(meta, toKey)` and at once removes the source's scene list and clears its snapshot and agent stores. `saveMeta` catches a storage error and returns normally. If that write fails, the target has snapshots but no scene list naming them, and the source that could have been retried is gone: the scenes are no longer listed anywhere. The caller's own error handling never sees it.
- **Suggested fix**: Use a throwing write for the move and clear the source only after the target's scene list was written; add a test with a failing `setItem`.
- **Status**: fixed 2026-11-13: `moveSpaceData` writes the target's scene list with a throwing write and clears the source only after it. Test: `accountSpaces.test.ts` (a refused `setItem` keeps the source).

### B39. The clean-up of old "features" copies can delete a copy the visitor changed (Astra F02)
- **Area**: Browser: controller, storage, router, merge
- **Severity**: medium
- **Confidence**: confirmed (found by the Astra review, which rates it high; traced in code by me). Only browsers that still hold the `kurviq-public-scenes` record from before 22 Oct 2026 are affected, once: the record is removed after the first run.
- **Location**: `scenes-plugin/src/router.ts:136-161` (`removeOldPublicCopies`)
- **Description**: Whether the visitor changed the seeded copy is decided by a hash over id, rounded position and size, and plain text of each element. A change of colour, rotation, font, formatting, an image, a binding, comments or presentation settings leaves the hash the same, and so does a move of less than half a pixel. Such a changed local-only scene is removed at the next start.
- **Suggested fix**: Do not delete on this evidence: keep the copy (or ask), or compare the complete normalized content.
- **Status**: fixed 2026-11-13: no copy is deleted any more; only the old note (`kurviq-public-scenes`) is removed, with a removal date (31 Jan 2027). Test: `routerCopies.test.ts`.

### B98. Renaming or deleting the open scene pushes a history entry: Back re-creates an empty scene under the old name
- **Area**: Browser: controller, storage, router, merge
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/router.ts:291-301` (every change of `current` → `syncUrl("push")`), `303-319` (popstate → `navigateTo`); `scenes-plugin/src/controller.ts:2848-2854`, `2959-2965`, `1927-1947`
- **Description**: `rename` of the open scene changes `current`, and the router pushes `/<new>` on top of `/<old>`. Browser Back → popstate → `navigateTo(old)` → `openOrCreate`: the old name exists nowhere (404), so an empty scene with the old name is created and the "look among shared scenes" offer appears. The same happens after deleting the open scene (history `/A`, `/`; Back creates an empty "A").
- **Suggested fix**: Replace the history entry for a rename and for the switch after a delete (the controller can say why `current` changed). Consider not creating scenes from `popstate` at all.
- **Status**: fixed 2026-11-13: the controller says how the URL follows a change of the open scene (`state.urlMode`: "replace" for a rename and for the switch after a delete, else "push"); the router uses it. Test: `controllerFixes.test.ts`. Not creating scenes from `popstate` at all was not done (a link opened by Back may name a scene that exists elsewhere).

### B99. Renaming a scene onto a name whose deletion is still pending drops the pending delete
- **Area**: Browser: controller, storage, router, merge
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/controller.ts:2847` (`delete this.meta.pendingDeletes[to]`), compare `1962-1969` (`claimName`), `2655-2668` (`pushPendingRename`)
- **Description**: Offline: delete "Plan" (queued in `pendingDeletes`), then rename "Plan v2" to "Plan" (queued as `renamedFrom`). Line 2847 forgets the queued delete. Back online the old "Plan" is never deleted, `scenesApi.rename("Plan v2", "Plan")` answers "exists" on every sync, `renamedFrom` stays for good and the scene's content is never pushed (`renameReachedDrive`). If the renamed scene was never in Drive, it instead gets status "behind" / "diverged" against the deleted file and pulls or merges the deleted scene's content. `create`, `saveAs` and `clone` handle this through `claimName`; `rename` does not.
- **Suggested fix**: Keep the pending delete (it runs before pending renames in `pushPendingOps`). For a scene not in Drive, take over the deleted version as base as `claimName` does.
- **Status**: fixed 2026-11-13: `rename` keeps a queued delete of the target name: a scene in Drive runs that delete first (offline it stays queued and runs before the queued rename); a scene not in Drive takes the deleted version over as its base, as `claimName` does (`settlePendingDelete`). Tests: `controllerFixes.test.ts` (three cases).

### B100. Copies get names that are not validated or made unique: "(conflict …)", "(local copy)", "(offline changes)"
- **Area**: Browser: controller, storage, router, merge
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/controller.ts:3236-3251` (`keepBoth`), `1286-1300` (`saveLiveCopy`), `1426`; `scenes-plugin/src/online/liveSync.ts:3238`
- **Description**: `keepBoth` writes `"<name> (conflict YYYY-MM-DD HH.MM)"` straight into `meta.scenes` and the snapshot store, without `validateName` or `exists`. For a name longer than 72 characters the copy exceeds 100: it exists locally, but every push fails with "Invalid scene name" (`checkName` in `drive.ts`). Two "keep both" of the same scene within a minute overwrite the first copy. `saveLiveCopy` appends " (local copy)" / " (offline changes)" and " 2" and then `createLocalOnly` validates: for names longer than about 82 characters the copy is refused, so "Keep a local copy" fails and live sync cannot save its offline changes as a copy.
- **Suggested fix**: Build all three names with `freeName` from `spaces.ts` (it truncates to 100 and counts up) after shortening the base.
- **Also in the Astra review**: F07 and F08. They add: two "Keep both" of one scene within the same minute overwrite the first copy (`timestamp()` has minute precision, `controller.ts:3237`, checked by me), and "(local copy)" of a name near 100 characters is refused by `createLocalOnly`.
- **Update 2026-11-13 (specs)**: Only the controller's "(conflict …)" copies remain; `saveLiveCopy` goes with live sync.
- **Status**: fixed 2026-11-13: "Keep both" names its copy with `copyName` (the name shortened so the suffix fits, then `freeName`: "(2)" for a second copy in the same minute); the copy's record goes through `claimName`. "(local copy)" / "(offline changes)" went with live sync (superseded). Tests: `controllerFixes.test.ts`.

### B101. Z-order-only changes are lost in the merge
- **Area**: Browser: controller, storage, router, merge
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-mcp/elementContent.mjs:6` (`index` in `VOLATILE`), `scenes-plugin/src/merge.ts:25`, `58-60`
- **Description**: `sameContent` ignores `index`, so an element I only moved to the front counts as unchanged. In a merge `!mineChanged → pick = te` takes Drive's copy with the old index and the element goes back. `sceneHash` does notice the reorder (array order), so the scene becomes dirty and is pushed normally; the change only disappears when a merge happens. `liveMerge.ts:18` treats order as a change on purpose.
- **Suggested fix**: When content is equal on both sides but `index` differs from the base on one side, keep that side's index.
- **Status**: fixed 2026-11-13: `mergeElements` keeps the z-order of the side that changed it against the base (`keptOrder`, mine when both did). Test: `mergeFixes.test.ts`.

### B102. A failed open leaves the previous scene stashed and detached from live sync
- **Area**: Browser: controller, storage, router, merge
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/controller.ts:1789-1797`
- **Description**: `openInner` releases the lock, stashes and calls `liveSync.detachCanvas()` before `loadOpeningScene`. If the load throws (503 "never downloaded", a Drive error, an invalid name from a URL such as `/foo/bar`), the previous scene stays open but its live connection is gone until the next `applyListing` calls `connectLive()` (up to 60 s; never while offline).
- **Suggested fix**: Detach only once the new content is in hand, or call `connectLive()` in the error path.
- **Update 2026-11-13 (specs)**: Still valid; "detached from live sync" becomes "from the relay". Best fixed with the database adapter.
- **When**: together with the database adapter (`2026-11-13-own-database.md`), which rewrites this part of the controller.
- **Status**: fixed 2026-11-13: the new scene is loaded before anything is stashed or released; a failed load leaves the open scene as it was (the live-sync detach is gone with live sync; the pen follows the open scene by itself). Test: `controllerQueue.test.ts`.

### B103. `updateRemoteMd5` loses `fileId`, `public` and `live` of a renamed scene
- **Area**: Browser: controller, storage, router, merge
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/controller.ts:2722-2735`; callers `2772-2773`, `2647-2648`, `2921-2922`
- **Description**: The new entry is built from `existing`, looked up under the new name. After a rename there is none, so the entry is `{ name, md5, updatedAt: now }`: the file id, the public flag and the live flag of the same Drive file are dropped until the next listing. `fileIdOf(to)` is undefined for a non-live scene, so the list item has no `fileId` / `public` for up to a minute.
- **Suggested fix**: For a rename, map the existing entry (`{ ...old, name: to, md5 }`) as `renameLiveScene` does at `2794-2797`.
- **When**: together with the database adapter (`2026-11-13-own-database.md`), which rewrites this part of the controller.
- **Status**: fixed 2026-11-13: `renameRemote` moves the listing's entry (file id, public flag) to the new name, used by `rename`, the pending rename and `followRemoteRename`. Test: `controllerFixes.test.ts`.

### B104. `keepOnlyHere` leaves a half-done state when Drive's delete fails
- **Area**: Browser: controller, storage, router, merge
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/controller.ts:906-930`
- **Description**: The scene is first made local only and persisted, then `scenesApi.remove` runs outside the queue. If it fails (offline, 403), the error is thrown, but the scene stays local only without `keptLocal`, with its `baseMd5`, and Drive's copy stays. The user asked for "out of Drive" and got "local only, Drive copy kept" plus an error; a retry returns early in `setLocalOnly` and tries the delete again only if the listing still knows the file.
- **Suggested fix**: Delete in Drive first (or revert `localOnly` on failure), inside one `exclusive` step.
- **Status**: fixed 2026-11-13: `keepOnlyHere` runs as one queued step: out of Drive first, then local only; a refused delete changes nothing here (also refused while a rename is pending). Tests: `controllerFixes.test.ts`.

## Code smells

### S5. Two sources of truth for the open scene and two operation queues
- **Area**: Browser: controller, storage, router, merge
- **Severity**: medium
- **Confidence**: confirmed
- **Location**: `scenes-plugin/src/controller.ts:443-451` (`chain`), `1666` (`openChain`); `state.current` set separately at `614`, `1814`, `1896`, `2001`, `2854`, `2924`
- **Description**: `meta.current` and `state.current` are written in different statements, often with awaits between them. Operations are serialized by two independent promise chains, so "one thing at a time: user actions and sync steps never interleave" (line 442) does not hold for `open`. This is the root of the first bug above and makes every `name === this.meta.current` check time-dependent.
- **Suggested fix**: Derive `state.current` from `meta.current` in `setState`, and use one queue with a priority lane for `open`.
- **When**: together with the database adapter (`2026-11-13-own-database.md`), which rewrites this part of the controller.
- **Status**: fixed 2026-11-13: `state.current` is derived from `meta.current` in `setState` (no patch can set it); one queue (`OpQueue`) with a priority lane for opening replaces `chain` and `openChain`. Tests: `opQueue.test.ts`, `controllerQueue.test.ts`.

### S31. Whole-scene JSON (with images) is parsed and serialized several times per sync step
- **Area**: Browser: controller, storage, router, merge
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `scenes-plugin/src/presentation.ts:7-12`; `scenes-plugin/src/controller.ts:214-233` (`hashJson`, `isEmptyJson`, `withSceneName`), `2099-2107`, `2364-2374`, `2328-2335`, `2581-2584`
- **Description**: `serializeAsJSON` parses Excalidraw's output and stringifies it again. For one auto-push of the open scene, `pushListedScene` serializes the canvas only to test `isEmptyJson` (parse), then `pushScene` serializes again, parses for `isEmptyJson` and for `withSceneName`, and `recordPushedScene` may parse again for `hashJson`. With pictures in the scene this is tens of MB of main-thread JSON work every idle push; `unchanged()` in a merge serializes the canvas again.
- **Suggested fix**: Serialize once per step and pass `{ json, data, isEmpty }` along. Decide emptiness from the elements, not the JSON.
- **When**: together with the database adapter (`2026-11-13-own-database.md`), which rewrites this part of the controller.
- **Status**: fixed 2026-11-13 (partly by design): a push serializes the canvas once and takes emptiness from the editor's elements (`isEmptyHere`, `canvas.isEmpty`), auto-push of the open scene no longer serializes it to test emptiness, `flush` neither. Left: the merge's "unchanged" check still serializes the canvas once more (it compares the exact JSON the merge was based on).

### S32. Names and messages still say "scenes server" for Drive
- **Area**: Browser: controller, storage, router, merge
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `scenes-plugin/src/controller.ts:9`, `124-125` (`serverReachable`), `2056-2061`, `2293`
- **Description**: `scenesApi.list` is `driveScenes.list` in both builds, but a failed listing sets `sync.serverReachable = false` and logs "Scenes server not reachable: working locally". The field means "the Drive listing threw something other than not-connected".
- **Suggested fix**: Rename to what it is, or fold it into `driveOnline` / `lastError`.
- **When**: together with the database adapter (`2026-11-13-own-database.md`), which rewrites this part of the controller.
- **Status**: fixed 2026-11-13: `serverReachable` is gone; a listing that fails is `driveOnline: false` with `lastError`, and the messages say "Drive not reachable".

### S33. Magic font id range
- **Area**: Browser: controller, storage, router, merge
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `scenes-plugin/src/controller.ts:359` (`fontFamily >= 2000 && < 9000`), `scenes-plugin/src/fonts.ts:39` (`ID_BASE = 2000`)
- **Description**: The controller repeats the custom-font id range as literals. `9000` appears nowhere else in the searched code.
- **Suggested fix**: Export an `isCustomFontId` from `fonts.ts`.
- **Status**: superseded: the controller no longer has the range; `fonts.ts` has the only check (`ID_BASE`, `ID_RANGE`).

## Dead code

### D20. `request()` decorates errors nobody reads
- **Area**: Browser: controller, storage, router, merge
- **Severity**: low
- **Confidence**: confirmed (only two callers, both `.catch(() => {})`)
- **Location**: `scenes-plugin/src/api.ts:66-90`, callers `100-113`
- **Description**: Since scene reads and writes go to Drive, `request` is used only by `reportState` and `sendResult`, which swallow every error. The `status`, `offline`, `remoteMd5`, `exists` handling and the JSON body parsing are leftovers of the time saves went through the scenes server.
- **Suggested fix**: Reduce to a plain `fetch(...).catch(() => {})`.
- **Status**: fixed 2026-11-13: `api.ts` has no `request()` any more; `agentRelay` posts with a plain `fetch` whose errors are ignored. `scenesApi` is gone (the controller uses its homes, `cowork.ts` and `live.ts` the Drive client).

### D21. Leftovers of earlier storage and sync generations
- **Area**: Browser: controller, storage, router, merge
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `scenes-plugin/src/storage.ts:93-94`, `111-112`, `208-213`; `scenes-plugin/src/controller.ts:2226-2231`, `1716`, `1810`, `2409`; `scenes-plugin/src/router.ts:132-162`, `267`; `scenes-plugin/src/controller.ts:915-916`, `925`
- **Description**:
  1. `SceneMeta.legacy` / `inRepo` ("pre-sync-engine metadata"): `loadMeta` still marks records without `baseMd5`, and four places delete the flag. Every record written since the sync engine has `baseMd5`; `inRepo` is only ever deleted.
  2. `removeOldPublicCopies` runs on every start for a localStorage key (`kurviq-public-scenes`) that no code writes any more (the copies stopped on 22 Oct 2026), with no end date.
  3. In `keepOnlyHere`, `renamedFrom ?? name` and `delete meta.renamedFrom` cannot matter: `setLocalOnly(name, true)` throws for a scene with `renamedFrom` before Drive is touched.
- **Suggested fix**: Remove 1 and 3. Give 2 a removal date like the one at `controller.ts:1396`.
- **When**: together with the database adapter (`2026-11-13-own-database.md`), which rewrites this part of the controller.
- **Status**: fixed 2026-11-13: 1. `legacy` / `inRepo` removed (records without a base get `baseMd5: null`); 2. `removeOldPublicCopies` is now only the removal of its note, with a removal date (see B39); 3. `keepOnlyHere` refuses a pending rename up front and no longer touches `renamedFrom`.

### D22. Unused or test-only exports and members
- **Area**: Browser: controller, storage, router, merge
- **Severity**: low
- **Confidence**: confirmed (searched scenes-plugin, online, scenes-mcp, scenes-server)
- **Location**: `scenes-plugin/src/controller.ts:158` (`POLL_MS`), `123` (`SyncInfo`), `3100` (`discardLocal`, an alias of `takeTheirs` with one caller); `scenes-plugin/src/storage.ts:19` (re-export of `spaceSuffix`); `scenes-plugin/src/spaces.ts:39` (`isSharedSpace`); `scenes-plugin/src/presentation.ts:3` (re-export of `editedPresentation`); `scenes-plugin/src/viewTarget.ts:21` (`MIN_FIT_ZOOM`); `scenes-plugin/src/storage.ts:41`, `174` (`scenesOfMeta`, `migrateMeta`)
- **Description**: `POLL_MS`, `SyncInfo`, the `spaceSuffix` re-export and `isSharedSpace` are exported but used only in their own file. `editedPresentation` is re-exported by `presentation.ts` but nobody imports it from there (it is used only by tests of `presentation.mjs`). `MIN_FIT_ZOOM`, `scenesOfMeta` and `migrateMeta` are imported only by tests. On the controller, `fileIdOf` is public only for tests; `isLive` and `detach` are public but called only internally.
- **Suggested fix**: Drop the `export` / re-exports; inline `discardLocal`.
- **Status**: fixed 2026-11-13: `POLL_MS`, `SyncInfo`, `isSharedSpace`, `MIN_FIT_ZOOM` no longer exported; the `spaceSuffix` and `editedPresentation` re-exports and `discardLocal` (the UI calls `takeTheirs`) removed. Kept on purpose: `scenesOfMeta` and `migrateMeta` (their unit tests test them directly), `fileIdOf` (the pen uses it), `detach` (the browser move uses it).

### D23. Stale and stray comments
- **Area**: Browser: controller, storage, router, merge
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `scenes-plugin/src/controller.ts:3124-3127`, `1900-1905`
- **Description**: Line 3124 is the doc comment of `conflictInfo`, left above the history section, whose header says "the scene's versions in git" (they are Drive revisions). `openOrCreate` has two doc blocks; the first ("create it (empty, local)") predates the `elsewhere` lookup.
- **Suggested fix**: Move or delete them.
- **Status**: fixed 2026-11-13: the doc comment moved to `conflictInfo`, the history header names Drive's revisions, `openOrCreate` and `editorGone` have one doc block each.

## Duplications

### U3. Four element canonicalizers with different rules
- **Area**: Browser: controller, storage, router, merge
- **Severity**: medium
- **Confidence**: confirmed
- **Location**: `scenes-mcp/elementContent.mjs:6-43`; `scenes-plugin/src/online/liveMerge.ts:14`, `323-350`; `online/worker/serverMerge.ts:225-266`; `scenes-mcp/editConflicts.mjs:15-46`
- **Description**: `normalize` in `liveMerge.ts` is a line-for-line copy of `elementContent.mjs` (round to 2 decimals, drop empty fields, sort keys); only the `VOLATILE` set differs (`status` instead of `index`). `canonical` (Worker) and `canon` (edit conflicts) are two more variants. The rules differ in ways that matter: `elementContent.sameContent` trusts equal `version` + `versionNonce` as "same content", while `liveMerge.contentEqual` states that stamps never decide. So the Drive merge can miss a change by a writer that keeps the stamp, and the live path cannot. The Worker's separate rule is documented (`serverMerge.ts:6-10`); the other three are not.
- **Suggested fix**: One `normalize(value, volatileKeys)` in `scenes-mcp` used by `elementContent`, `liveMerge` and `editConflicts`, with the stamp shortcut as an explicit option.
- **Update 2026-11-13 (specs)**: Two canonicalizers remain (`elementContent.mjs`, `editConflicts.mjs`); `liveMerge.ts` and the Worker's go.
- **Status**: fixed 2026-11-13: one `normalize(value, volatile)` in `scenes-mcp/elementContent.mjs`, used by the merge, editConflicts and the agent edit diff (`editDiff.ts`, with its own keys; its stamp rule stays explicit: `contentEqual` never trusts stamps, `sameContent` does). Test: `mergeFixes.test.ts`.

### U27. Rename bookkeeping twice
- **Area**: Browser: controller, storage, router, merge
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `scenes-plugin/src/controller.ts:2800-2808` and `2844-2852` (`rename`) versus `2907-2920` (`followRemoteRename`)
- **Description**: Moving the snapshot, swapping the `meta.scenes` key, renaming the canvas (`appState.name`) and moving the agent baseline are written out twice; `followRemoteRename` does not use `moveRenamedSnapshot`.
- **Suggested fix**: One private `moveLocalScene(from, to, meta)` used by both.
- **When**: together with the database adapter (`2026-11-13-own-database.md`), which rewrites this part of the controller.
- **Status**: fixed 2026-11-13: `moveLocalScene(from, to, record)` (stored copy, record, canvas name, URL mode, agent baseline) for `rename` and `followRemoteRename`.

### U28. "Is the local copy complete" twice, with different answers
- **Area**: Browser: controller, storage, router, merge
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `scenes-plugin/src/controller.ts:354-364` (`requireCompleteLocalCopy`: pictures and fonts) versus `1421-1425` (`keepLocalCopy`: pictures only)
- **Description**: `keepLocalCopy`'s comment promises "complete with every image and font it uses" but it checks only images, with its own copy of the filter.
- **Suggested fix**: Call `requireCompleteLocalCopy` (with a parameter for the message).
- **When**: together with the database adapter (`2026-11-13-own-database.md`), which rewrites this part of the controller.
- **Status**: superseded: `keepLocalCopy` went with live sync; `requireCompleteLocalCopy` is gone too.

### U29. Three ways to find a free scene name
- **Area**: Browser: controller, storage, router, merge
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `scenes-plugin/src/spaces.ts:117-129` (`freeName`: "Plan (2)", truncated to 100); `scenes-plugin/src/controller.ts:1287-1292` ("name 2", no length check); `3237` (timestamp, no check at all)
- **Description**: See the bug "Copies get names that are not validated".
- **Suggested fix**: Use `freeName` everywhere.
- **When**: together with the database adapter (`2026-11-13-own-database.md`), which rewrites this part of the controller.
- **Status**: fixed 2026-11-13: copies get their names from `freeName` (through `copyName`); the "name 2" variant went with live sync.

### U30. Index-with-pruning store twice
- **Area**: Browser: controller, storage, router, merge
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `scenes-plugin/src/storage.ts:283-310` (`setCheckpoint`); `scenes-plugin/src/uploads.ts:25`, `47-62` (`keepUpload`)
- **Description**: Both implement the same thing: a per-tab write chain, an index record of key → time, rebuilding it from `keys()` when missing, dropping the oldest above a maximum, `delMany`, writing the index back.
- **Suggested fix**: One helper `boundedStore(store, indexKey, max)`.
- **Status**: fixed 2026-11-13: `boundedStore` (`scenes-plugin/src/boundedStore.ts`) used by the checkpoints and the uploads. Test: `boundedStore.test.ts`.

### U31. Small repeated literals and expressions
- **Area**: Browser: controller, storage, router, merge
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `UNTITLED = "\u0000untitled"` in `scenes-plugin/src/storage.ts:67`, `scenes-plugin/src/spaces.ts:24`, literal in `scenes-plugin/src/index.tsx:739`; `this.meta.scenes[name]?.renamedFrom ?? name` 11 times in `controller.ts` (e.g. `743`, `816`, `915`, `1141`, `1159`, `1191`); nonce `Math.floor(Math.random() * 2 ** 31)` in `controller.ts:3150` although `liveMerge.randomNonce` exists (`liveMerge.ts:33`)
- **Description**: `spaces.ts` only imports types from `storage.ts`, so `UNTITLED` could live in `spaces.ts` and be re-exported. The Drive-name expression deserves a `driveNameOf(name)`.
- **Suggested fix**: As described.
- **Status**: fixed 2026-11-13: `UNTITLED` lives in `spaces.ts` (storage, browserMove, index and the controller import it); `driveNameOf(meta, name)`; `restoreVersion` uses `randomNonce` from `editDiff.ts`.

## Over-engineering

### O11. `connectInitial` wrapper with a NOSONAR
- **Area**: Browser: controller, storage, router, merge
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `scenes-plugin/src/controller.ts:487-490`, `558-561`
- **Description**: `private async connectInitial() { this.connectLive(); } // NOSONAR S7503` exists only so a synchronous throw becomes a rejection. It is called as `.then(() => this.connectInitial())`, where a throw inside the callback already rejects the chain. `.then(() => this.connectLive())` does the same without the method and without the suppression.
- **Suggested fix**: Inline it.
- **Status**: superseded: `connectInitial` went with live sync.

### O12. `nextFrame` is neither a frame nor needed as an alias
- **Area**: Browser: controller, storage, router, merge
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `scenes-plugin/src/controller.ts:246`; `scenes-plugin/src/editorYield.ts:2-15`
- **Description**: `nextFrame = () => editorYield()` is a 50 ms timer (or one message-channel tick in a hidden tab), used as "the editor has applied `updateScene` by now" in eight places. The name hides that correctness depends on a fixed delay, and each use opens the window described in the first bug.
- **Suggested fix**: Call `editorYield()` directly, or wait for the editor's `onChange` after `updateScene` instead of a time.
- **Status**: fixed 2026-11-13: `nextFrame` is gone; the controller calls `editorYield()` directly. Waiting for the editor's `onChange` instead of a delay was not done (the delay is also what the editor needs to render; no failure seen).

