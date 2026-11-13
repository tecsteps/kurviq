# Thumbnails in Google Drive

Status: proposal (Must), 2026-11-13

## Why

Drive and Google's picker ("Shared with you…") show Kurviq scenes as an empty
checkerboard. A small preview makes them recognizable at a glance, in Drive and
in Kurviq's own picker dialogs.

## How

- Drive takes a thumbnail with a file's metadata: `contentHints.thumbnail` =
  `{ image: <URL-safe base64 PNG>, mimeType: "image/png" }`, at most 2 MB.
  Google keeps it with the file; Kurviq stores nothing.
- Who sends it: the tab that saves the scene. After the Drive spec
  (`2026-11-13-drive-collaboration-without-server-data.md`) that is always a
  browser: the person holding the pen, or the one tab of a scene without others.
  No server writes Drive any more.
- What it shows: about 400 px wide, the whole scene (or a deck's first slide),
  on the scene's background, rendered with Excalidraw's `exportToBlob`
  (the same path as `render.ts` uses for previews).
- When: in the same multipart upload as the content (`driveScenes.save`), so it
  never lags. Rendering takes some milliseconds; for big scenes it runs after
  the save, as a metadata-only PATCH, at most every 2 minutes while editing.
- Drive drops a thumbnail when the content changes without one: every save path
  sends one, or the next save refreshes it. Saves by agents (`cowork.ts`) render
  in the user's tab too.
- Not for local-only scenes (they aren't in Drive).

## Checks

- Unit: the thumbnail field is added to the upload's metadata, URL-safe base64,
  below 2 MB (downscale or JPEG fallback otherwise).
- In Drive: a saved scene shows its preview in Drive's grid and in the picker.

## Open

- Does Drive show `contentHints.thumbnail` for a custom MIME type
  (`application/vnd.excalidraw+json`) in every view (grid, picker, search)?
  Test with one file first.

## Acceptance criteria

1. Saving a scene to Drive (edit, wait for the save) sets the file's thumbnail: Drive's file metadata
   (`thumbnailLink` / the fake's stored `contentHints.thumbnail`) is a PNG about 400 px wide showing the scene.
2. A deck's thumbnail shows its first slide; an empty scene gets no thumbnail (no error).
3. After the next edit and save, the thumbnail shows the new state (not an old one).
4. An agent's `edit_scene` on a Drive scene updates the thumbnail too.
5. A scene with a 10 MB picture still saves; the thumbnail stays below 2 MB.
6. Local-only scenes never call Drive for a thumbnail.
7. Nothing about the thumbnail is sent to Kurviq's server (network: only Google's endpoints).
