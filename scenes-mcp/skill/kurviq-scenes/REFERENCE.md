# Kurviq element reference

How to write elements for `edit_scene`, `save_scene` and `create_view`
(`read_me`; one call per conversation). How to work with the user's scenes
(reading first, conflicts, sharing) is in the server instructions.

## Elements

Every element: `type`, a unique `id`, `x`, `y`; shapes also `width`,
`height`. Defaults (leave them out): `strokeColor` #1e1e1e,
`backgroundColor` transparent, `fillStyle` solid, `strokeWidth` 2,
`roughness` 1 (hand-drawn; 0 = clean lines), `opacity` 100, `strokeStyle`
solid (or `"dashed"` / `"dotted"`). Array order is
layer order (first = back).

- **Shapes:** `rectangle`, `ellipse`, `diamond`. Rounded corners
  `"roundness": { "type": 3 }`, fill `"backgroundColor": "#a5d8ff"`.
- **Labels** (better than a separate text): `"label": { "text": "Hello",
  "fontSize": 20 }` on a shape or an arrow. Centered; the shape grows so that
  no word breaks; dark (#1e1e1e) unless `strokeColor`; its id is
  `<shape id>-label`. Distance from the border: `"customData": {
  "textPadding": 20 }` (default 5). Label an existing shape: add
  `{ "type": "text", "id": "...", "text": "...", "containerId": "<shape id>" }`.
- **Text:** `{ "type": "text", "id": "t1", "x": 100, "y": 100, "text":
  "Hello", "fontSize": 20 }`. Without `width`, `x` is the left edge (the
  center or right edge with `textAlign` center / right). With `"width": 800`
  it is a box from `x` to `x + width`: lines wrap at the width and
  `textAlign` aligns them inside (a caption centered under a shape, a
  paragraph; it widens to its longest word); `"autoResize": true` instead
  keeps one line, aligned in that box. `measure_text(items)` tells you the
  exact size (and wrapping at `maxWidth`) before you place it. No emoji: the
  fonts don't have them.
- **Fonts:** `fontFamily` 5 Excalifont (hand-drawn), 1 Virgil, 6 Nunito, 7 Lilita One,
  8 Comic Shanns, 2 Helvetica, 3 Cascadia, or any Google Fonts family by its
  exact name (`"fontFamily": "Inter"`, also in labels): fetched on first use,
  it travels with the scene. `add_font("Inter")` adds one ahead (e.g. before
  `measure_text`); `app_status` lists them as `customFonts`. Font files not on
  Google Fonts are added by the user (font picker → "Add font…").
- **Arrows:** `{ "type": "arrow", "id": "a1", "x": 300, "y": 150, "points":
  [[0,0],[200,0]], "endArrowhead": "arrow" }`: points are offsets from
  `x` / `y`. Heads (`startArrowhead` / `endArrowhead`): null, arrow, bar, dot,
  triangle, and crow's feet for ER diagrams: `cardinality_one`,
  `cardinality_many`, `cardinality_one_or_many`, `cardinality_exactly_one`,
  `cardinality_zero_or_one`, `cardinality_zero_or_many` (tables: rectangles
  with a label). Attach: `"startBinding"` / `"endBinding": { "elementId":
  "r1", "fixedPoint": [1, 0.5] }` (top [0.5, 0], bottom [0.5, 1], left
  [0, 0.5], right [1, 0.5]); they may bind to existing shapes. `"elbowed":
  true` routes around boxes at right angles. Arrow labels need room: keep
  them short or the arrow long.
- **Lines:** `"type": "line"` with `points`. Closed and filled (area charts,
  outlines): last point equal to the first, `"polygon": true` and a
  `backgroundColor`.
- **Sticky notes:** `"type": "stickynote"` with a `label`. They show their
  creation date bottom right; `"created": null` leaves it out.
- **Images and icons:** `{ "type": "image", "id": "...", "x": 0, "y": 0,
  "width": 48 }` plus one of `"src"` (absolute file path, http(s) URL or data
  URL), `"svg"` (inline SVG markup) or `"icon"` (`"lucide:database"`,
  `"simple-icons:github"`, tinted with `"color"`). `width` or `height` alone
  keeps the aspect ratio. Not in `create_view` drafts: add them when saving
  (`save_scene(name, checkpointId, elements: [images])`) or later with
  `edit_scene`. Size pictures before
  adding them: each one travels inside the scene file (Kurviq online: 30 MB
  per scene, stored at about 1.8× its size); about twice the shown size is
  plenty, WebP (keeps transparency) or JPEG beats PNG. Kurviq keeps them as
  you add them. Local file paths must lie inside the folder the MCP server
  was started in; each picture from `src` / `svg` / `icon` is at most 5 MB.

```json
[{ "type": "rectangle", "id": "b1", "x": 100, "y": 100, "width": 200, "height": 100, "roundness": { "type": 3 }, "backgroundColor": "#a5d8ff", "label": { "text": "Start" } },
 { "type": "rectangle", "id": "b2", "x": 450, "y": 100, "width": 200, "height": 100, "roundness": { "type": 3 }, "backgroundColor": "#b2f2bb", "label": { "text": "End" } },
 { "type": "arrow", "id": "a1", "x": 300, "y": 150, "points": [[0,0],[150,0]], "endArrowhead": "arrow",
   "startBinding": { "elementId": "b1", "fixedPoint": [1, 0.5] }, "endBinding": { "elementId": "b2", "fixedPoint": [0, 0.5] } }]
```

## Colors and readability

- Strokes and accents: blue #4a9eed, amber #f59e0b, green #22c55e, red
  #ef4444, purple #8b5cf6, pink #ec4899, cyan #06b6d4, lime #84cc16.
- Pastel fills: #a5d8ff blue (inputs, sources), #b2f2bb green (done,
  output), #ffd8a8 orange (pending, external), #d0bfff purple (processing),
  #ffc9c9 red (errors), #fff3bf yellow (notes, decisions), #c3fae8 teal
  (storage, data), #eebefa pink (metrics). Background zones with
  `"opacity": 30`: #dbe4ff (UI), #e5dbff (logic), #d3f9d8 (data).
- Contrast: text on white at least #757575 (never #999 or lighter); colored
  text on light fills in dark variants (#15803d, not #22c55e; #2563eb, not
  #4a9eed); white text only on dark fills.
- Sizes: text at least 16 (titles 20, small notes 14), labeled shapes at
  least 120×60, gaps of 20 to 30. On 1920×1080 slides: titles 72, body 36.
- Dark diagrams: a huge dark rectangle first (`"x": -4000, "y": -3000,
  "width": 10000, "height": 7500, "backgroundColor": "#1e1e2e",
  "strokeColor": "transparent"`); text #e5e5e5, muted #a0a0a0 (never #555 or
  darker); fills #1e3a5f blue, #1a4d2e green, #2d1b69 purple, #5c3d1a orange,
  #5c1a1a red, #1a4d4d teal; strokes in the accent colors.

## Editing (`edit_scene`)

- `add`: elements as above, new unique ids (ids of deleted elements may be
  used again; `upsert: true` replaces existing ones with the same id).
  `update`: `[{ "id": "...", ...props }]`: move, resize, recolor, change the
  `text` of a text element (a shape's label is a text element with
  `containerId` = the shape), or `{ "id": "box", "label": { "text": "New" } }`
  (re-wrapped, the shape grows). `delete`: ids (a label goes with its shape; a
  slide frame takes everything on it along).
- It works like the editor: moving or resizing a shape moves its label and
  the arrows bound to it; moving a slide frame moves everything on it;
  changing `fontFamily` / `fontSize` measures the text again.
- Layer order: `"zIndex": "front"` / `"back"` (on its slide) or `"above"` /
  `"below": "<element id>"`, in `update` or on added elements.
- Conflicts: an `update` of a property the user changed since `basedOn` comes
  back in `conflicts` instead of being applied (see the golden rule on WARNING and
  `edit_scene`'s description). Send only what you mean to change.
- Retries are safe: an edit sent again with the same `requestId` is never
  applied twice (`alreadyApplied`).
- **Big edits:** write `{ "add": [...], "update": [...], "delete": [...] }` to
  a JSON file and pass `file: "/abs/path.json"` (`save_scene`:
  `elementsFile`) instead of pasting it into the call.

## Limits

- Per call: at most 20 images fetched from the web (http(s) `src` or
  `icon`; files, inline SVG, data URLs and uploaded `fileId`s don't count),
  200 items in `measure_text`.
- Selections return at most 150 elements; change reports give details for
  25 elements per kind, the rest as ids.
- Slide numbers (`"slide": 3`, `view_scene(slide: 3)`) count from 1 in the
  current deck order and shift when slides are deleted, added or moved, also
  within one edit. In edits, address slides by frame id (`"slide": "s12"`),
  above all when the same edit deletes or moves slides.
- `read_scene` gives scene coordinates; with `relative: true`, elements on a
  slide get `x` / `y` from the slide's corner plus `"slide": "<frame id>"`, the
  form edits take.

## Formatted text (bold, lists, colors in one text)

Write `markdown` instead of `text` (also in labels: `label: { "markdown":
"**Title**\n- point" }`):

```json
{ "type": "text", "id": "t1", "x": 100, "y": 100, "fontSize": 28, "fontFamily": 6,
  "markdown": "# Quarterly plan\nWe focus on **three** things:\n- Ship the editor\n  - nested, {size=0.8}smaller{/}\n1. First\n[x] Done\n[ ] Open" }
```

- Lines: `# ` / `## ` / `### ` headings (bold, 1.6× / 1.3× / 1.1×), `- `
  bullets, `1. ` numbered, `[ ] ` / `[x] ` checklist, 2 spaces per nesting
  level. Inline: `**bold**`, `*italic*`, `__underline__`, `~~strike~~`,
  `[text](https://…)`, `{color=#e03131 highlight=#ffec99 size=0.8}text{/}`
  (size relative to `fontSize`); escape a literal `*` with `\`. In centered
  text, list items stay left-aligned.
- Replace with `update: [{ "id": "t1", "markdown": "…" }]` (a plain `text`
  update drops the formatting). Format part of a text without resending it,
  keeping the user's edits: `{ "id": "t1", "format": { "match": "A company
  transformation.", "color": "#1565c0", "bold": true } }` (`id`: the text or
  its shape). Keys: `bold`, `italic`, `underline`, `strike` (`false`
  removes), `color`, `highlight`, `size` (relative to `fontSize`), `link`
  (`null` removes each of these four); `occurrence`: n (from 1, default 1) or
  `"all"`; an array formats several phrases. `match` is the exact text without
  list markers (`\n` between lines); not found is an error and changes
  nothing. Not together with `text` / `markdown`. Unlike a resent
  `markdown`, `format` keeps the user's words: it only clashes when their
  edit removed the phrase.
- Reading shows `markdown` next to the plain `text`; `measure_text` takes
  `markdown` too.

## Slides (presentations)

Every frame is a slide; the user presents with the "Slides" button
(fullscreen, presenter view, PDF).

- **Presentation flag:** whether a scene is a presentation is a saved
  boolean: `read_scene` returns `isPresentation`, `edit_scene(isPresentation:
  true / false)` sets it (false keeps every frame). Edits change it only with
  `isPresentation` or a new template; placing elements on slides, notes,
  `restyle`, `reset` and `addTitleBlock` leave it as it is. A new scene from
  `save_scene` (and an old one without the flag) is a presentation if it has a
  template or speaker notes; frames alone are not: for a deck without either,
  follow with `edit_scene(isPresentation: true)`.
- **A slide:** `{ "type": "frame", "id": "s1", "x": 100, "y": 100, "width":
  1920, "height": 1080, "name": "Title", "children": [ids], "customData": {
  "slides": { "order": 0, "notes": "speaker notes" } } }`. Notes take the
  same markdown as text. Keep everything inside its frame; elements added
  later get `"frameId": "s1"`.
- **Where slides lie:** Kurviq's grid, 7 per row, 240 apart, in deck order.
  While the slides are in that grid, adding, deleting or reordering slides
  re-arranges it. Moving frames yourself (`x` / `y` on a frame, e.g. more room
  between rows) keeps your layout; everything on a frame moves with it, and
  later edits leave the layout as it is.
- **Placing on a slide:** `"slide": 3` (deck number, frame id or
  `"template"`) makes `x` / `y` count from that slide's corner and the element
  part of it (`add` and `update`, `save_scene` too).
- Per slide (`customData.slides` of the frame): `"skip": true` hides it (not
  presented, not in the PDF, grayed out for the user, `"hidden": true` in
  summaries; `"skip": null` shows it again), `"template":
  false` turns the template off (title slides). Click-by-click reveals:
  `"customData": { "slides": { "step": 1 } }` on elements (1, 2, 3 …; a label follows its shape).
- **Template:** one frame with `"customData": { "slides": { "role":
  "template", "theme": { "transition": "glide" } } }` (or `"cut"`). Its
  elements (header, footer, logo, background) are copied onto every slide;
  texts may hold `{page}`, `{total}`, `{title}` (the frame's name), `{deck}`
  (the scene's name), `{date}` (today), filled in only in template elements. Copies (ids `<element>~<slide>`) follow the template property by
  property; what was changed on one slide stays (read_scene:
  `changedOnSlide`). `reset` brings the template's version back: slide
  ids or numbers, copy ids, or `{ "id": "<copy id>", "changes": ["color"] }`
  (change names from `changedOnSlide`); `restyle: true` on all slides. There is no other
  theme: style the template's elements.
- **Headline and eyebrow:** template texts with `"customData": { "slides": {
  "role": "headline" } }` / `"eyebrow"` style every slide's headline /
  eyebrow (the template's text gives the default words, e.g. `{title}`); a
  slide's own words go in the copy, e.g. `{ "id": "<headline
  id>~<frame id>", "text": "Our plan" }`. Every template has both (the app adds them
  once to an older template; `addTitleBlock: true` right away); a deleted one
  stays deleted. A template text with `"role": "body"` is not copied: its
  font, size and color are the style of new text you add without them.
- **Clean, modern look** (instead of hand-drawn): `"fontFamily": "Inter"`,
  text #111827, lines #334155, `"roughness": 0`, titles 72, body 36, white or
  #f8fafc slides, one accent (e.g. #2563eb), fills like #e0e7ff / #f1f5f9.
  Make slides visual: shapes, arrows, icons, sticky notes, charts, not just
  bullets.
- **Check:** `validate_deck(name)` finds cut-off, overlapping, overflowing,
  too small or low-contrast text (on pictures against the picture's
  colors), elements outside their slide, broken steps and missing notes (silence intended findings with `"customData": {
  "slides": { "ignore": ["clipped", "overlap"] } }` or `true`).
  `view_scene(name, slide: 3)` shows a slide as presented (`step: 1`: after
  the first click); `slides: "all"` the whole deck (`steps: true`: every
  click state).
- PDF: `export_pdf(name)` (all slides, or `slides: [1, 3]`) writes a PDF
  with real, selectable text.

## New drawings with `create_view`

`create_view(elements)` draws a draft (shown live in clients that display
it, about 700 px wide) and returns a `checkpointId`; then
`view_scene(checkpointId)` and `save_scene(name, checkpointId)`.
`save_scene(name, elements)` saves a drawing directly. Drafts can't hold
images. Extra pseudo-elements in `create_view`:

- `{ "type": "cameraUpdate", "x": 0, "y": 0, "width": 800, "height": 600 }`:
  the visible area, 4:3 only (400×300, 600×450, 800×600, 1200×900,
  1600×1200; text at least 18 at 1200, 21 at 1600). Start with one, put it
  before what it frames, leave padding; several guide the viewer.
- `{ "type": "restoreCheckpoint", "id": "<checkpointId>" }` first: continue
  a previous draft (the user's changes to it included) and only add new
  elements.
- `{ "type": "delete", "ids": "b2,a1" }` after the elements it removes
  (labels go along). Never reuse a deleted id.
- Order for a draft that builds up nicely: background, then each shape, its
  label, its arrows, then the next shape. Animation: draw, nudge the camera,
  delete and redraw at the same spot with new ids.
