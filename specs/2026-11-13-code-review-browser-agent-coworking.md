# Code review: Browser: main UI, agent co-working

Status: open

Findings of the code review of 2026-11-13 (see `2026-11-13-code-review.md`) in the area **Browser: main UI, agent co-working**, still open after the triage against the two specs of the same day. 20 findings: 0 high, 8 medium, 12 low. Ids as in the review (B bug, S smell, D dead code, U duplication, O over-engineering). A finding that is fixed gets a line "- **Status**: fixed in <commit>".

## Potential bugs

### B40. Comment operations are validated after the element edit was already applied (live scenes and the open scene)
- **Area**: Browser: main UI, agent co-working (index, live, cowork)
- **Severity**: medium
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/cowork.ts:1028-1034` (editLiveScene), `scenes-plugin/src/cowork.ts:897-921` (editOpenScene); the atomic paths for comparison: `scenes-plugin/src/cowork.ts:967-973`, `1109-1114`; the errors: `scenes-mcp/sceneComments.mjs:346, 378-431`
- **Description**: In `editLiveScene`, `live.agentEdit(...)` applies and queues the element changes first; only then `agentComments()` runs `applyCommentOps`, which throws for a bad operation (`comments[0]: no thread "x"`, another author's comment, a missing element, empty text). The same order is in `editOpenScene` (`api.updateScene` / `live.agentEdit` at 904-910, comments at 916). Scenario: `edit_scene` on a live scene with `add: [...]` plus `comments: [{ action: "reply", thread: "typo" }]`: the elements land for everybody, the agent gets only the comment error and no result. `onceForRequest` stores nothing for a failed run, and the tool creates a new requestId when the agent did not pass one, so the corrected retry fails with "Element ids already exist" (or re-applies relative work). In the Drive and local-only paths the same input changes nothing, because comments are computed before the save.
- **Suggested fix**: Call `agentComments()` (validation and the new comment list) before `live.agentEdit` / `api.updateScene`, and only write the comments to the store afterwards.

### B41. An agent edit of an open local-only scene replaces the canvas with a state computed from an older read (user edits in between are lost)
- **Area**: Browser: main UI, agent co-working (index, live, cowork)
- **Severity**: medium
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/cowork.ts:1097-1114` (editLocalScene), `scenes-plugin/src/controller.ts:1503-1506` (localJson reads the canvas), `scenes-plugin/src/controller.ts:1602-1604` (writeLocal → applyScene); same pattern in the non-live branch of editOpenScene `scenes-plugin/src/cowork.ts:884-910`
- **Description**: `editLocalScene` serializes the open canvas, then awaits `registerSceneFonts` and `applyEdits` (font loading, `document.fonts.load`, conversion), then `writeLocalOnly` replaces the whole canvas with the result (`applyScene`, `CaptureUpdateAction.NEVER`). Nothing compares against what the canvas holds at write time, so an element the user drew, moved or typed during those awaits disappears without a trace and cannot be undone. `queueEdit` only orders agent edits among themselves. Local-only is the path for every signed-out user, so this is the normal co-working path there. `editOpenScene` has the same gap when the scene is not live: the comment at 882-883 says the user may go on drawing, but only the live branch merges (`liveDifference`); the other branch calls `api.updateScene({ elements: images.elements })` built from `readState`.
- **Suggested fix**: Before writing, diff the result against the read state and apply only that difference to the current canvas (the `liveDifference(current, next, base, …)` used for live scenes does exactly this), or re-read and re-apply when the canvas changed during the edit.
- **Also in the Astra review**: F04, rated high there. It names the same gap in `editLocalScene` (`scenes-plugin/src/cowork.ts:1093-1114`): read, convert (awaits), write the whole scene, with no check that the scene changed in between.

### B42. editOpenScene applies the edit to whatever scene is open after its awaits
- **Area**: Browser: main UI, agent co-working (index, live, cowork)
- **Severity**: medium
- **Confidence**: confirmed (traced in code; live mode only)
- **Location**: `scenes-plugin/src/cowork.ts:870-877` (the only scene check), `885-890` (await), `894-913` (apply), `923-926` (baseline)
- **Description**: `expectScene` is checked once, before `await applyEdits(...)`. `scenesController.open()` is not blocked meanwhile (the edit does not run in the controller's `exclusive`). If the user switches from scene A to B during the await, `api.updateScene({ elements: images.elements })` writes A's elements over B's canvas (B becomes dirty and auto-sync pushes it); with a live scene B, `scenesController.liveCurrent()` is B's session and A's additions and updates are sent into B. Afterwards `handleBaseline(scene, after, command)` stores B's elements as A's agent baseline and checkpoint, so the next `userChanges` report for A is wrong too.
- **Suggested fix**: Re-check `scenesController.getState().current === scene` (and that `liveCurrent()` is the same session) after `applyEdits` and before applying; throw the "user switched scenes" error otherwise.
- **Also in the Astra review**: F03, rated high there.

### B43. The open-scene `edit` command is neither queued nor protected by a requestId
- **Area**: Browser: main UI, agent co-working (index, live, cowork)
- **Severity**: medium
- **Confidence**: confirmed (traced in code; live mode only)
- **Location**: `scenes-plugin/src/live.ts:958-962` (compare `897-901` and `922-926`), `scenes-plugin/src/cowork.ts:884-910`, `scenes-mcp/tools.mjs:726-746`
- **Description**: `scene-edit` and `local-edit` run through `onceForRequest` + `queueEdit`; `edit` calls `editOpenScene` directly. Two `edit` commands that overlap (two agents, or a retry after the MCP's timeout while the first is still converting) both take `readState` before either applies; in the non-live branch the second `api.updateScene` replaces the canvas with a state that does not contain the first edit, and both report success. `applyOpenEdit` sends no requestId, so a timed-out edit that is sent again is applied twice (`command.requestId` at cowork.ts:904 is always undefined on this path).
- **Suggested fix**: Wrap the `edit` case in `queueEdit` (and in `onceForRequest` with a requestId generated in `applyOpenEdit`), like the other two edit commands.

### B44. Unmounting the scene pill tells the controller that the editor is gone
- **Area**: Browser: main UI, agent co-working (index, live, cowork)
- **Severity**: medium
- **Confidence**: likely (code path traced; not run. Not checked: every side effect of the second initialization)
- **Location**: `scenes-plugin/src/index.tsx:141-161` (useAttachController), `388` and `1729` (two users), `scenes-plugin/src/controller.ts:472-510, 580-604`, `excalidraw/packages/excalidraw/components/LayerUI.tsx:239-244, 612-656`, `excalidraw/packages/excalidraw/components/MobileMenu.tsx:96-99`
- **Description**: The effect's cleanup calls `scenesController.editorGone()`, meant for "the editor unmounted (crash)". The hook is used by `ScenesTopLeftUI`, which Excalidraw renders in two different trees: `LayerUI` (desktop / tablet) and `MobileMenu` (phone). When the form factor changes (window narrowed below the phone breakpoint, device rotated), the pill unmounts in one tree and mounts in the other while the editor and its API stay alive. The cleanup then logs "the editor is gone", sets `api = null`, clears the sync timers, removes the listeners and calls `liveSync.detachCanvas()`; the new mount attaches again and re-runs the whole start-up (`adoptInitialCanvas`, which reloads the comments from the stored snapshot, `connectInitial`, a full `syncNow({ refresh: true })`). The hook is also called by `ScenesSidebar`, so two components own one attach / detach.
- **Suggested fix**: Attach in one place whose lifetime is the editor's (`ScenesSidebar`, a child of `<Excalidraw/>`), and call `editorGone()` only when `api.isDestroyed` or the API changes, not on any unmount of the pill.

### B105. ensureFonts recognises font names only in pretty-printed scene JSON
- **Area**: Browser: main UI, agent co-working (index, live, cowork)
- **Severity**: low
- **Confidence**: confirmed (traced in code; currently masked because the MCP pretty-prints PUT bodies, `scenes-mcp/tools.mjs:980, 1857`)
- **Location**: `scenes-plugin/src/live.ts:215-216` versus `scenes-plugin/src/live.ts:238`
- **Description**: `ensureFonts` looks for `'"fontFamily": "'` (with a space) in `command.json` and PUT bodies; `sceneJsonWithFontIds`, 20 lines below, checks both spellings. A compact body (`JSON.stringify(scene)`, as `local-save` at tools.mjs:1760 sends) naming a Google font skips the download; `fontFamilyValue` then returns the unknown name unchanged (`scenes-plugin/src/fonts.ts:254-260`) and the element is stored with a string `fontFamily`.
- **Suggested fix**: Use one shared test (both spellings, or parse once) in both functions.
- **Also in the Astra review**: F10.

### B106. The "Changed here" bar adds the editor's offset twice
- **Area**: Browser: main UI, agent co-working (index, live, cowork)
- **Severity**: low
- **Confidence**: confirmed (traced in code; no visible effect while the editor starts at the window's top left)
- **Location**: `scenes-plugin/src/templateChanges.tsx:44-46`, `scenes-plugin/src/slides.scss:970-971`, `excalidraw/packages/common/src/utils.ts:339-358`
- **Description**: `sceneCoordsToViewportCoords` already adds `offsetLeft` / `offsetTop`; the bar (`position: fixed`) adds them again. `agentGlow.ts` uses the same function without the extra offset. As soon as the canvas does not start at 0,0 the bar is displaced by that offset.
- **Suggested fix**: Drop `+ appState.offsetLeft` / `+ appState.offsetTop`.

## Code smells

### S6. Comment and tool description promise an undoable agent edit; the code keeps it out of the undo history
- **Area**: Browser: main UI, agent co-working (index, live, cowork)
- **Severity**: medium
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/cowork.ts:3-5` ("one undoable step per agent edit"), `scenes-plugin/src/cowork.ts:906-910` (`CaptureUpdateAction.NEVER`, "agent changes do not enter the user history"), `scenes-mcp/tools.mjs:1191` ("undoable by the user as one step (Cmd/Ctrl+Z)")
- **Description**: The file header and the `edit_open_scene` description shown to agents contradict the implementation. An agent will tell the user "press Cmd+Z to undo my change", which does not work.
- **Suggested fix**: Decide which one is wanted; correct the header and the tool description, or capture the edit.

### S34. Numbers in agent-facing texts are copies of constants defined elsewhere
- **Area**: Browser: main UI, agent co-working (index, live, cowork)
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/live.ts:623` ("about 10 s") versus `IDLE_PUSH_MS` `scenes-plugin/src/controller.ts:156` (index.tsx:1011 derives it); `scenes-plugin/src/cowork.ts:752` ("keeps the newest 100") versus `MAX_UPLOADS` `scenes-plugin/src/uploads.ts:20`; `scenes-mcp/tools.mjs:1919` ("given up after 90 s") versus `QUEUE_WATCHDOG_MS` `scenes-plugin/src/live.ts:681`
- **Description**: Changing a constant leaves the text agents act on wrong. `agentRequests.ts:114` shows the pattern done right (`${MAX_PAYLOADS}`).
- **Suggested fix**: Build the texts from the constants (the tab can report the watchdog time in its status).

### S35. Doc comments sit on the wrong declarations
- **Area**: Browser: main UI, agent co-working (index, live, cowork)
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `scenes-plugin/src/live.ts:125` (the IS_RENDERER comment, orphaned above `commentsOnly`), `scenes-plugin/src/live.ts:144-148` (describes `convertMcpElements`, placed on `measureTexts`), `scenes-plugin/src/cowork.ts:252` ("fields an agent must not set directly" on `isPlainObject`; it belongs to `PROTECTED` at 286), `scenes-plugin/src/index.tsx:527-538` (the SceneSwitcher comment stacked above GroupHeading's), `scenes-plugin/src/index.tsx:90-92` (filter "in the sidebar list and the activity log": there is no sidebar list, and the log is not filtered)
- **Description**: Left behind by function extractions. A reader of `measureTexts` or `isPlainObject` gets a description of something else.
- **Suggested fix**: Move each comment to its declaration; correct the filter comment.

## Dead code

### D24. versionLabel still parses commit messages from the GitHub sync
- **Area**: Browser: main UI, agent co-working (index, live, cowork)
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/index.tsx:1317-1322`, source of the value: `scenes-plugin/src/online/drive.ts:1144`
- **Description**: The function strips "Agent:" and "scene: …" and turns "Add" into "Created". Drive history only ever yields `"Agent edit"` or `""`, so the result is always "Agent edit" or "Change"; the "Agent edit" row also carries the separate "agent" tag (index.tsx:1421).
- **Suggested fix**: Replace with a fixed label ("Change"; the tag marks agent versions) and drop `message` from `SceneVersion` if nothing else reads it.

### D25. ActivityLog's `hidden` filter is never used
- **Area**: Browser: main UI, agent co-working (index, live, cowork)
- **Severity**: low
- **Confidence**: confirmed (one caller)
- **Location**: `scenes-plugin/src/index.tsx:1275-1278`, the only caller `scenes-plugin/src/index.tsx:1488` (`hidden={[]}`)
- **Description**: The parameter and the per-entry `hidden.some(...)` filter remain from the removed sidebar list, where the scene filter hid entries.
- **Suggested fix**: Remove the prop and the filter.

### D26. PlaceSvg is exported and never used
- **Area**: Browser: main UI, agent co-working (index, live, cowork)
- **Severity**: low
- **Confidence**: confirmed (rg over scenes-plugin, online, scenes-mcp, scenes-server)
- **Location**: `scenes-plugin/src/icons.tsx:24-28`; the same SVG wrapper is written inline in `scenes-plugin/src/index.tsx:200-204`
- **Description**: Unused component; `PlaceIcon` repeats its markup.
- **Suggested fix**: Use `PlaceSvg` in `PlaceIcon`, or delete it.

### D27. scenes.scss: an unused class and declarations that are always overridden
- **Area**: Browser: main UI, agent co-working (index, live, cowork)
- **Severity**: low
- **Confidence**: confirmed (every class of the file searched as a whole token in all .ts / .tsx; classes built from template strings checked by hand)
- **Location**: `scenes-plugin/src/scenes.scss:763-770` (`.scenes-list`, used nowhere), `scenes-plugin/src/scenes.scss:648-651` (font-size, text-transform, letter-spacing and color of `.scenes-list-header`, all overridden by `1284-1291`)
- **Description**: `.scenes-list` belonged to the removed sidebar list. No other dead selector or duplicated rule block was found (the repeated selectors at 1295-1313 are the phone media query).
- **Suggested fix**: Delete `.scenes-list`; merge the two `.scenes-list-header` blocks.
- **Also in the Astra review**: F12.

### D28. Exports that only their own file uses
- **Area**: Browser: main UI, agent co-working (index, live, cowork)
- **Severity**: low
- **Confidence**: confirmed (rg, tests included)
- **Location**: `scenes-plugin/src/live.ts:516` (`LIVE_SCENE`), `scenes-plugin/src/cowork.ts:244` (`sceneSize`), `scenes-plugin/src/agentRequests.ts:84` (`MAX_PAYLOAD_CHARS`)
- **Description**: Exported without an importer. (`applyEdits`, `movesFrames`, `repairImages`, `refuseImagesWithoutFile` are test-only exports.)
- **Suggested fix**: Drop the `export` keyword.

## Duplications

### U4. Three copies of the detached edit pipeline in cowork.ts
- **Area**: Browser: main UI, agent co-working (index, live, cowork)
- **Severity**: medium
- **Confidence**: confirmed
- **Location**: `scenes-plugin/src/cowork.ts:954-974` (Drive), `1014-1040` (live), `1097-1125` (local-only); the conflict error text twice: `900-902` and `1024-1026`
- **Description**: Each path repeats: parse, `registerSceneFonts`, `applyEdits(restoreElements(...))`, merge `files`, `refuseImagesWithoutFile`, `repairImages(withTemplate(...).filter(...))`, `agentComments`, and the identical `withSceneName(withComments(withFonts(serializeAsJSON(...))))` line (969, 1036, 1111). They have already drifted: comments are computed before the write in two of them and after it in the third (first bug above).
- **Suggested fix**: One helper "edit this scene data" returning `{ edit, elements, files, comments, json }`; the three callers differ only in where they read from and write to.

### U32. The "status needs no badge" list exists three times
- **Area**: Browser: main UI, agent co-working (index, live, cowork)
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `scenes-plugin/src/index.tsx:384`, `771`, `1504` (`QUIET_STATUS`)
- **Description**: The pill, the switcher row and the scene panel each list the quiet statuses; 384 lacks "untitled", the other two are identical. A new status has to be added in three places.
- **Suggested fix**: Use `QUIET_STATUS` in all three (the pill never shows a badge for "untitled" in practice: check and unify).

### U33. Small helpers and rules copied between the tab and the MCP
- **Area**: Browser: main UI, agent co-working (index, live, cowork)
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `PSEUDO_TYPES`: `scenes-plugin/src/live.ts:142` and `scenes-mcp/tools.mjs:228`; `isPlainObject`: `scenes-plugin/src/cowork.ts:253` and `scenes-mcp/editConflicts.mjs:12`; the requestId pattern: `scenes-plugin/src/agentRequests.ts:18` and `scenes-mcp/tools.mjs:1466`; "id (fields)" conflict list: `scenes-plugin/src/cowork.ts:901, 1025` and `scenes-mcp/editConflicts.mjs:306` (`conflictList`); "does the edit change anything besides comments": `scenes-plugin/src/live.ts:128-136`, `scenes-plugin/src/cowork.ts:852`, `scenes-mcp/tools.mjs:1250, 1492`
- **Description**: The plugin already imports shared `.mjs` modules from `scenes-mcp`, so these copies have no technical reason. The last one is a hidden coupling: a new edit option that is missing in `commentsOnly` lets an element edit pass the read-only check at live.ts:894 and 959.
- **Suggested fix**: Export them once from a shared `.mjs` (for example next to `editConflicts.mjs`) and import on both sides.

### U34. Two tooltip implementations with the same rules (Astra F11)
- **Area**: Browser: main UI, agent co-working (index, live, cowork)
- **Severity**: low
- **Confidence**: confirmed (found by the Astra review; the shared 120 ms delay and 140 px edge clamp checked by me)
- **Location**: `scenes-plugin/src/titleTips.ts:23-42`, `:67`; `scenes-plugin/src/quickTip.tsx:30-57`
- **Description**: Both show a tooltip after 120 ms, clamp it 140 px from the window edges and place it above or below with an arrow; one writes DOM directly, the other is a React portal. They already differ: `titleTips` hides on blur and pointer down, `QuickTip` does not.
- **Suggested fix**: One function for the placement and the timing, used by both.

## Over-engineering

### O2. A second agent mode ("live") with its own edit path, used only by an opt-in env variable of the local MCP
- **Area**: Browser: main UI, agent co-working (index, live, cowork)
- **Severity**: medium
- **Confidence**: confirmed (`scenes-mcp/server.mjs:56`, `online/worker/index.ts:284`: online is always detached)
- **Location**: `scenes-plugin/src/live.ts:512-580` (showLive, the "agent-live" scene), `941-946`, `956-962`; `scenes-plugin/src/cowork.ts:57-71, 154-189, 865-933` (baselines, readOpenScene, editOpenScene); `scenes-mcp/tools.mjs:1128-1390, 1966-2002, 2075-2086`
- **Description**: The detached path now also edits the open canvas (live scenes through `editLiveScene`, local-only scenes through the tab) with requestIds, queueing and base comparison. The live mode keeps a parallel implementation: its own read / edit commands, its own conflict baseline store, a preview scene that switches the user's view, and none of the protections. Three of the bugs above exist only there.
- **Suggested fix**: Either remove the live mode (README.md:535 and the skill mention it) or route `edit_open_scene` through the same queue, requestId and merge as `scene-edit`.
