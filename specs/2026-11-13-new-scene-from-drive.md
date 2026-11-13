# "New → Kurviq scene" inside Google Drive

Status: proposal (Should), 2026-11-13

## Why

Start a scene where the work is (a project folder), not only in Kurviq. Kurviq
is already in Drive's "Open with" menu (`drive.install`).

## How

- Google Cloud console, Drive UI integration: enable "Creating new documents"
  with the new-URL `https://kurviq.com/drive/new`.
- Drive opens it with `state={"action":"create","folderId":"…","userId":"…"}`.
  The Worker route only hands the state to the app (no storage).
- The app checks that the signed-in account is the `userId` (else: "sign in as
  …"), asks for a name, creates the scene file in that folder (`drive.file` may
  create files there), marks it as a Kurviq scene (`appProperties`) and opens it
  like a picked shared scene.
- Scenes outside the Kurviq folder: the scene list shows them in a group "Other
  folders"; the app remembers their ids in the browser (as for shared scenes).
- Nothing stored on our side.

## Checks

- The route passes the state through without storing it; a wrong account gets
  the sign-in hint.
- The new file lands in the chosen folder and opens in Kurviq.

## Open

- Does Google require the Drive UI integration's "new" entry to be re-reviewed
  for the OAuth app (brand verification exists)?
