# Scene folders: concept

Status: decided with the owner on 2026-11-10, **not implemented yet**.
Shared folders: route chosen 2026-11-11 (see "Shared folders through the
owner's sign-in"); built 2026-11-11 (phase 1: see and open read-only;
phase 2: edit, create, rename, delete through the server; phase 3: agents):
`online/worker/folders.ts`, `online/worker/folderRules.ts`, e2e
`scenes-plugin/test/e2e/shared-folder.mjs` (also with `KURVIQ_LIVE=off`).
Live sync works inside shared folders too: the tab names the folder in the
ticket / renew / reconcile requests (`folderOfFile`), the routes check the
person against the folder and use the owner's access, and the scene's Durable
Object saves the person's changes with the owner's refresh token (sealed for
that person and file, like any author's).

**Superseded 2026-11-13** for shared folders: Kurviq's server keeps no tokens
and no folder registrations any more
(`specs/2026-11-13-drive-collaboration-without-server-data.md`, "Shared
folders"; see "Shared folders without the server" below). The section
"Shared folders through the owner's sign-in" describes the retired route.

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

## Shared folders without the server (2026-11-13)

Built: `scenes-plugin/src/online/drive.ts` (`sharedFolders`, `noteFolderScenes`,
`pickFiles`), `scenes-plugin/src/online/folderAccess.ts` (`groupSharedFolders`),
e2e `scenes-plugin/test/e2e/shared-folder.mjs`. The server's folder routes,
tables and the owners' stored tokens are gone (the D1 tables are dropped by
`online/worker/database.ts`).

- The guest picks the shared folder (or its scenes) once in Google's Picker
  ("Shared with you…" in the scene list; folders can be picked there). Their
  Kurviq lists, with their own sign-in, the folders they picked and the
  scenes Kurviq may open in them (`'<folder>' in parents`).
- Whether picking a folder grants `drive.file` access to the files in it is
  not verified with the real Google: the code works either way. Without the
  grant, the owner's Kurviq notes the folder's number of scenes on the folder
  (`appProperties.kurviqScenes`, metadata only, while the folder is shared);
  the guest's group shows "N new scenes in this folder: open them", which
  opens the Picker on that folder (several at once).
- Scenes picked out of a folder that wasn't picked are grouped as
  "<owner>'s folder".
- Opening a scene of a shared folder still switches the tab to the folder's
  space (`d:<folderId>`), now with the guest's own access: reads, and writes
  where Drive lets them edit (new scenes need the folder itself picked).
- To verify in UAT: the folder pick's grant, `appProperties` of the owner's
  folder being visible to the guest's Kurviq, and the `'<folder>' in parents`
  query listing the picked scenes of a folder the guest didn't pick.

## Shared folders through the owner's sign-in (route chosen 2026-11-11)

The feasibility question is settled the other way round: the recipient's
Kurviq gets no `drive.file` access to files it did not create, however the
folder is shared (tried 2026-11-11: the owner shared the whole Kurviq folder
in Google Drive; the recipient's Drive shows all scenes, the recipient's
Kurviq none). Full `drive` access (restricted scope, yearly security
assessment, "all your files" consent) is rejected. Instead **Kurviq's server
works on the shared folder with the owner's sign-in**, for the people Drive
lists as having access. Behaviour for the recipient: like Google Drive.

### What the user sees

- The scene list: **"My scenes"** (the own Kurviq folder) first, then **one
  group per folder shared with you**, possibly several, from several people:
  "<folder name> · shared by <owner>", with all its scenes. New scenes in it
  show up by themselves, removed access makes the group disappear.
- Opening a scene of a shared folder switches the tab to that folder (its own
  space, `d:<folderId>`, like a shared scene's space today): the list then
  shows that folder's scenes as its own, with "Back to my scenes". Edit /
  view as Drive allows (Editor / Viewer on the folder).
- Editors can also create, rename and delete scenes in a shared folder (as in
  Drive). The owner sees their changes in their own Kurviq like any other.
- Sharing works the way the owner already did it: **share the folder in
  Google Drive** (or later from Kurviq's folder Share… dialog). No extra step
  in Kurviq except that the owner opens Kurviq once after sharing (see below).

### How it works

1. **Owner's side (registration).** The owner's Kurviq reads the permissions
   of its own Kurviq folder (allowed: Kurviq created it) when it lists its
   scenes, at most every few minutes. If people besides the owner have access,
   it tells the Worker (`POST /folders/register`, with the sign-in cookie /
   local session). The Worker stores, per shared folder: folder id, owner
   (sub, name), the owner's refresh token **sealed** (TOKEN_KEY, like live
   sync's author tokens), and the members as keyed hashes of their emails
   with their role. Unshared again (only the owner left): the entry and the
   token are deleted.
2. **Recipient's side (discovery).** The recipient's Kurviq asks
   `GET /folders` (signed in): the Worker looks up the folders whose member
   hashes contain the recipient's email and answers name, owner, role.
3. **Access check, every request.** Before anything is read or written for a
   recipient, the Worker re-reads the folder's permissions with the owner's
   token (cached a few minutes): the recipient's email must be there (user
   permission; domain permission matching the email's domain), role from it.
   Removing someone in Drive cuts them off within minutes; the owner signing
   out everywhere, revoking Kurviq or deleting the folder ends the whole share.
4. **Reading and writing.** The recipient's Kurviq never calls Drive for a
   shared folder: list, read, save (with the version it is based on, like
   today's conditional upload), create, rename and delete go through the
   Worker (`/folders/<id>/…`), which calls Drive with the owner's token.
   Live sync of a scene in a shared folder: the scene's Durable Object saves
   recipients' changes with the owner's access (tickets checked as in 3).
5. **Attribution.** Drive records the owner's account as the one who changed
   a file (the app acts as the owner). Kurviq's own history and live sync keep
   the real author (name / pseudonym as today).

### Rules

- Only folders Kurviq created (the Kurviq folder; later the subfolders of
  this concept) can be shared this way. Group permissions in Drive can't be
  resolved by Kurviq: share with people (emails) or a whole domain.
- The sealed owner token lives as long as the folder is shared (not just until
  a save, unlike live sync's author tokens). It is used only for that folder's
  files and permissions. `/privacy` says so.
- The owner must open Kurviq after sharing (registration runs in the owner's
  browser). Until then, the recipient's list shows nothing for that folder.
- Nothing about a recipient is stored except the keyed hash of their email in
  the folder's member list.

### Phases

1. Worker: folder registry (D1 table `shared_folders`), registration from the
   owner's list refresh, discovery, access check, read-only list + read.
   Recipient: shared folder groups in the list, open a scene read-only.
2. Writing: save / create / rename / delete through the Worker; live sync with
   the owner's access for scenes in shared folders.
3. Agents (MCP): shared folders in `list_scenes` / `app_status`; edits through
   the tab as today.

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
