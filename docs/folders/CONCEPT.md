# Scene folders: concept

Status: decided with the owner on 2026-11-10, **not implemented yet**. Start
with the feasibility check below before building anything.

## Why

Scenes that belong together (one customer: "schülke - Overview", "schülke -
Internal Audit", ... ; "Madsack ...") are kept apart today only by a name
prefix. The owner wants them in folders, in Kurviq's scene list and in Google
Drive, and wants to share a whole folder (e.g. with that customer) besides
sharing single scenes.

## Today

- Every scene is one file `<name>.excalidraw` directly in the Drive folder
  "Kurviq" (found by its appProperties mark, `scenes-plugin/src/online/drive.ts`
  `findFolder` / `fetchFolderScenes`). The scene's name is its address:
  `kurviq.com/<name>`.
- The list reads only `'<Kurviq folder>' in parents`: a file moved into a
  subfolder in Drive **disappears from Kurviq's list**.
- Scope `drive.file`: Kurviq sees only files and folders it created or that
  were opened with it (Picker, shared link). Folders Kurviq creates itself are
  visible; folders the user makes by hand in Drive are not.
- Names: `scenes-mcp/sceneName.mjs`, unique across all scenes, no `/`.

## Decisions

| Topic | Decision |
|---|---|
| Structure | **One folder level.** Kurviq creates `Kurviq/<folder>/` in Drive. No nested folders. |
| List | Folders as collapsible groups at the top of the scene list (with a scene count); scenes without a folder below them. Search filters across all folders and keeps the folder heading of each match. |
| Moving | "Move to folder…" in the scene's menu, drag a scene onto a folder in the list, or a "Folder" field when creating a scene. Moving files between Kurviq's folders in Drive works too; Kurviq follows on the next list refresh. |
| Addresses | A scene in a folder: **`kurviq.com/<folder>/<name>`**; without a folder: `kurviq.com/<name>` as today. Names must be unique **within a folder** only. |
| Old links | After a move, the old address still opens the scene (redirect to the new one), so links in mails, decks and agent sessions keep working. |
| Names on move | **Kept as they are** ("schülke - Overview" stays "schülke - Overview" in the folder schülke). No automatic or suggested shortening. |
| Migration | **No software support** (no prefix suggestions in the app). Once built, Claude sorts the owner's existing scenes into folders through the MCP. |
| Folder sharing | A folder has the **same Share… dialog as a scene**, but **people only**: by email, Can edit / Can view (Google emails them). Drive passes the access on to every scene in the folder, also scenes added later. |
| Public folder links | **None.** "Anyone with the link" stays per scene; folders are never public. |
| Recipient's view | A folder shared with you appears **as a folder in your own scene list**, marked "shared by <name>", with all its scenes; new scenes in it show up by themselves. |
| Deleting a folder | **Only empty folders** can be deleted (move or delete the scenes first). Renaming a folder renames it in Drive and changes the addresses of its scenes (old ones redirect). |
| Local-only scenes | May sit in a folder too; the folder then exists only in that browser (same name space as Drive folders). |

## Feasibility check first (blocking)

With `drive.file`, can the **recipient's** Kurviq list a folder that someone
else shared with them, including scenes added to it later?

- The owner's own folders are fine (Kurviq created them, and the scenes in them).
- For a shared folder the recipient's Kurviq did not create anything. To check
  with two Google accounts (A shares a Kurviq folder with B):
  1. B opens the folder through the Google Picker (folder selection enabled):
     does Kurviq then get `files.list` with `'<folder>' in parents` for the
     scenes inside, and for files A adds afterwards?
  2. B opens a share link of the folder (`kurviq.com/<folder>/…` or a Drive
     folder link through Kurviq's "Open with"): same question.
  3. Does a file B creates in A's folder (B has Can edit) appear for A?
- **If it works:** build as decided.
- **If not:** fallback in which the recipient sees a shared folder's scenes once
  each was opened once (Picker multi-select of the folder's files, or the
  share mail's links), and newly added scenes need a new pick. Weaker than the
  decision; go back to the owner before building it.

## Design notes

### Drive

- Folder = Drive folder inside "Kurviq", created by Kurviq, marked with
  `appProperties: { kurviq: "folder" }`.
- Listing: the Kurviq folder's children (scenes and folders), then each
  folder's children (one level, so one extra query per folder, or one query
  `parents in (...)` batched).
- A scene's folder = its Drive parent; moving = `files.update` with
  `addParents` / `removeParents`. A move is not a content change: no new
  revision of the scene, `agentRev` and live sync unaffected.
- Shared folders: found the way the feasibility check shows (Picker grant or
  shared-with-me query with the mark), shown with the owner's name.

### Addresses and router

- `/<folder>/<name>`; `/<name>` stays valid for scenes without a folder. A
  folder and an unfoldered scene may not share a name (else `/<x>` is
  ambiguous).
- `/s/<fileId>/…` and `/pub/<short>` links are unaffected (they address the
  file, not the path).
- Old path after a move or folder rename: the app keeps a local alias map
  (old path to file id) and redirects; for other people's links the scene is
  found by name across folders if unique, else a chooser.

### Live sync, sharing, statistics

- Live sync is per scene (Durable Object per file): unchanged.
- Folder sharing uses Drive permissions on the folder; Kurviq's Share… dialog
  calls the same permission API as for scenes, on the folder id. The
  `live-sync` access check (Drive `canEdit` of the file) already honours
  inherited folder permissions.
- Statistics: nothing new required; optionally count folder shares as a
  server event if they go through the Worker.

### MCP (agents)

- `list_scenes` and `app_status`: each scene with `folder` (null without one);
  shared folders with their owner.
- `read_scene`, `edit_scene`, `view_scene`, ...: a scene is addressed as
  `"<folder>/<name>"` or by its name when that is unique.
- `save_scene(name, folder?)`, `clone_scene(..., folder?)`.
- New: `move_scene(name, folder | null)`; folder tools `create_folder`,
  `rename_folder`, `delete_folder` (empty only). Sharing a folder stays a user
  action in the app (like scene sharing), unless the owner asks otherwise.
- Update SKILL.md / REFERENCE.md and `online/worker/skill.ts`; the doc test
  `scenes-plugin/test/agentDocs.test.ts` keeps the token budgets.

### UI

- Scene list (`scenes-plugin/src/index.tsx`, scene panel): folder rows with
  chevron, count, menu (Rename, Share…, Delete when empty); scene rows
  draggable onto folder rows; "New folder" in the list's menu.
- Scene menu: "Move to folder…" (folder picker with "No folder" and "New
  folder…").
- Current scene button shows `folder / name` when in a folder.
- Shared folder: "shared by <name>" next to its name; its Share… dialog shows
  the owner and your access.

## Tests (when built)

- Unit: path parsing and names unique per folder (`sceneName.mjs`), alias
  redirects, list grouping and search with folders.
- E2E (fake Google): create folder, move scene, open by new and old address,
  rename folder, delete only when empty, local-only scene in a folder.
- Two real accounts (manual, once): folder sharing as in the feasibility check.
- MCP: `move_scene`, `list_scenes` with folders, `save_scene(folder)`.
