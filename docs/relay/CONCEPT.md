# Kurviq: one editor at a time on Drive scenes (the pen and the relay)

Nov 13, 2026 · implements `specs/2026-11-13-drive-collaboration-without-server-data.md`
("What happens when two people open the same scene", "Sign-in", "Migration" 1-2).
Replaces live sync (`docs/live-sync/*`, superseded).

## The rule

Kurviq's servers keep no customer data and no tokens. Scenes live in the
user's Google Drive and browser; the relay only passes encrypted messages
through memory. Saving is the normal Drive sync of the controller
(`scenes-plugin/src/controller.ts`: push after 10 s idle, pull / merge
element by element), done only by the tab that holds the pen.

## Parts

| Part | File | Keeps |
|---|---|---|
| Ticket route | `online/worker/sceneRoutes.ts` (`POST /relay/<fileId>/ticket`) | nothing: asks Drive with the session's token (from the encrypted cookie, for this request only) |
| Relay (one per Drive file) | `online/worker/relay.ts` (`SceneRelay`), `relayRoom.ts` (the pen's logic, pure) | memory only: who is connected (name, color, role), the holder, who asks, last activity. No storage calls, no WebSocket hibernation (`server.accept()`), no alarms |
| Client | `scenes-plugin/src/online/pen.ts`, `penSync.ts` (pure helpers), `penUI.tsx` (the bar), `sceneKey.ts` (the scene key, payload encryption) | the tab's own state |
| Drive mark | `appProperties.kurviqPen` on the scene's file (`drive.ts` `readPenMark` / `writePenMark`) | `{"n": name, "t": time, "i": tab}` in the user's Drive, metadata only |
| Retired live sync | `online/worker/scene.ts` (`SceneRoom`, drain only), `drain.ts` | until drained: what it held before; then nothing |

## Joining a scene

1. The open Drive scene's tab asks `POST /relay/<fileId>/ticket` (cookie, or
   the local install's sealed session). The Worker reads the file with the
   person's own token: `capabilities.canEdit` → role `edit` (may hold the
   pen), `canComment` → `comment`, else `read`; Drive refusing ("not found" for
   `drive.file`, 403) → 403. A Google rate limit or outage is 503 ("try
   again"), never "no access". It answers a ticket sealed with `COOKIE_KEY`
   (valid 60 s: file id, name, color, role, the comment author key, the email
   for commenters), and the scene's key from the file
   (`appProperties.kurviqKey`), if there is one. Nothing is written.
2. The tab opens `wss://…/relay/<fileId>/live?ticket=…`. The Worker checks the
   ticket (file, expiry, origin) and hands the claims to the relay object in a
   header; the relay is reachable only through the Worker.
3. The relay welcomes the tab and tells everyone who is there and who holds
   the pen. **Whoever opens the scene first edits it**: a tab whose first
   state shows a free pen claims it. The relay handles one message at a time,
   so of two claims exactly one wins.

The scene's key: if the file has none, the holder's tab asks for a ticket
with `createKey` (only an editor's request makes one, and only the holder
asks, so never two at once); the Worker writes it to the file and reads it
back. The holder then sends `key` ("ready", nothing secret); the others fetch
a fresh ticket, which carries the key now.

## The pen

| Who | Message | Relay |
|---|---|---|
| an editor | `claim` | free → holder; else refused ("held") |
| an editor | `ask` | free → holder; else the holder gets `asked` (name, color) |
| the holder | `decline {to}` | the asker hears "keeps editing" |
| the holder | `handover {to}` (after saving to Drive) | `to` becomes holder (`granted`) |
| an editor | `takeover` | allowed when the holder is idle 5 minutes, or it is the same account's other tab; the old holder hears `taken` |
| the holder | `release` ("Stop editing", after saving) | the pen is free |
| the holder | `active` (on its user's input, at most every 30 s) | resets the idle clock |
| anyone | `ping` | `pong` |

The relay drops a participant silent for 2 minutes (a sweep every 20 s); a
closed socket goes at once, and the holder's pen with it. The holder idle
for 5 minutes is announced (`idle`), so others see "Take over".

## Payloads (end to end encrypted)

`{t: "send", kind, body, to?, req?, part?, parts?}`: the body is AES-GCM with
the scene's key, additional data `kurviq-relay:<fileId>:<keyId>:<kind>`
(`sceneKey.ts`). The relay forwards it unread, with the sender's identity from
the ticket:

| kind | from → to | content |
|---|---|---|
| `change` | holder → everyone | elements whose stamp changed, new images, settings, comments (every 60 ms while drawing) |
| `pointer` | holder → everyone | the holder's pointer (scene coordinates); shown with name and color (Excalidraw collaborators) |
| `catchup-req` | anyone → holder | asks for what isn't saved yet |
| `catchup` | holder → one tab | the whole canvas (incl. deleted elements), its images, settings, comments, and the Drive version it is based on |
| `saved` | holder → everyone | after each save: the Drive version (md5) and the canvas hash, the others' new base |
| `ops` | commenter / editor → holder | comment operations (`sendCommenterOps`); the relay adds the sender's comment key and email from the ticket |
| `result` | holder → one tab | the answer to an `ops` batch (`applied` or `refused`) |
| `key` | holder → everyone | "the key is on the file now" (plain) |

Big payloads go in parts of 400,000 characters (the relay takes 900,000 per
message); the receiver puts them together per sender and request.

## The tab

- **Holder**: edits as usual; the controller saves to Drive after 10 s idle;
  "Hand over" and "Stop editing" save first (if that fails, the holder keeps
  the pen and sees why). It renews the Drive mark every minute.
- **Viewer** (someone else holds the pen, or nobody and this tab didn't take
  it): the canvas is in view mode (re-asserted if switched off), the bar says
  "<Name> is editing · Ask to edit" (and "Take over" when allowed, "Edit"
  when the pen is free). The controller never writes the scene from this tab
  (`setPenLock`): pushes and merges are refused; a newer Drive version is
  pulled and the holder asked again for what isn't saved (`followDrive`).
  The holder's `saved` sets this tab's base, so a later handover starts from
  the right version.
- **Commenters** and **readers** follow live the same way; commenters' comments
  go to the holder (`sendCommenterOps`), or Drive's comments mailbox when no
  editor is there (see the spec's "Comments by commenters").
- **Agents** (MCP) edit only through the holder's tab: `penRefusal` refuses an
  agent's edit of the open scene in a viewer's tab ("Anna is editing this
  scene right now …"); for a scene that isn't open, someone else's fresh mark
  on its file refuses it. In a tab where nobody holds the pen, an agent's edit
  takes the pen first. Reading stays allowed.

## Without the relay: the mark on the Drive file

A tab that can't reach the relay (its ticket or socket fails; retried after
1, 2, 5, 10, 30 s) reads `appProperties.kurviqPen`: someone else's mark
younger than 2 minutes makes the scene read only ("Anna is editing · read
only here"); a stale or no mark lets this tab edit, and it sets its own mark
(renewed every minute). Two such tabs at the same moment can both edit; the
controller's merge is the safety net. The mark is metadata: no new Drive
version, the content's md5 stays. The fake Google leaves `modifiedTime`
alone for it; whether real Drive moves `modifiedTime` on an `appProperties`
update is to be checked once with a real account (the design doesn't depend
on it: tabs compare md5).

## Offline

A tab without the relay and without Drive keeps editing (its changes stay in
the browser). When it is back and someone else holds the pen, it first saves
its changes with the controller's merge (element by element; the same element
changed on both sides is decided by the clash setting: the newer edit, or a
conflict to decide with "keep both"), then turns read only: nothing is lost.
"Changed here" is decided by content against the base, never by version
numbers (the controller's dirty hash).

## Connections

Ping every 25 s; a connection that got nothing for 60 s and whose own sending
doesn't drain (`bufferedAmount`) is closed and opened again (progress, not a
fixed time); a socket without a welcome after 15 s too. The relay drops a tab
silent for 2 minutes.

## Retiring live sync

`LIVE_SYNC` is gone; no new live sessions are made. The old scene objects
(`SceneRoom`) are drain only (`online/worker/scene.ts`):

- `/drain` (an editor's ticket for a file still marked `kurviqSync`, or
  `POST /live/drain` with the owner's session, which walks the scenes the
  account guard knows; the app calls it once after sign-in): what the object
  holds that isn't in Drive is saved, as a new version when Drive still has
  the object's last save, else as a copy "<name> (unsaved live changes)" next
  to it; the file's `kurviqSync` mark goes; then every table, the alarm and
  the storage are deleted (`deleteAll`). The answer says what is left (0).
  An object that never existed stays empty (no table is created).
- Unsaved changes nobody can save (no token works) are kept, tried again
  daily with a token the object still holds, and given up 90 days after the
  last change (the old rule).
- `/forget` (sign out everywhere) drops the account's stored tokens.
- Everything else is refused (410).

The account guard keeps the sign-out-everywhere epoch; its list of old scene
ids only shrinks (each drained one goes).

## Follow-up release (after the drain is confirmed)

See the spec's Status: remove `SceneRoom`, `drain.ts` and the drain route with
a wrangler `deleted_classes` migration; then `TOKEN_KEY` is unread
(`PSEUDONYM_KEY` already is) and the account guard's scene lists go.
