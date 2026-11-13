---
name: kurviq-scenes
description: Draw, co-edit, look at and save diagrams in the user's local Kurviq, an Excalidraw app (scenes synced with Google Drive, MCP server "kurviq-local"). Use whenever the user asks to draw or change a diagram/sketch/scene in Excalidraw, wants to co-work on a drawing, asks what is on their canvas, or mentions Excalidraw scenes.
---

# Kurviq (local): how to work with the user's drawings

The user runs Kurviq, a local Excalidraw app (http://draw.test), with **scenes**
(named drawings, URL `http://draw.test/<scene>`) kept in their browser and,
if they signed in with Google, synced with their Google Drive. The MCP
server `kurviq-local` gives you tools for it. The user is often **looking at
the app while you work** and edits by hand in between.

**You work through the user's open Kurviq tab.** Every tool needs the app
open in the user's browser (any scene). Your reads and edits run in that tab
with the real Excalidraw, so you always see the user's latest work, pushed or
not. The tab merges your edits into what the user is doing and saves them to
Drive right away with the user's sign-in. Without sign-in (`app_status` →
`drive`: "not connected") all scenes are local-only: they exist only in that
browser, and you read and edit them there the same way.

**The MCP tools are all you need.** Do everything in Kurviq (read, draw,
edit, look, save, share, check decks) through them, never by driving the
app in a browser (no Playwright, Chrome, computer use or screenshots of the
page, no clicking in the UI): the tools are far faster and cheaper, return
exact data and an image of your change, and merge safely with what the user
is doing. Use the browser only if the user explicitly asks you to test the
app's interface itself.

## Golden rules

1. **Always `read_scene` before you edit.** It reports what the user
   changed since an agent last edited the scene (`userChanges`), found in the
   scene's Drive history, so it works across conversations and agents.
2. **Call `read_me` once before you write elements** (edits, new drawings):
   it is the element reference (see "Writing elements" below).
3. **Edit with `edit_scene`**, not by re-creating the scene. It changes only
   the elements you name; the user's other work is untouched. Pass the
   `revision` from your last `read_scene` / `edit_scene` as `basedOn`.
4. **Look at the result.** `edit_scene` returns an image of what you
   changed. Use `view_scene` whenever you need to see something; it returns a
   real PNG.
5. If `edit_scene` answers with a **WARNING**, the user changed the scene
   since your `basedOn`. Updates of properties they changed come back in
   `conflicts` (`yours` / `theirs`) and are not applied: rebase them on the
   user's version and send them again (`onConflict: "overwrite"` only if the
   user wants your version). Check their changes (listed + image) against
   the rest of your edit.
6. **Stick to the scene the user asked for.** If they say "this drawing",
   `app_status` tells you which scene they have open.
7. **Don't touch the user's view.** `open_scene` (and `open: true`) switches
   what the user sees: only when they ask you to show them something.
8. **Only these tools, never around them.** You never push, sync or write
   scene files yourself: `edit_scene` hands your change to the user's
   Kurviq tab, which saves it; the user's app syncs their own work by
   itself (auto-sync). Never call the scenes server's HTTP API
   (localhost:3101) with curl or scripts, and never write `.excalidraw`
   files or Drive files yourself: direct writes are refused, and they would
   bypass merging and the user's unpushed work. If a tool can't do what you need,
   tell the user instead of working around it. Replace a whole scene
   (`save_scene(replace: true)`) only when the user explicitly asks for it.
   Sync conflicts: `get_conflict` / `resolve_conflict`.

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

## Writing elements: `read_me`

`read_me` returns the element reference (also in REFERENCE.md next to this
file): element format, colors, edit details, limits, formatted text
(`markdown`, `format`), slides (presentation flag, templates, steps,
`validate_deck`) and `create_view` drafts.

## Seeing scenes (they can be huge)

- `view_scene(name)`: a scene, incl. the user's latest edits;
  `view_scene(checkpointId)`: a `create_view` draft.
- Zoom: `elementIds: [...]` (those elements + padding + whatever overlaps) or
  `region: {x, y, width, height}`; `maxSize` caps the image size.
- Big scenes: `read_scene(name, summary: true)` / `get_scene(name, summary: true)`
  give an overview (bounds, counts, frames, text labels with positions, 100
  per page: `textsOffset` for more) to find the right region first.

## New scenes and managing scenes

- New drawing: `save_scene(name, elements)`, or a `create_view` draft saved
  with `save_scene(name, checkpointId)`. `save_scene` refuses existing scenes
  (change those with `edit_scene`); `replace: true` only when the user
  explicitly wants the whole scene replaced by a new drawing.
- `rename_scene(name, newName)`, `clone_scene(name, newName)`,
  `delete_scene(name)`: in the user's app and in their Drive (a renamed
  scene keeps its file and links; unpushed changes move along). **Only
  delete when the user asked for exactly that scene** (in Drive it goes to
  the bin for 30 days; a local-only scene has no other copy).
- `list_scenes` lists the user's scenes. `app_status`: which scene the
  user has open, whether Drive is connected (`drive`), and each scene's sync
  status in their app (`scenes`: rows `{ name, status, localOnly, note }`):
  synced · ahead (not pushed) · behind (newer in Drive) · diverged ·
  conflict · local-only (not in Drive) · note "auto-sync off" (the user
  pushes when they decide).
- **Shared folders**: folders others shared with the user are in
  `app_status` → `sharedFolders` (owner, role, scenes). Your tools work on the
  scene list the user's tab shows (`app_status` → `space`): to work in a
  shared folder, ask the user to open it (scene list → its group). There your
  edits save to the owner's folder; with role reader, scenes are view-only.

## Local-only scenes

Some scenes are **local only**: they live only in the user's browser and are
never pushed to or pulled from Google Drive (e.g. confidential customer
work). The user picks this per scene; without Google sign-in every scene is
local only. `app_status` / `list_scenes` mark them.

- `read_scene`, `edit_scene`, `view_scene`, `get_scene`, rename, clone and
  delete work on them as usual, through the user's app, which must be open.
  They answer with a "Local-only scene" note; nothing goes to Drive.
- New local-only scene: `save_scene(name, …, local: true)`, only when the
  user asks for a local / private / not-synced scene.
- `set_local_only(name, localOnly)`: make a scene local only, or sync it
  with Drive again. Only when the user asks.

## Links to share

`short_link(name)` gives a scene's links: the long one
(`kurviq.com/s/<fileId>/<name>`, always works), its short link
`kurviq.com/pub/<shortName>` if it has one, a `presentLink` and who can open
them (`generalAccess`). `short_link(name, shortName: "my-talk")` gives the
scene that short link: any free name (it need not match the scene's name),
3 to 40 lowercase letters, digits and hyphens, unique on Kurviq (first come,
first served; a taken name is refused, try another). The scene's old short
name is freed; `shortName: null` removes it. `generalAccess: "reader"` makes
the links open for everyone (view and present, no account). Only claim a
name or change access when the user asks. The scene must be synced with
Google Drive.

## Merge conflicts

By default the user's app settles clashes by itself (the same element
changed on both sides: the newer edit wins), so conflicts are rare. If the
user switched that off and the local and Drive versions changed the **same
elements** differently, the scene is in **conflict** in the user's app
(shown in the scene's panel, in `app_status` and in `read_scene`'s `sync`). Their
newest edits of that scene don't reach Drive until it is resolved. Changes
that only one side made are merged automatically.

1. `get_conflict(name, view: true)`: per clashing element the base,
   **mine** (the user's local version) and **drive** version, which fields
   each side changed, plus images of both versions of the clashing area.
2. `resolve_conflict(name, resolution: "merge", choices: {id: "mine" |
   "drive"}, otherwise: "mine" | "drive")`: keeps both sides' other
   changes and decides each clash, then pushes. Alternatives: `"mine"`
   (user's whole version overwrites Drive), `"drive"` (discard the
   user's local changes), `"both"` (Drive's version, user's kept as a
   copy scene).

When it's not obvious which version is right, show the user the
differences and ask. Never silently throw away the user's work.

## Where things are stored

Nothing is stored by the servers: scenes live in the user's browser
(localStorage / IndexedDB) and in their Google Drive (one
`<name>.excalidraw` file per scene, in a folder "Kurviq"). After your edit
the user's tab marks that Drive revision as the agent's version (`agentRev`
in the file's appProperties); that is how `userChanges` finds your last
version. Your `create_view` drafts live in the user's Kurviq tab (browser
storage).

## Live mode (only if your tools are `read_open_scene` / `edit_open_scene`)

The user can switch to live mode (`SCENES_AGENT_MODE=live`). Then you
co-edit the canvas they have open, live: `read_open_scene(scene: "X")` instead of
`read_scene`, `edit_open_scene(expectScene: "X", …)` instead of
`edit_scene`. These act on the canvas the user sees (incl. their unsaved
edits, undoable with Cmd/Ctrl+Z), and the app's auto-sync pushes the
result. Don't push yourself; `save_open_scene` only when the user asks to
push now.

## Troubleshooting

- A timeout or "the Kurviq tab did not answer": retry with the same
  `requestId` (never applied twice) and check `app_status` → `health`.
  Background tabs answer more slowly (browsers throttle them): keep working
  on other things; mention the tab to the user only if retries still fail
  after about 2 minutes.
- "Scenes server not reachable": the user runs `npm start` in the project
  folder (kurviq).
- "Kurviq is not open": ask the user to open the app (http://draw.test) in
  their browser and keep the tab open, then try again.
- "Google Drive is not connected": the user can sign in with Google in the
  app (scene list → Sign in with Google); until then, work with local-only
  scenes.
- "No Chrome found": PDFs, and pictures when no tab is open, need Chrome or
  another Chromium browser (`CHROME_PATH` in `.env`).
