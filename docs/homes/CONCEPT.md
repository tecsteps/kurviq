# Kurviq: where a scene lives (scene homes)

Nov 13, 2026 · one interface for the places a scene lives: this browser and
Google Drive. (A database home was built and dropped on 2026-11-14, see
`specs/2026-11-13-own-database.md`.)

## The rule

Each scene has exactly one home. The scenes controller
(`scenes-plugin/src/controller.ts`) talks to a home only through the
`SceneHome` interface (`scenes-plugin/src/homes/types.ts`); it never calls
`driveScenes` or any other client directly. Today:

| Home | Module | Which scenes |
|---|---|---|
| `browser` (this browser only) | `homes/browser.ts` (`browserHomeOf`, over the controller's own store) | local-only scenes, and the untitled draft |
| `drive` (Google Drive) | `homes/drive.ts` (`driveHome`, over `online/drive.ts` `driveScenes`) | every other scene |

`controller.homeOf(name)` answers which; every list item carries `home`. A
scene's home is derived from its metadata (`localOnly`).

## The interface (contract)

All calls are by scene name, all versions are opaque strings (`string`,
compared for equality only: Drive's MD5, the browser's MD5 of the content).

| Call | Must |
|---|---|
| `list(refresh?)` | the home's scenes (`name`, `version`, `updatedAt`, `id`, `public`) and its `status` (`online`, `lastFetchAt`, `lastError`, `readOnly`). Offline: the last known listing with `online: false`, not a throw. Not signed in: throw `notConnected`. |
| `load(name, version?)` | the scene JSON (Excalidraw's file format, plus `kurviqComments`, `kurviqFonts`, `kurviqPresentation*`) and its version. With `version`: that older version (the base of a merge), 404 if it is gone. |
| `save(name, json, base, source?)` | `base` `"none"`: must be new (409 `exists` otherwise); a version: must still be the home's (else **409 with `remoteVersion`**: the controller merges and saves again); `undefined`: overwrite. Same content again: `{ changed: false }`, no new version. |
| `remove(name, base?)` | delete (Drive: to the bin); with `base` only if that is still the version (409). 404 if not there. |
| `rename(from, to)` | content and version stay; 409 `exists` if `to` is taken, 404 if `from` is gone. |
| errors | `HomeError`: `status` as HTTP; `offline` (keep working locally, retry later; never "no access"), `notConnected`, `readOnly`. |
| optional | `history` / `loadVersion` (`capabilities.history`), `files` / `comments` (when not inline), `live` (presence), `sharing`, `markMoved` / `movedTo` ("moved" marker). |

`capabilities` tell the controller and the UI what the home can do:
`sync` (`none` / `merge` / `realtime`), `history`, `filesInline`,
`commentsInline`, `presence` (`none` / `pen` / `realtime`), `sharing`
(`none` / `drive` / `members`), `publicLinks`, `guests`, `moveMarker`,
`needsSignIn`. The UI must decide from these, never from the home's kind.

The test `scenes-plugin/test/homes.test.ts` runs the same contract cases
against every home (`contract(...)`): a new home is added there first.

## The controller's side

- **One source of truth**: `meta.current` is the open scene; `state.current`
  is derived from it in `setState` (never patched). `state.urlMode` says
  whether the URL follows with a new history entry (open) or in place
  (rename, delete).
- **One queue** (`scenes-plugin/src/opQueue.ts`): user actions, opening a
  scene and sync steps run one at a time. Opening uses the priority lane: it
  waits only for the operation that is running. An open loads the new scene
  first (a failed load changes nothing), then stashes the open one (with the
  edits made while loading) and shows the new one without any await between.
- **Metadata from other tabs** (`storage` / `focus` events) replaces the
  in-memory metadata at any time. Operations therefore look their scene's
  record up again after every await and store a change before the next
  await; they never hold a record across one.
- **Merge homes** (`sync: "merge"`): the controller's sync engine (push after
  10 s idle, pull, three-way merge of elements, z-order, comments, fonts,
  presentation and background / grid) works on `load` / `save` with base
  versions. A merge that takes nothing of mine takes the home's version as
  it is (no push of the same content written differently). **Realtime homes** (`sync: "realtime"`) are not merged by the
  controller: their live session streams element changes and writes them; the
  controller only opens, stashes and lists.
- **Live sessions** (`HomeLive`, wired once by `homes/live.ts` from
  `index.tsx`): Drive's is the pen (`online/pen.ts`, `docs/relay/CONCEPT.md`).
  A session talks back through `LiveHost`, implemented by the controller:
  `setPenLock` (someone else writes: read only here), `penAdoptSaved`,
  `penSavedVersion`, `penSaveNow`, `penFlushOwn`, `penHooks` (saved / pulled).
  The controller's `subscribe` / `getState().current` and `fileIdOf` say which
  scene is open.
- **The browser home** is the controller's own store (`LocalSceneStore`):
  `controller.browserHome` reads and writes local-only scenes through the
  queue like any other home.
