# "New → Kurviq scene" inside Google Drive

Status: implemented behind `DRIVE_NEW` (off until the console setup below is done), 2026-11-13

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

## Implementation

- Worker: `online/worker/driveNew.ts`, `GET /drive/new`. Only with the Worker var
  `DRIVE_NEW = "on"` (`online/wrangler.jsonc`, default `"off"`; `wrangler dev
  --var DRIVE_NEW:on`): Drive's state is checked (`action` "create", folder id,
  user id, optional `folderResourceKey`) and the browser is redirected to
  `/?drive-new=<the same state>` (302, `no-store`, no cookie, no storage, no
  Drive call). Off: a page "Not enabled yet" with a link to Kurviq (404). A
  broken state: a page saying so (400).
- Scopes: `drive.install` has been requested at every sign-in since the Drive
  migration (`online/worker/auth.ts`, for "Open with Kurviq"); nothing changes
  there, so `DRIVE_NEW` gates only the route. `/auth/token` now also returns the
  account id (`user.sub`), which the app compares with Drive's `userId`.
- App: `scenes-plugin/src/online/driveNewState.ts` (pure: parsing, account
  check, remembered list), `driveNew.ts` (Drive calls with the user's token,
  "Other folders" list), `driveNewUI.tsx` (the dialog, mounted in
  `index.tsx`). The request is kept in the tab (`sessionStorage`) across the
  sign-in and the move into the account's scenes, and dropped when done or
  cancelled.
  - Not signed in, signed in as another account, or a sign-in without the
    account id: "Sign in as the account you used in Drive" (with the email
    signed in, "Nothing was created"); its button signs in with
    `login_hint=<userId>` and comes back to the request. No Drive access:
    the same with Google's consent screen.
  - Drive's account: "New Kurviq scene" with the folder's name (if Kurviq may
    read it) and a "Scene name" field. Create checks the name (scene name rules,
    no scene of that name in the folder), uploads an empty scene
    (`<name>.excalidraw`, `application/vnd.excalidraw+json`,
    `appProperties { kurviq: "scene", fmt: "1" }`, `parents: [folderId]`) and
    opens it: in the Kurviq folder as one of the user's own scenes, in any other
    folder like a scene picked in Drive (`/s/<fileId>/<name>`, a space of its own).
  - Scenes in other folders are remembered in this browser per account
    (`localStorage` `kurviq-other-folder-scenes:<email>`, ids and names only)
    and listed in the scene list's group **Other folders**; on each listing they
    are checked with Drive (renamed: new name; deleted, no access or moved into
    the Kurviq folder: dropped).
- Tests: `scenes-plugin/test/driveNew.test.ts` (state, account check, list,
  route on/off), e2e `scenes-plugin/test/e2e/drive-new.mjs` (criteria 1-4 with
  the fake Google; Worker with `--var DRIVE_NEW:on`).
- Drive icons: `online/drive-icons/kurviq-{32,48,96,128,256}.png`, rendered from
  `online/brand/kurviq.svg`.

## Setup in the Google Cloud console

Project of Kurviq's OAuth client (Tecsteps account), signed in as its owner.

1. **APIs & Services → Enabled APIs → Google Drive API → Drive UI
   integration** (the tab already holds "Open with Kurviq"; keep its values):
   - Application name: `Kurviq`
   - Short description: `Hand-drawn diagrams and slides, saved in your Google Drive`
   - Long description: `Kurviq is a free online whiteboard built on Excalidraw:
     hand-drawn diagrams as named scenes, slides with a presenter view and
     formatted text. Scenes are .excalidraw files in your own Google Drive;
     share them like any Drive file, and let AI agents draw with you.`
   - Application icons: upload `online/drive-icons/kurviq-32.png`, `-48`,
     `-96`, `-128`, `-256` (PNG, transparent corners).
   - Open URL: `https://kurviq.com/drive/open` (unchanged)
   - Default MIME types: `application/vnd.excalidraw+json` (unchanged);
     Default file extensions: `excalidraw` (unchanged)
   - Check **Creating files**. New URL: `https://kurviq.com/drive/new`.
     Document name: `Kurviq scene`.
   - Importing: unchecked. Shared drives support: checked (Kurviq calls Drive
     with `supportsAllDrives=true`).
   - Submit.
2. **Google Auth Platform → Data access** (OAuth consent screen, scopes):
   `drive.install` must be listed next to `openid`, `email`, `profile`,
   `drive.file` (it is requested already; add it there if it is missing). It is
   a non-sensitive scope: no new verification for it.
3. Switch it on: in `online/wrangler.jsonc` set `"DRIVE_NEW": "on"`, commit and
   push (the deploy publishes it).
4. Check with the real Google: in Drive, open a folder → **New → More →
   Kurviq** (users who signed in before only see it after Drive picked up the
   new integration; signing in to Kurviq once more installs it again). Kurviq
   asks for the name, the file appears in that folder and opens; Kurviq's scene
   list shows it under "Other folders".

## Checks

- The route passes the state through without storing it; a wrong account gets
  the sign-in hint.
- The new file lands in the chosen folder and opens in Kurviq.

## Open

- Does Google require the Drive UI integration's "new" entry to be re-reviewed
  for the OAuth app (brand verification exists)? `drive.install` is
  non-sensitive and already granted, so probably not.
- To verify with the real Google: that `drive.file` lets Kurviq create the file
  in Drive's `folderId` (Google's guide says to set `parents` to it; the fake
  Google applies drive.file to the parent too, so its e2e grants the folder to
  the app first, as Drive is expected to when it opens Kurviq for it, and
  checks the refusal without that grant). If Drive answers
  404 there, the dialog says Kurviq may not create a file in this folder; then
  the fix is a Picker on that folder first.
- Whether Drive's `userId` always equals the OpenID `sub` (Google calls it "the
  profile ID"; both are the account id). If not, everyone gets the sign-in hint:
  then compare by `about.user` instead.

## Acceptance criteria

1. In Google Drive, New → More → Kurviq creates a scene in the folder where it was clicked, asks for its name and
   opens it in Kurviq, signed in as that account.
2. Signed in to Kurviq as another account: Kurviq says which account to sign in with; nothing is created.
3. The new scene is listed in Kurviq's scene list (group "Other folders") and opens from there after a reload.
4. Kurviq's server keeps nothing of the request (the state is only passed to the app).
