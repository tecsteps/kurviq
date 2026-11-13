# Code review: Browser: slides, rich text, comments

Status: open

Findings of the code review of 2026-11-13 (see `2026-11-13-code-review.md`) in the area **Browser: slides, rich text, comments**, still open after the triage against the two specs of the same day. 34 findings: 2 high, 8 medium, 24 low. Ids as in the review (B bug, S smell, D dead code, U duplication, O over-engineering). A finding that is fixed gets a line "- **Status**: fixed in <commit>".

## Potential bugs

### B5. Formatted notes and agent markdown do not survive a round trip (bold + italic, italic with `*`, links with `)`)
- **Area**: Browser: slides, rich text, comments
- **Severity**: high
- **Confidence**: confirmed (reproduced: `markdownOf` then `docFromMarkdown` in a scratch script)
- **Location**: `scenes-plugin/src/richText/model.ts:302-307` (MD_MARKS), `:341-372` (parseInline), `:346` (link), `:381-415` (docFromMarkdown); writer `scenes-mcp/richDoc.mjs:210-243`; used for notes in `scenes-plugin/src/notes.tsx:26`, `:249`
- **Description**: Speaker notes are stored only as this markdown (`markdownOf` on every save, `docFromMarkdown` on every open and in the presenter view), and agents get and send the same form. The parser does not read back what the writer emits:
  - bold + italic: `{t:"both", b, i}` is written `***both***` and read as bold `*both` plus a plain `*`. Bold + italic + underline gives `***__~~all~~__***`, read with stray asterisks too.
  - italic text containing `*`: `{t:"a*b", i}` is written `*a\*b*` and read as italic `a\` plus plain `b*` (the italic regex stops at the escaped asterisk; the bold and underline patterns happen to work).
  - italic text starting with a space: written `* lead…*`, read as a bullet list item.
  - a link whose URL contains `)`: `https://a.b/c_(d)` is cut at the first `)`.
  - a plain paragraph that starts with `- `, `• `, `1. ` or `# ` (typed by hand; the editor has no auto-format) comes back as a list item or a bold heading, and `3. third` becomes `1. third`.
  Result: a user makes a phrase in the notes bold and italic, closes the popover, and the presenter view and the next open show literal asterisks with half the formatting gone; each further save keeps the damage. An agent that reads a text's `markdown` and sends it back unchanged damages the element the same way.
- **Suggested fix**: Make the two directions inverse and test it: a property test `docFromMarkdown(markdownOf(doc))` equals `doc` for all mark combinations. In the parser, try `***…***` before `**…**`, skip escaped characters inside the mark patterns, and let the link pattern accept balanced parentheses (or percent-encode `(` `)` when writing). In the writer, escape a leading `#`, `-`, `*`, `•`, `[` and `digits.` of a plain paragraph and a run's leading space after an opening marker.
- **Status**: fixed 2026-11-13

### B6. Adding headline and eyebrow to an old template fails, again and again, when no slide has a headline (Astra F37)
- **Area**: Browser: slides, rich text, comments
- **Severity**: high
- **Confidence**: confirmed (found and reproduced by the Astra review with the production function; traced in code by me)
- **Location**: `scenes-plugin/src/slides.ts:1146-1148` (`styleTitleModel`), `:1177-1192` (`addTitleBlock`); caller `scenes-plugin/src/deck.ts:329-348`
- **Description**: `findTitles` returns null for a slide without a qualifying headline. Then `spotOf(slide)` is `undefined` for every slide, `counts` stays empty and `common` is `undefined` too, so `atCommon` (`spotOf(slide) === common`) holds all slides and `model` is the first slide. `styleTitleModel` destructures `found.get(model.id)!`, which is null: `Cannot destructure property 'headline'`. In `deck.ts` the promise's `finally` sets `addingTitles = false` and schedules the template sync again, which runs into the same error, so the deck's template sync never gets past this point. Affects a template from before the title block (or made by hand or by an agent) whose slides are empty or have no large headline.
- **Suggested fix**: Pick a model only when `common` is defined (`const atCommon = common ? … : []`), so the default title path runs; catch the failure in `deck.ts` and do not reschedule the same work.
- **Status**: fixed 2026-11-13

### B45. A template element that leaves the template wipes every slide's own version of it (headline texts included)
- **Area**: Browser: slides, rich text, comments
- **Severity**: medium
- **Confidence**: confirmed (traced in code; not run)
- **Location**: `scenes-plugin/src/slides.ts:467-482` (removal), `:438` (`keep` is empty for a deleted copy), `:236-240` (doc comment that says the opposite)
- **Description**: The removal loop deletes a copy when `!hasHandChanges(el, slide) || !templateIds.has(data.copyOf)`. The second half deletes every copy whose template element is no longer a source, hand-changed or not, although the comment on `hasHandChanges` says such a copy "stays then". When the element comes back, the copy is revived with `keep = new Set()` because `existing.isDeleted`, so nothing the user changed on the slide is kept, even though the deleted copy still holds it. Scenarios: (1) the user deletes the template's headline by mistake and presses undo: the sync (300 ms later, not in the undo history) has deleted every slide's headline, and after the undo they return as `{title}` (the frame name), each slide's hand-written headline is gone; (2) the headline is dragged partly out of the template frame and back (its `frameId` becomes null in between); (3) cut and paste of a template element (new id): all slide versions are deleted and replaced by fresh copies.
- **Suggested fix**: Decide which behaviour is meant and make comment and code agree. To keep the users' words: when reviving a copy with `removedBy === "sync"`, compute `keep` from `changedByHand(existing, …)` instead of an empty set; and consider keeping hand-changed copies whose source is gone (drop the `|| !templateIds.has(…)` part) or at least their text.
- **Status**: fixed 2026-11-13

### B46. Formatted text keeps a stale size: the size cache ignores formatting and late fonts
- **Area**: Browser: slides, rich text, comments
- **Severity**: medium
- **Confidence**: likely (mechanism traced through `refreshTextDimensions` in the patched Excalidraw; the visible effect was not run)
- **Location**: `scenes-plugin/src/richText/layout.ts:350-359` (`sizes`, `sizeKey`), `:373-379` (`richMeasure` returns `known` first), `:196-202` (`loadingdone` clears `cache` and `fontMetrics` only)
- **Description**: `sizes` maps element id + font + font size + line height + alignment + text to a measured size. The key contains neither the formatting nor anything about loaded fonts, and `richMeasure` returns a hit before it looks at the doc. For a text that grows with its content (`autoResize`, no wrapping) Excalidraw calls only `richMeasure` (no `richWrap` that would refresh the entry). So: (1) select a word in a one-line formatted text and change its size twice (toolbar or ⌘⇧.): the first change is measured and remembered, the second finds the entry for the same text and returns the old width and height, the element's box no longer matches what is drawn; typing a character and deleting it brings the stale entry back. (2) A formatted text measured before its custom or Google font was loaded: `loadingdone` clears the layout cache but not `sizes`, so `remeasureTitleBlock` and every later measure of that text return the fallback font's size.
- **Suggested fix**: In `richMeasure`, try `richDocOf(element, text)` first (the layout cache makes it cheap) and use `sizes` only for wrapped text that no longer equals the plain text; add a hash of `customData.rich` to `sizeKey`; clear `sizes` in the `loadingdone` handler.
- **Also in the Astra review**: F41.
- **Status**: fixed 2026-11-13

### B47. PDF tab: "This slide" exports slide 1 after the slide is deselected
- **Area**: Browser: slides, rich text, comments
- **Severity**: medium
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/slidesUI.tsx:143`, `:150-155`, `:163`, `:191`
- **Description**: `choice` is initialised once (`current ? "current" : "all"`). When the user then clicks the empty canvas (`deck.attach`'s pointer handler sets `activeId` to null), `current` is undefined, the radio is disabled but still checked, the button stays enabled, and `spec = String((current?.index ?? 0) + 1)` is `"1"`. "Download PDF" exports slide 1 instead of the slide the user had chosen, with the file name suffix "slide 1".
- **Suggested fix**: Disable the button while `choice === "current" && !current` (or fall back to "all" when `current` disappears) and drop the `?? 0`.
- **Status**: fixed 2026-11-13

### B48. Duplicating a slide loses the slide's own headline, eyebrow and changed template elements (Astra F38)
- **Area**: Browser: slides, rich text, comments
- **Severity**: medium
- **Confidence**: confirmed for the code (found by the Astra review; the filter traced by me; not run)
- **Location**: `scenes-plugin/src/slides.ts:806-841`, the filter at `:821`; action in `scenes-plugin/src/slidesUI.tsx:453-459`
- **Description**: `duplicateSlides` copies the frame and its elements except those with `slides.copyOf`. The slide's own versions of template elements carry `copyOf`: the headline and eyebrow with the slide's own words, and template copies the user recoloured or moved on that slide. The sync then makes fresh copies from the template for the new slide, so the duplicate shows the template's placeholder texts and styling instead of the slide's.
- **Suggested fix**: Carry the per-slide overrides over to the duplicate (remap the copies' ids and bindings to the new frame, keep their base and hidden state).
- **Status**: fixed 2026-11-13

### B49. A formatted template text with a placeholder loses its formatting on the slides (Astra F39)
- **Area**: Browser: slides, rich text, comments
- **Severity**: medium
- **Confidence**: confirmed (found and reproduced by the Astra review; `makeCopy` traced by me)
- **Location**: `scenes-plugin/src/slides.ts:318-320` (`makeCopy`); rule in `scenes-mcp/richDoc.mjs:198-204` (`richDocOf`)
- **Description**: `makeCopy` fills `{page}`, `{title}` and the other placeholders in `text` and `originalText`, but copies `customData.rich` as it is. `richDocOf` rejects a rich document whose plain text differs from `originalText`, so the copy on each slide falls back to plain text: a bold or coloured footer with `{page}` is unformatted on the slides, and links and tooltips in it are gone.
- **Suggested fix**: Fill the placeholders in the rich document's runs as well (keeping the marks) and derive the plain text from the result.
- **Status**: fixed 2026-11-13

### B50. The open notes editor does not show notes changed elsewhere and overwrites them at the next keystroke (Astra F42)
- **Area**: Browser: slides, rich text, comments
- **Severity**: medium
- **Confidence**: confirmed (found by the Astra review; traced in code by me)
- **Location**: `scenes-plugin/src/notes.tsx:208-283`, `saved` at `:245`, the effect's dependencies at `:281-283`
- **Description**: The editor is built once per slide id and ignores later `notes` props ("later changes to the notes come from it"). With live sync or an agent that is not true: when another editor or an agent changes the slide's notes while the popover is open, the popover keeps the old text, and the user's next keystroke saves that whole old text over the newer notes.
- **Suggested fix**: Take over incoming notes while the editor has no unsaved change; when it has, merge or show the conflict instead of saving over it.
- **Status**: fixed 2026-11-13

### B107. Comment changes are stamped with the device clock only
- **Area**: Browser: slides, rich text, comments
- **Severity**: low
- **Confidence**: likely (the merge rule is confirmed; the two-device scenario was not run)
- **Location**: `scenes-plugin/src/comments/ui.tsx:430`, `:450`, `:525`, `:530` (`u: now()`); merge rule `scenes-mcp/sceneComments.mjs:116-124`, used at `scenes-plugin/src/controller.ts:2486`
- **Description**: Every edit, delete, resolve and reopen sets `u: Date.now()`, and file merges keep the version with the larger `u`. With two clocks a few minutes apart, A (clock ahead) resolves a thread and B reopens it a minute later: B's change has the smaller `u`, shows locally (`commentStore.change` replaces the entry without comparing) and is dropped at the next merge, so B's view and the file disagree until a reload. The presentation flag already solves the same problem (`presentationChange` in `scenes-mcp/presentation.mjs:48-51`: "a click follows all observed writes even if this device's clock is behind").
- **Suggested fix**: Stamp with `Math.max(Date.now(), comment.u + 1)` in one helper used by all four call sites.
- **Status**: fixed 2026-11-13

### B108. Slide thumbnails go stale and are never dropped
- **Area**: Browser: slides, rich text, comments
- **Severity**: low
- **Confidence**: confirmed for the cache key and the growth (traced); likely for the late-image case
- **Location**: `scenes-plugin/src/deck.ts:383-418`, `scenes-plugin/src/slides.ts:1269-1277` (`slideVersion`)
- **Description**: (1) A thumbnail is reused while `slideVersion` (versions of the frame and its elements) is unchanged. The picture's file and the canvas background are not part of it: an image whose data arrives after its element (live sync sends files as separate events) leaves the placeholder in the slide list, overview and presenter view until the slide is edited; changing the canvas background keeps the old thumbnails. (2) `renderThumbs` has no in-flight guard: a change during a long first pass starts a second pass that renders the same slides again (its local `thumbs` does not have the first pass's results yet), and the pass that ends last overwrites the other's state. (3) `state.thumbs` and `thumbVersions` are never pruned: data URLs of deleted slides and of every deck opened in the session (also the shared viewer's, through `borrow`) stay in memory.
- **Suggested fix**: Add the ids of loaded image files on the slide and the background colour to the key; keep one running pass (re-run once when it ends if a change came in); when rebuilding, keep only entries of current frame ids.
- **Also in the Astra review**: F45.
- **Status**: fixed 2026-11-13

### B109. Presenter: `start()` is not guarded and its timers survive `stop()`
- **Area**: Browser: slides, rich text, comments
- **Severity**: low
- **Confidence**: likely (traced; needs a start and stop within 200 ms, or two starts)
- **Location**: `scenes-plugin/src/present.tsx:102-150` (no `active` check; `setTimeout` at `:148-149`), `:152-179`
- **Description**: `stop()` returns early when not active, `start()` has no such guard: a second call while presenting stores the presentation's own state (view mode, zen mode, frame names off, sidebar closed) in `saved`, and `stop()` then "restores" the editor into view and zen mode. The two timeouts started in `start()` (show the slide after 150 ms, set the laser after 200 ms) are not cancelled: if the presentation ends within that time (Esc right after start, or the shared viewer closing: `publicScene.tsx:262` calls `stop()` then gives the editor back), `show()` locks scroll and zoom on the canvas that is the deck by then and `setLaser` switches its tool to the laser, with no presentation left to undo it.
- **Suggested fix**: Return from `start()` when `state.active`; keep the two timer ids and clear them in `stop()` (and `resizeTimer` too).
- **Also in the Astra review**: F40, rated medium there.
- **Status**: fixed 2026-11-13

### B110. Presentation keys ignore modifier keys
- **Area**: Browser: slides, rich text, comments
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/present.tsx:359-416`
- **Description**: `onKey` looks at `event.key` only. While presenting, ⌘P / Ctrl+P goes to the previous slide and blocks printing, ⌘N advances a slide (and still opens a window), ⌘L toggles the laser instead of focusing the address bar, ⌘B blanks the screen, ⌘1…9 is collected as a slide number and prevented.
- **Suggested fix**: Return early when `event.metaKey || event.ctrlKey || event.altKey` (keep plain keys and Shift).
- **Status**: fixed 2026-11-13

### B111. Formatted right-to-left text is drawn at the wrong place
- **Area**: Browser: slides, rich text, comments
- **Severity**: low
- **Confidence**: likely (derived from the layout code; not run)
- **Location**: `scenes-plugin/src/richText/layout.ts:259-292` (fragments), `:484-505` (`drawRich`)
- **Description**: A fragment's `x` is the left edge of its first character in logical order and its width is `right edge of the latest character - x`. In an Arabic or Hebrew run the first character is the rightmost one, so `x` is near the right end and the width shrinks or goes negative with every further character. The canvas (forced `dir="ltr"`, `textAlign = "left"`) then draws the whole run starting at that right end: it overflows to the right of where the editor shows it; highlights (`width > 0` only) and underlines are missing or misplaced; SVG and PDF use the same fragments.
- **Suggested fix**: Track `min(left)` and `max(right)` over the fragment's characters and use them for `x` and `width` (and draw with the fragment's direction), or split fragments at direction changes.
- **Status**: fixed 2026-11-13

### B112. A scene's font is silently not used when its number collides with a font of this browser
- **Area**: Browser: slides, rich text, comments
- **Severity**: low
- **Confidence**: confirmed (traced in code); the collision itself is rare (1 in 7000 per pair of names)
- **Location**: `scenes-plugin/src/fonts.ts:123-131`, `:186-193`
- **Description**: `registerFont` returns early when the id is already registered, unless `replace` is set and the faces differ. Only live sync passes `replace` (`online/liveSync.ts:1364`); `registerSceneFonts` (every load from Drive, the shared viewer, agents' renders) does not. If the browser's library already holds another family whose name hashes to the same number, the scene's texts are measured and drawn with that other font, no error. The comment at `:128` ("another font had this number in this browser: the scene's own wins") describes only the live-sync path. `addFont` still stores the ignored font in the library, so which of the two wins after a reload depends on the IndexedDB key order.
- **Suggested fix**: In `registerFont`, treat "same id, different family" as a clash for every caller: let the scene's font win (as the comment says) or register it under a reassigned id via `fontWithId`, as live sync does.
- **Also in the Astra review**: F05, rated medium there. It adds: the names "Font 35" and "Font 48" both get the number 7116, and saving the second scene then writes the first scene's font data into it (`withFonts`).
- **Status**: fixed 2026-11-13

### B113. Notes popover stays open across a scene change
- **Area**: Browser: slides, rich text, comments
- **Severity**: low
- **Confidence**: likely (traced; needs a second scene with the same frame id, e.g. a clone)
- **Location**: `scenes-plugin/src/notes.tsx:207-285` (effect on `[id]` only), `:289-343`
- **Description**: The popover closes on Escape, an outside pointer press or presenting, but not when the open scene changes (the comments layer does this: `comments/ui.tsx:735-737`). A switch without a pointer press (browser back / forward, an agent's `open_scene`) to a scene that has a frame with the same id (a cloned deck) keeps the editor mounted with the first scene's notes; the next keystroke saves them into the other scene's slide.
- **Suggested fix**: Close the notes (`slideNotes.close()`) when `scenesController`'s `current` changes, as `CommentsLayer` does.
- **Status**: fixed 2026-11-13

### B114. Pasted web pages' `data-*` attributes are read as the editor's own formatting
- **Area**: Browser: slides, rich text, comments
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/richText/dom.ts:44-66` (`hasData` and `applyDataMarks` run for `external: true` too), `:31-42`
- **Description**: The editor's spans carry their marks as `data-b`, `data-i`, `data-u`, `data-s`, `data-c`, `data-h`, `data-a`, `data-z`, `data-n`. `marksFrom` applies them for pasted HTML as well, and `applyDataMarks` removes every mark that is not present. Short `data-` names like these exist on ordinary web pages: an element with `data-s="…"` pastes as strikethrough and loses its link, bold and italic; `data-z="3"` triples the size. Values are still checked by `normalizeDoc`, so this is wrong formatting, not an injection.
- **Suggested fix**: Read the data marks only when `!external` (the editor's own copies already travel in the `application/x-excalidraw-rich-text` clipboard type).
- **Status**: fixed 2026-11-13

### B115. Pending formatting is lost with an input method (IME)
- **Area**: Browser: slides, rich text, comments
- **Severity**: low
- **Confidence**: likely (traced; not tried with an IME)
- **Location**: `scenes-plugin/src/richText/editor.ts:589-593`, `:618-629`, `:631-643`
- **Description**: ⌘B with nothing selected stores `pending` marks, applied by intercepting `beforeinput` of type `insertText`. Composed text arrives as `insertCompositionText`, is typed by the browser into the neighbouring span and read back by `sync()` after `compositionend`, so Japanese, Chinese or Korean text typed after ⌘B (or after picking a colour) is not bold; `pending` is not cleared either and applies to the next Latin keystroke at that position.
- **Suggested fix**: On `compositionend`, if `pending` is set, apply its marks to the range that was composed (position before the composition to the caret) and clear it.
- **Status**: fixed 2026-11-13

### B116. Contact sheet of a scene without slides fails with a TypeError
- **Area**: Browser: slides, rich text, comments
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/render.ts:81-98`
- **Description**: `sheet: "all"` on a scene that has elements but no frames gives `tiles = []`; `cols` is 0, `tileWidth` is `Infinity` and `tiles[0].frame` throws "Cannot read properties of undefined". The agent gets that text instead of "the scene has no slides".
- **Suggested fix**: Throw a clear error when `tiles.length === 0` (as `slidesHtml` does for `frames`).

## Code smells

### S7. Five per-frame polling loops, two of them always running
- **Area**: Browser: slides, rich text, comments
- **Severity**: medium
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/comments/ui.tsx:647-677` (`usePinSpots`), `scenes-plugin/src/notes.tsx:62-99` (`useNameSpots`), `:114-144` (`HiddenVeils`), `scenes-plugin/src/present.tsx:454-480` (`useSlideRect`), `scenes-plugin/src/richText/toolbar.ts:481-488`; related: `scenes-plugin/src/deck.ts:311-327`, `:223-243`
- **Description**: Positions that follow the canvas are found by polling in `requestAnimationFrame`. `usePinSpots` runs for every user all the time (the layer is always mounted, also while presenting and with no comments) and builds `new Map(api.getSceneElementsIncludingDeleted().map(…))` 60 times a second: for a scene with 5,000 elements that is 300,000 map entries per second of garbage while the app is idle. `useNameSpots` runs whenever a deck is open and does one `querySelector` with an attribute-suffix selector plus one `getBoundingClientRect` per slide per frame (forced layout). `runTemplateSync` re-arms its 300 ms timer for as long as the canvas is in view mode (the whole time in the shared viewer). `Deck.onChange` builds a key over all elements on every Excalidraw change, which includes scrolling and pointer moves.
- **Suggested fix**: Return early from `usePinSpots` when there are no threads and no draft, and build the element map only for the pinned ids. Drive the others from `api.onScrollChange` / `api.onChange` (plus a `ResizeObserver`) instead of every frame, or at least skip the work when scroll, zoom and the scene version are unchanged. In view mode, stop the sync timer and restart it from `onChange`.
- **Also in the Astra review**: F43.
- **Status**: fixed 2026-11-13

### S36. Online PDF export uses an exception as its normal path and hides server errors
- **Area**: Browser: slides, rich text, comments
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/pdfExport.ts:212-230`, `scenes-plugin/src/slidesUI.tsx:120-130`
- **Description**: On kurviq.com `printToPdf` always throws; the caller shows "Printing PDF…", catches, logs `console.warn("PDF via scenes server failed…")` on every export and opens the print dialog. The same catch swallows real failures of the local server: the message `printToPdf` reads from the response (`:223-227`) never reaches the user, who gets a print dialog without a reason.
- **Suggested fix**: Branch on `IS_ONLINE` in `exportPdf` (no throw, no warning); in the local install, fall back only for "no server / no Chrome" and show other errors in the panel's error line.
- **Status**: fixed 2026-11-13

### S37. Comments and doc comments that no longer match the code
- **Area**: Browser: slides, rich text, comments
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `scenes-plugin/src/deck.ts:70-71`; `scenes-plugin/src/slides.ts:1049-1058`; `scenes-plugin/src/notes.tsx:158-159`; `scenes-plugin/src/richText/editor.ts:255-260`, `:522-530`; `scenes-plugin/src/render.ts:174`, `:203`, `:225`
- **Description**: `deck.ts:70` describes "the slides at the last change: ids, and whether they were Kurviq's grid" above `lastTemplateKey`, a number (the field it described is gone). In `slides.ts` the doc comment of `addTitleBlock` sits above `remeasureTitleBlock`, 110 lines away from its function. `notes.tsx:158` ("the slide in the slide list") and `editor.ts:255` are leftover first lines above another comment. `historyShortcut` in the editor also handles the size shortcuts. In `render.ts`, `renderSlide`, `renderFocus` and `renderSource` render nothing (they pick the slide, the focus box and the source), and `renderSlide` has the same name as the exported function in `slides.ts` that does render.
- **Suggested fix**: Remove or move the comments; rename to `pickSlide`, `focusBounds`, `sceneSource`, `sizeOrHistoryShortcut`.
- **Status**: partly fixed 2026-11-13: deck.ts, slides.ts, notes.tsx, editor.ts (`sizeOrHistoryShortcut`) done; the renames in `render.ts` (`pickSlide`, `focusBounds`, `sceneSource`) are left for its owner

### S38. Removing a thread closes the popover before a failed save can be shown
- **Area**: Browser: slides, rich text, comments
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-plugin/src/comments/ui.tsx:527-533`
- **Description**: `removeThread` calls `save` for each comment and then always `setUi({ open: null })`. If the scene cannot be saved now (`commentStore.change` returns false), `setError` is set on a component that unmounts in the same tick: the thread stays and the user sees no reason. A partial failure leaves half of the thread deleted.
- **Suggested fix**: Close only when every `save` returned true; send the deletions as one change if the writer allows it.
- **Status**: fixed 2026-11-13

### S39. Mentions in the shared viewer come from the editor's open scene
- **Area**: Browser: slides, rich text, comments
- **Severity**: low
- **Confidence**: likely (the viewer keeps the controller's `current`; not run)
- **Location**: `scenes-plugin/src/comments/ui.tsx:235-257`
- **Description**: `usePeople` reads the Drive permissions of `scenesController`'s current scene. While the shared viewer shows another scene, the @mention list offers the names of the people the user's own open scene is shared with, who may have no access to the viewed scene.
- **Suggested fix**: In the viewer slot use the viewed file's id (or only the thread's authors).
- **Also in the Astra review**: F44.
- **Status**: fixed 2026-11-13

## Dead code

### D29. `markdownOfElement` in the plugin is unused
- **Area**: Browser: slides, rich text, comments
- **Severity**: low
- **Confidence**: confirmed (repo-wide search: only `scenes-mcp/richText.mjs`'s function of the same name is imported)
- **Location**: `scenes-plugin/src/richText/agent.ts:55-59`
- **Description**: Nothing imports it; the MCP tools use their own copy. `fromMarkdown` (`:12`) is exported but used only inside the file.
- **Suggested fix**: Delete the function; drop the `export` on `fromMarkdown`.
- **Status**: fixed 2026-11-13

### D30. `runTemplateSync`'s `reset` option is never passed
- **Area**: Browser: slides, rich text, comments
- **Severity**: low
- **Confidence**: confirmed (the only caller is `scheduleTemplateSync`, without arguments; resets go through `resetToTemplate` in `slidesUI.tsx:89-94`)
- **Location**: `scenes-plugin/src/deck.ts:311-377` (`:318`, `:353`, `:368`, `:372-373`)
- **Description**: The parameter and its three branches (skip the "user is busy" check, ignore the key, capture as an undoable action) cannot be reached.
- **Suggested fix**: Remove the parameter and the branches.
- **Status**: fixed 2026-11-13

### D31. The slide sidebar's `online` tab flag is never set
- **Area**: Browser: slides, rich text, comments
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `scenes-plugin/src/slidesUI.tsx:883` (`online?: boolean`), `:946`, import of `IS_ONLINE` at `:13`
- **Description**: No entry of `TABS` sets `online`, so the filter always keeps all four tabs and the `IS_ONLINE` import serves nothing else in this file.
- **Suggested fix**: Remove the field, the filter and the import.
- **Also in the Astra review**: F52.
- **Status**: fixed 2026-11-13

### D32. Debug globals `window.__deck` and `window.__presenter`
- **Area**: Browser: slides, rich text, comments
- **Severity**: low
- **Confidence**: confirmed (no reference in `scenes-plugin`, `online`, `scenes-mcp`, `scenes-server`, `scripts`, tests and e2e scripts included)
- **Location**: `scenes-plugin/src/deck.ts:423`, `scenes-plugin/src/present.tsx:684`
- **Description**: Both singletons are put on `window` in production with no user in the repo; they hand every script on the page the editor API (`deck.getApi()`).
- **Suggested fix**: Remove them, or set them only in dev builds.
- **Status**: fixed 2026-11-13

### D33. Unused selectors and an ineffective tooltip prefix
- **Area**: Browser: slides, rich text, comments
- **Severity**: low
- **Confidence**: confirmed (searched all `.ts` / `.tsx` under `scenes-plugin/src`, `vite.config.mts`, `online/worker`)
- **Location**: `scenes-plugin/src/slides.scss:328-331` (`.slides-notes`), `:741-746` (`.public-scene__count`); `scenes-plugin/src/titleTips.ts:8` (`"pv"`), `:33-40`
- **Description**: No component uses the two classes (`.slides-notes` is from the former notes textarea; the other selectors the search flagged are Excalidraw's own classes and are used). In `titleTips.ts` the `pv` prefix can never match: `pv…` classes exist only in the presenter window's document, and the listeners are installed on the main `document` only; the `el.ownerDocument` handling in `show` is for the same case that cannot occur.
- **Suggested fix**: Delete the two rules; drop `"pv"` (or install the listeners on the presenter window too, if tooltips are wanted there).
- **Status**: fixed 2026-11-13

## Duplications

### U5. Three resolvers for "which slide does this reference name"
- **Area**: Browser: slides, rich text, comments
- **Severity**: medium
- **Confidence**: confirmed
- **Location**: `scenes-plugin/src/slides.ts:121-129` (`slideFrame`), `scenes-plugin/src/pdfExport.ts:23-32` (`slidesForPart`), `scenes-plugin/src/render.ts:174-189`
- **Description**: Each turns a number, a numeric string, a frame id (and in one case `"template"` or a range) into a frame, with different rules: `slides.ts` and `pdfExport.ts` accept `"3"` as slide 3, `render.ts` treats it as a frame id and answers `No frame with id "3"`; `render.ts` accepts any frame including the template, `pdfExport.ts` only slides; error texts differ. An agent that passes the same `slide` value to `edit_scene` and `view_scene` gets different results.
- **Suggested fix**: One `resolveSlide(ref, elements, { template?, ranges? })` in `slides.ts`, used by all three.
- **Status**: partly fixed 2026-11-13: `resolveSlide(ref, elements, { template, ranges, anyFrame })` in slides.ts, used by `placeOnSlides` and `pickSlides` (pdfExport.ts); `render.ts` still has its own lookup and should use it

### U35. Appending a top-level field to serialized scene JSON by string surgery, twice
- **Area**: Browser: slides, rich text, comments
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `scenes-plugin/src/fonts.ts:227-234` (`withFonts`), `scenes-mcp/sceneComments.mjs:244-251` (`withComments`); chained at `scenes-plugin/src/controller.ts:1485`, `cowork.ts:969`, `:1036`, `:1111`, `online/liveSync.ts:3222`
- **Description**: Both cut the string at its last `}` and paste `,\n  "kurviqX": …\n}`. The two copies already differ (`withComments` trims before testing for `}`, `withFonts` does not), and both produce invalid JSON for `{}`.
- **Suggested fix**: One helper `withTopLevelField(json, name, value)` in a shared module, used by both.
- **Update 2026-11-13 (specs)**: The live sync copy goes; `fonts.ts`, `controller.ts`, `cowork.ts` and `sceneComments.mjs` remain.
- **Status**: fixed 2026-11-13

### U36. The same small logic in several of the slide files
- **Area**: Browser: slides, rich text, comments
- **Severity**: low
- **Confidence**: confirmed
- **Location**: last click step of a slide: `scenes-plugin/src/deck.ts:248-254`, `scenes-plugin/src/present.tsx:92-100`, `scenes-plugin/src/render.ts:60-61`, `scenes-plugin/src/deckCheck.ts:390-396`; a slide's elements up to a step: `render.ts:108-112`, `:192-197`; slide title: `deck.ts:260` vs `slides.ts:162` (`slideTitle`); a slide rendered to a canvas: `slides.ts:1253-1266` vs `render.ts:113-120`; placeholder pattern: `slides.ts:274` vs `deckCheck.ts:380`; slide size: `slides.ts:85-86` vs the literals `1920` / `1080` in `deckCheck.ts:436-437`; `loadImage`: `deckCheck.ts:85-102` vs `pdfExport.ts:67-73`; `escapeHtml`: `pdfExport.ts:19-20` vs `richText/layout.ts:38-39` (identical); scene name fallback `?? "Untitled"`: `deck.ts:220`, `slidesUI.tsx:90`, `:104`, `templateChanges.tsx:69`
- **Description**: The step count is computed in four places, two with `elementStep` (a label follows its shape) and two with the raw `step`; they agree today only because the maximum is the same. The others are verbatim or near-verbatim copies.
- **Suggested fix**: Export `slideSteps(elements, frame)`, `elementsAtStep(elements, frame, step)`, `PLACEHOLDER_RE` and `deckName()` from `slides.ts` / `deck.ts` and use them; use `slideTitle`, `SLIDE_WIDTH` / `SLIDE_HEIGHT` and `renderSlide` where the copies are.
- **Status**: partly fixed 2026-11-13: `slideSteps`, `elementsAtStep`, `PLACEHOLDER_RE`, `deckName()` exported and used in deck.ts, present.tsx, deckCheck.ts, slidesUI.tsx, templateChanges.tsx; `slideTitle`, `SLIDE_WIDTH` / `SLIDE_HEIGHT`, one `loadImage` (pdfExport.ts) and one `escapeHtml` (richText/layout.ts) used; the copies in `render.ts` (steps, elements up to a step, slide canvas) are left for its owner

### U37. Rich text constants repeated instead of imported
- **Area**: Browser: slides, rich text, comments
- **Severity**: low
- **Confidence**: confirmed
- **Location**: mark keys: `scenes-plugin/src/richText/dom.ts:47`, `richText/layout.ts:65` vs `MARK_KEYS` in `scenes-mcp/richDoc.mjs:13`; heading sizes: `dom.ts:13` vs `model.ts:393`; size steps: `editor.ts:78` (`SIZE_STEPS`) vs `toolbar.ts:40` (`SIZES`, the same list without 8); `isMac`: `editor.ts:45` vs `toolbar.ts:12`; list marker and checkbox CSS: `present.tsx:676-679` (`PRESENTER_CSS`) vs `richText/richText.scss`
- **Description**: A new mark key or size step has to be added in two or three places; the presenter view's copy of the checklist CSS will drift from the editor's.
- **Suggested fix**: Import `MARK_KEYS`; export one size list, one heading-size table and `isMac`; build `PRESENTER_CSS` from the compiled rich text rules (or import the SCSS as a string for the presenter window).
- **Status**: fixed 2026-11-13

### U38. Seven hand-written external stores
- **Area**: Browser: slides, rich text, comments
- **Severity**: low
- **Confidence**: confirmed
- **Location**: `scenes-plugin/src/notes.tsx:34-54`, `scenes-plugin/src/fontsUI.tsx:14-29`, `scenes-plugin/src/comments/ui.tsx:44-59`, `scenes-plugin/src/slidesUI.tsx:816-832`, `scenes-plugin/src/deck.ts:68-101`, `scenes-plugin/src/present.tsx:56-77`, `scenes-plugin/src/fonts.ts:63-78`
- **Description**: Each repeats "value + `Set` of listeners + `subscribe` returning an unsubscribe + a `useSyncExternalStore` hook" (about 15 lines each).
- **Suggested fix**: One `createStore<T>(initial)` returning `{ get, set, subscribe, use }`.
- **Status**: fixed 2026-11-13

## Over-engineering

### O13. Migration code for old deck formats runs on every template sync
- **Area**: Browser: slides, rich text, comments
- **Severity**: low
- **Confidence**: uncertain (I could not check whether any stored deck still has the old fields)
- **Location**: `scenes-plugin/src/slides.ts:175-234` (`signature`, `legacyOverridden`, `baseOf` for copies with `sig` / `rel`), `:353-368` (`fromLayouts`, "the short-lived layouts version"), `:388` (`placeholder`), `:45-58`, `:111-115` (theme text style of "older decks")
- **Description**: About 90 lines and four `SlideData` fields (`sig`, `rel`, and the untyped `ph`, `empty`, `placeholder`) exist only for decks written by earlier versions, one of them described as short-lived. `fromLayouts` maps over every element on every sync, and every reader of the sync has to understand two generations of "changed by hand".
- **Suggested fix**: Check the stored scenes for `customData.slides.sig`, `.ph` and `.placeholder`; if none are left (or after a one-time migration on load), delete these paths.
