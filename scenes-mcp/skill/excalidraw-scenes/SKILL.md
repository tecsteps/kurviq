---
name: excalidraw-scenes
description: Draw, co-edit, look at and save diagrams in the user's local Kurviq / Excalidraw (git-backed scenes, MCP server "excalidraw"). Use whenever the user asks to draw or change a diagram/sketch/scene in Excalidraw, wants to co-work on a drawing, asks what is on their canvas, or mentions Excalidraw scenes.
---

# Kurviq (local): how to work with the user's drawings

The user runs Kurviq, a local Excalidraw app (http://draw.test), with **scenes**
(named drawings, URL `http://draw.test/<scene>`) synced to a GitHub repo.
The MCP server `excalidraw` gives you tools for it. The user is often
**looking at the app while you work** and edits by hand in between.

**You have your own Excalidraw.** You never work in the user's browser: you
read and edit scenes in a hidden headless Excalidraw, and every edit is
committed to GitHub right away. The user's app picks your commits up within
seconds and merges them with what they are doing. Before you read or edit a
scene, the user's app pushes its unpushed changes of it, so you see their
latest work.

## Golden rules

1. **Always `read_scene` before you edit.** It reports what the user
   changed since an agent last edited the scene (`userChanges`), found in the
   git history, so it works across conversations and agents.
2. **Edit with `edit_scene`**, not by re-creating the scene. It changes only
   the elements you name; the user's other work is untouched. Pass the
   `revision` from your last `read_scene` / `edit_scene` as `basedOn`.
3. **Look at the result.** `edit_scene` returns an image of what you
   changed. Use `view_scene` whenever you need to see something; it returns a
   real PNG.
4. If `edit_scene` answers with a **WARNING**, the user changed the scene
   since your version. Your edit was applied on top anyway: check their
   changes (listed + image) and fix your edit if it clashes with them.
5. **Stick to the scene the user asked for.** If they say "this drawing",
   `app_status` tells you which scene they have open.
6. **Don't touch the user's view.** `open_scene` (and `open: true`) switches
   what the user sees: only when they ask you to show them something.
7. **Only these tools, never around them.** You never push, sync or write
   scene files yourself: `edit_scene` hands your change to your headless
   Excalidraw, which commits it; the user's app syncs their own work by
   itself (auto-sync). Never call the scenes server's HTTP API
   (localhost:3101) with curl or scripts, and never write `.excalidraw`
   files or git commits: direct writes are refused, and they would bypass
   merging and the user's unpushed work. If a tool can't do what you need,
   tell the user instead of working around it. Never overwrite an existing
   scene with `save_scene`. Conflicts: `get_conflict` / `resolve_conflict`.

## Co-working loop

```
read_scene("X", view: true)                    → what's there, what the user changed (+ image), revision r1
edit_scene("X", basedOn: r1, add / update / delete) → your change + image of it, revision r2
… user edits by hand, asks for more …
read_scene("X", since: r2, view: true)         → userChanges: exactly what they did since your edit (revision r3)
edit_scene("X", basedOn: r3, …)                → next change
```

`userChanges` lists `added`, `modified` (with `changedFields`, e.g. `["x","y"]`
= moved, `["text"]` = relabeled, `["backgroundColor"]` = recolored) and
`deleted` elements. "No earlier agent edit found" means everything is new to
you.

## Editing elements (`edit_scene`)

- `add`: JSON array string, same format as `create_view` (call `read_me` once
  for the format): shapes with `label: { text }`, arrows with
  `startBinding` / `endBinding: { elementId, fixedPoint }`; arrows may bind
  to existing shapes. Use new unique ids.
- `update`: `[{ "id": "...", ...props }]`: move (`x`, `y`), resize, recolor,
  change `text` of a text element (a shape's label is a text element with
  `containerId` = the shape id).
- `delete`: ids (a shape's label goes with it; a deleted slide frame takes
  everything on it along, template copies included, like in the editor).
- Layer order: `"zIndex": "front"` / `"back"` (above / below everything else
  on its slide) or `"above"` / `"below": "<element id>"`, in `update` or on
  added elements (e.g. a label added after a picture: `"zIndex": "front"`).
- Ids: ids of deleted elements can be used again. `upsert: true` lets `add`
  replace existing elements with the same id (instead of an error).
- Changing `fontFamily` / `fontSize` of a text measures it again. A free text
  with `width` is a box from `x` to `x + width`: its lines wrap at the width
  and `textAlign` aligns them inside (`"autoResize": true` instead: one line,
  aligned in that box).
- Retries are safe: every edit has a `requestId` (yours, or the one the
  result names). Sent again with the same `requestId`, an edit that already
  landed is not applied twice (`alreadyApplied` in the result). After a
  timeout, retry with the same `requestId`; `app_status` → `health` shows
  whether the user's app is busy.
- Label an existing shape: add `{ "type": "text", "id": "...", "text": "...",
  "containerId": "<shape id>" }`; it is centered automatically.
- Labels (`label: { text, strokeColor, fontSize, … }`) are dark (#1e1e1e)
  unless you set `strokeColor`, their id is `<shape id>-label`, and a shape
  grows so that no word of its label is broken.
- **Images and icons:** add `{ "type": "image", "id": "...", "x": 0, "y": 0,
  "width": 48 }` plus one of `"src"` (absolute file path, http(s) URL or data
  URL), `"svg"` (inline SVG markup) or `"icon"` (`"lucide:database"`,
  `"simple-icons:github"`, tinted with `"color"`). Works in `edit_scene` and
  `save_scene`; `create_view` drafts can't hold images.
- **ER diagrams:** arrows take crow's-foot heads: `startArrowhead` /
  `endArrowhead` = `cardinality_one`, `cardinality_many`,
  `cardinality_one_or_many`, `cardinality_exactly_one`,
  `cardinality_zero_or_one`, `cardinality_zero_or_many`. Tables are plain
  rectangles with a text label.
- **Big edits:** write `{ "add": [...], "update": [...], "delete": [...] }` to
  a JSON file and pass `file: "/abs/path.json"` (`save_scene`:
  `elementsFile`) instead of pasting it into the call.

## Limits

- Per call: at most 20 images fetched (`src` / `icon`; uploaded `fileId`s
  don't count), 200 items in `measure_text`.
- Selections return at most 150 elements; change reports give details for
  25 elements per kind, the rest as ids.
- Slide numbers (`"slide": 3`, `view_scene(slide: 3)`) count in deck order
  as it is at that moment, after the deletions of the same edit: they shift
  when slides are deleted, added or moved. Address slides by frame id
  (`"slide": "s12"`) in edits; the result's `slideNumbers` says which frame
  each number hit.
- Coordinates: `read_scene` gives scene coordinates; with `relative: true`,
  elements on a slide get `x` / `y` from the slide's corner plus
  `"slide": "<frame id>"`, the form edits take. `read_scene(name, slide: 3)`
  gives one slide's elements.

## Formatted text (bold, lists, colors in one text)

One text element (or a shape's label) can mix formatting: write `markdown`
instead of `text`, e.g. a title, a sentence and bullets in one box:

```json
{ "type": "text", "id": "t1", "x": 100, "y": 100, "fontSize": 28, "fontFamily": 6,
  "markdown": "# Quarterly plan\nWe focus on **three** things:\n- Ship the editor\n  - nested, {size=0.8}smaller{/}\n1. First\n2. Second\n[x] Done\n[ ] Open" }
```

- Lines: `# ` / `## ` / `### ` headings (bold, 1.6× / 1.3× / 1.1× size),
  `- ` bullets, `1. ` numbered, `[ ] ` / `[x] ` checklist; 2 spaces per
  nesting level. Inline: `**bold**`, `*italic*`, `__underline__`,
  `~~strike~~`, `[text](https://…)`, and
  `{color=#e03131 highlight=#ffec99 size=0.8}text{/}` (size relative to the
  element's `fontSize`). Escape a literal `*` etc. with `\`.
- Labels: `label: { "markdown": "**Title**\n- point" }`. List items are
  left-aligned in centered text; the rest keeps `textAlign`.
- Edit with `update: [{ "id": "t1", "markdown": "…" }]` or
  `{ "id": "<shape>", "label": { "markdown": "…" } }`. A plain `text` update
  drops the formatting.
- A wrapping text box: `"width": 800, "autoResize": false` (lines wrap at
  800px; `x` is its left edge).
- Reading a scene shows formatted texts with `markdown` next to `text` (the
  plain words, list markers included). `measure_text` takes `markdown` too.
- The user formats text in the app with a toolbar above the text being
  edited, or the usual shortcuts (⌘B, ⌘I, ⌘U, ⌘⇧X, ⌘⇧7/8/9 lists, ⌘K link).

## Seeing scenes (they can be huge)

- `view_scene(name)`: a scene, incl. the user's latest pushed edits;
  `view_scene(checkpointId)`: a `create_view` draft.
- Zoom: `elementIds: [...]` (those elements + padding + whatever overlaps) or
  `region: {x, y, width, height}`; `maxSize` caps the image size.
- Big scenes: `read_scene(name, summary: true)` / `get_scene(name, summary: true)`
  give an overview (bounds, counts, frames, text labels with positions, 100
  per page: `textsOffset` for more) to find the right region first.
  Selections return at most 150 elements; change reports give details for
  25 elements per kind and ids for the rest.

## New scenes and managing scenes

- New drawing: `read_me` → `create_view` → `view_scene(checkpointId)` →
  `save_scene(name, checkpointId)`. `save_scene` refuses existing scenes
  (change those with `edit_scene`); `replace: true` only when the user
  explicitly wants the whole scene replaced by a new drawing.
- `rename_scene(name, newName)`, `clone_scene(name, newName)`,
  `delete_scene(name)`: one commit on GitHub; the user's app follows (their
  unpushed changes are pushed first and move along). **Only delete when the
  user asked for exactly that scene** (it stays in the git history; a
  local-only scene has no other copy).
- `list_scenes` lists the scenes on GitHub. `app_status`: which scene the
  user has open, and each scene's sync status in their app: synced · ahead
  (not pushed) · behind (newer on GitHub) · diverged · conflict · local (not
  on GitHub) · "auto-sync off" (the user pushes when they decide; you don't
  see their unpushed changes of such a scene).

## Slides (presentations)

Every frame of a scene is a slide; the user presents with the "Slides" button
(fullscreen, laser, presenter view, PDF). Build decks with `save_scene` /
`edit_scene`:

- A slide: `{ "type": "frame", "id": "s1", "x": 100, "y": 100, "width": 1920,
  "height": 1080, "name": "Title", "children": [ids of its elements],
  "customData": { "slides": { "order": 0, "notes": "speaker notes" } } }`.
  Elements added later to a slide get `"frameId": "s1"`. Lay slides out in a
  row with a gap (e.g. 240) and keep everything inside its frame.
- Slide-relative placement: give an element `"slide": 3` (number in deck
  order, a frame id, or `"template"`) and its `x` / `y` count from that
  slide's top-left corner; it becomes part of the slide. Works in
  `save_scene` and in `edit_scene` (`add` and `update`).
- In the slide frame's `customData.slides`: `"skip": true` hides a slide
  while presenting; `"template": false` turns the template off for that
  slide (title slides).
- Click-by-click reveals: `"customData": { "slides": { "step": 1 } }` on
  elements (1, 2, 3 …; a shape's label follows its shape).
- Template: one frame with `"customData": { "slides": { "role": "template",
  "theme": { "fontFamily": 5, "titleSize": 72, "bodySize": 36, "textColor":
  "#1e1e1e", "strokeColor": "#1e1e1e", "roughness": 1, "strokeWidth": 2,
  "fillStyle": "solid", "transition": "glide" } } }`. Its elements (header,
  footer, logo, background) are copied onto every slide when you save or
  edit the deck (and by the user's app). Template texts may use
  placeholders: `{page}` (slide number), `{total}` (number of slides),
  `{title}` (the slide frame's name), `{deck}` (the scene name), `{date}`
  (today, in the viewer's locale). They are filled in only in template
  elements. Never edit the copies (ids `<element>~<slide>`); change the
  template instead.
- Text alignment: give a text `width` and it becomes a box from `x` to
  `x + width`: lines wrap at the width and `textAlign` (left, center, right)
  aligns them inside it (e.g. a caption centered under a shape, a paragraph).
  Without `width`, `x` is the left edge, the center or the right edge,
  following `textAlign`.
- Closed, filled lines (area charts, outlines): `"type": "line"` with the
  last point equal to the first, `"polygon": true` and a `backgroundColor`.
- Fonts: besides Excalidraw's own (`fontFamily` 5 Excalifont, 6 Nunito,
  7 Lilita One, 8 Comic Shanns, 2 Helvetica, 3 Cascadia), any font from
  Google Fonts works by its exact name, e.g. `"fontFamily": "Inter"` (also
  in labels and the deck theme): the app fetches it on first use and the
  font travels with the scene. `add_font("Inter")` adds one ahead (e.g.
  before `measure_text`). `app_status` lists the added fonts as
  `customFonts`. Font files (not on Google Fonts) are added by the user:
  font picker → "Add font…" → Font file.
- Theme: in a deck, text (and labels) without `fontFamily` / `strokeColor`
  get the theme's font and text color, and follow when the theme changes.
  Use the theme's `titleSize` / `bodySize` for titles and body. Change the
  deck style by updating the template frame's `customData.slides.theme`:
  elements that still have the old theme's values follow; with
  `restyle: true` on that edit (or any edit), every slide element takes the
  theme's font, colors, roughness and stroke, also where they were set by
  hand (font sizes stay).
- A neutral, modern look (instead of the hand-drawn default): theme
  `{ "fontFamily": "Inter", "textColor": "#111827", "strokeColor": "#334155",
  "roughness": 0, "strokeWidth": 2, "fillStyle": "solid", "titleSize": 72,
  "bodySize": 36 }`, white or `#f8fafc` slides, one accent color (e.g.
  `#2563eb`), fills like `#e0e7ff` / `#f1f5f9`, and `"roughness": 0` on
  shapes. Excalidraw's palette in `read_me` is hand-drawn-sketch style.
  Make slides visual: shapes, arrows, icons, sticky notes (`"type":
  "stickynote"` with `label`), crow's-foot ER diagrams, hand-drawn charts;
  not just bullet text.
- Sticky notes show their creation date in the bottom-right corner (e.g.
  "21 Oct"). Pass `"created": null` to leave it out (cleaner on slides).
- Arrows that should route around boxes at right angles: `"elbowed": true`
  (with `startBinding` / `endBinding`).
- Text padding of a shape (distance of its label from the border):
  `"customData": { "textPadding": 20 }` (default 5).
- Changing a deck with `edit_scene` works like the editor: moving or
  resizing a shape moves its label and the arrows bound to it; moving a
  slide frame moves everything on it; `{ "id": "box", "label": { "text":
  "New" } }` changes (or adds) a shape's label, which is re-wrapped and the
  shape grows to fit.
- Check your work: `validate_deck(name)` lists the slides and finds cut-off,
  overlapping, overflowing, too small or low-contrast text, elements not
  part of their slide, broken click steps and missing notes.
  `view_scene(name, slide: 3)` shows slide 3 exactly as presented (template
  included); add `step: 1` to see it after the first click. Text on a
  picture is checked against the picture's colors under it. Intended
  findings can be silenced on the element: `"customData": { "slides":
  { "ignore": ["clipped", "overlap"] } }` (finding kinds, or `true`).
  `view_scene(name, slides: "all")` shows the whole deck in one image
  (`steps: true`: every click state).
- `measure_text(items)` tells you how wide and tall text will be (and how it
  wraps at `maxWidth`) before you place it: size boxes and cells with it.
- PDF: `export_pdf(name)` (all slides, or `slides: [1, 3]`) writes a PDF
  with real, selectable text.

## Local-only scenes

Some scenes are **local only**: they live only in the user's browser and are
never pushed to or pulled from GitHub (e.g. confidential customer work). The
user picks this per scene; `app_status` / `list_scenes` mark them.

- `read_scene`, `edit_scene`, `view_scene`, `get_scene`, rename, clone and
  delete work on them as usual, through the user's app, which must be open.
  They answer with a "Local-only scene" note; no GitHub commit happens.
- New local-only scene: `save_scene(name, …, local: true)`, only when the
  user asks for a local / private / not-synced scene.
- `set_local_only(name, localOnly)`: make a scene local only, or sync it
  with GitHub again. Only when the user asks.

## Merge conflicts

By default the user's app settles clashes by itself (the same element
changed on both sides: the newer edit wins), so conflicts are rare. If the
user switched that off and the local and GitHub versions changed the **same
elements** differently, the scene is in **conflict** in the user's app
(shown in its sidebar, in `app_status` and in `read_scene`'s `sync`). Their
newest edits of that scene don't reach GitHub until it is resolved. Changes
that only one side made are merged automatically.

1. `get_conflict(name, view: true)`: per clashing element the base,
   **mine** (the user's local version) and **github** version, which fields
   each side changed, plus images of both versions of the clashing area.
2. `resolve_conflict(name, resolution: "merge", choices: {id: "mine" |
   "github"}, otherwise: "mine" | "github")`: keeps both sides' other
   changes and decides each clash, then pushes. Alternatives: `"mine"`
   (user's whole version overwrites GitHub), `"github"` (discard the
   user's local changes), `"both"` (GitHub's version, user's kept as a
   copy scene).

When it's not obvious which version is right, show the user the
differences and ask. Never silently throw away the user's work.

## Where things are stored

Nothing is stored by the servers: scenes live in the user's browser
(localStorage / IndexedDB) and in the GitHub repo. Your edits are git
commits, marked as agent commits; that is how `userChanges` finds your last
version. Your `create_view` drafts live in your headless Excalidraw and are
gone when it stops.

## Live mode (only if your tools are `read_open_scene` / `edit_open_scene`)

The user can switch to live mode (`SCENES_AGENT_MODE=live`). Then you work
directly in their open browser tab: `read_open_scene(scene: "X")` instead of
`read_scene`, `edit_open_scene(expectScene: "X", …)` instead of
`edit_scene`. These act on the canvas the user sees (incl. their unsaved
edits, undoable with Cmd/Ctrl+Z), and the app's auto-sync pushes the
result. Don't push yourself; `save_open_scene` only when the user asks to
push now.

## Troubleshooting

- "Scenes server not reachable": the user runs `npm start` in the project
  folder (kurviq).
- "No Chrome found": your headless Excalidraw needs Chrome or another
  Chromium browser (`CHROME_PATH` in `.env`).
