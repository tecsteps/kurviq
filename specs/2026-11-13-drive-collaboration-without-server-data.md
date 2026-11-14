# Working together on Drive scenes without keeping anything on our servers

Status: proposal, 2026-11-13; decisions of 2026-11-13 included (short links
and the sign-out record stay, one editor at a time, a memory-only relay).
Implemented 2026-11-13: one editor at a time (the pen, the memory-only relay,
the Drive mark, offline, agents), the relay path for commenters, sign-in
without stored tokens for it, migration steps 1-2 (live sync retired, its
scene objects drain only); see `docs/relay/CONCEPT.md` and "Follow-up
release" below. The public viewer, shared folders and the comments mailbox:
see their own notes below.

## The rule

Kurviq's servers keep **no customer data and no tokens**, not even for a
moment in a database: no scene content, no comments, no Google sign-ins.
Scenes live in the user's Google Drive and in their browser. What our servers
may do is serve the app and pass messages through memory without writing them
anywhere (and even that only where a feature needs it, see "Together, live").

Accepted consequence: on Drive scenes, collaboration is not as instant as in
Excalidraw+ or Figma. The second spec (`2026-11-13-own-database.md`) unlocks
full real-time collaboration for those who connect a database of their own.

## What breaks the rule today (inventory)

| Part | What it keeps | Change |
|---|---|---|
| Live sync, scene object (`online/worker/scene.ts`, `SceneRoom`) | Encrypted working copy and pending changes of the scene (up to 90 days if unsaved), editors' sealed refresh tokens (`tokens`), on-behalf records, Drive watch channels | Replaced (see below); storage emptied and the class retired |
| Account object (`account.ts`) | Ids of an account's live scenes, sign-out-everywhere records | Live scene ids go; the sign-out-everywhere record stays (decided: an account id and a time, no data) |
| Shared folders (`folders.ts`) | The folder owner's sealed refresh token, members as keyed hashes | Replaced: no owner token on the server (see "Shared folders") |
| Public scenes (`shared.ts`) | Whole scene file in Cloudflare's edge cache for 60 s | The viewer reads from Drive directly in the browser; the server only answers name lookups for link previews, uncached |
| Short links (D1 `pub_links`) | Short name → Drive file id | Stays as the one accepted exception (decided: metadata, no content, nothing about who) |
| Feedback, contact (D1) | Messages people send to Kurviq on purpose | Not scene data; stays, with its retention (1 / 2 years) |
| Statistics | Hourly counters | Stays (no customer data) |
| Agent pairing (`pairing.ts`) | Nothing besides the open connections | Stays |

## What happens when two people open the same scene

**Decision: one editor at a time.** Whoever opens a scene first may edit it;
everyone who opens it while that person is there sees it read-only and live,
and can ask for the edit right. Real-time co-editing (several people drawing
at once) is what the own database is for (`2026-11-13-own-database.md`).

This removes most of the hard parts: no merging of parallel edits, no conflict
copies, no deciding which of two changes to one element wins.

### The edit right ("the pen")

- **Who holds it:** the first person to open the scene for editing (with
  Drive's edit permission). Everyone else gets the scene read-only with a bar:
  "Anna is editing · Ask to edit".
- **Handing it over:**
  - *Ask to edit*: Anna sees "Ben asks to edit · Hand over / Keep"; handing
    over makes Ben the editor (Anna's tab saves first, then switches to
    read-only).
  - *Take over* (after the holder has been idle for 5 minutes, or isn't
    connected): for when someone forgets a tab open.
  - The holder can also hand it back ("Stop editing").
- **Leaving:** closing the tab (or 2 minutes without a sign of life) frees the
  pen; the next person who wants it clicks "Edit".

### Who decides, without races: the relay

Drive can't decide this safely: it has no "write only if nobody changed it in
between", so two people clicking "Edit" at the same moment could both win, and
writing a flag into the scene content would create a new Drive version for
every handover and make everyone reload.

So the decision is made by the **memory-only relay** (decided: acceptable,
nothing is written):

- A Durable Object per scene **without any storage**: no storage calls, no
  WebSocket hibernation (so not even connection data is written). It keeps in
  memory who is connected and who holds the pen. It handles one message at a
  time, so exactly one "Edit" wins. When the last tab leaves, it is gone.
- **Live view for everyone else:** the editor's tab sends its changes through
  the relay, end-to-end encrypted with the scene's key (kept on the Drive file,
  as today); viewers apply them at once, so they watch the scene change live.
  Pointers of the editor (and of viewers, "I'm looking here") are possible the
  same way.
- **Saving:** only the editor's tab saves to Drive, with its own sign-in, as
  in today's normal sync (after a short idle, and when handing over). The relay
  never touches Drive and holds no tokens.
- **Joining:** a newcomer loads the scene from Drive, then asks the editor's
  tab (through the relay) for what isn't saved yet.

### The mark on the file (fallback and memory)

For people who aren't connected to the relay (it is down, or a Kurviq version
without it), the pen is also noted on the Drive file:

- In the file's metadata (`appProperties.kurviqPen`: pseudonym and time,
  renewed every minute, stale after 2 minutes), not in its content: metadata
  changes create no new Drive versions and don't change the content's checksum.
- A tab that can't reach the relay and finds a fresh mark opens read-only
  ("Anna is editing"); with a stale or no mark it may edit and sets the mark.
  Two such tabs at the same moment can both win; then today's merge (element
  by element) is the safety net, as it is for offline edits.
- To verify: whether metadata updates change the file's `modifiedTime` (it
  only decides whether other tabs check again; it doesn't change the design).

### Offline and edits from elsewhere

- Someone who edited offline (or in a tab without the pen) and comes back:
  their changes merge into the file with today's merge before they lose the
  pen, so nothing is lost.
- Agents (MCP) edit through the user's tab: only the tab holding the pen
  accepts an agent's edit; otherwise the agent is told "Anna is editing this
  scene".

## Comments by commenters

Drive's commenters can't write the file. Without a server that saves for
them, their comments need an editor's browser:

- **The editor is there:** the comment goes through the relay; the editor's
  tab checks it (the commenter rules in `scenes-mcp/sceneComments.mjs`) and
  writes it into the file with its own sign-in. Recorded on the commenter's
  behalf in the file, as today. (Comments don't need the pen: anyone allowed to
  comment can, the pen holder writes them.)
- **Otherwise: Drive's own comments as a mailbox.** Commenters may create
  Drive comments on the file (the Drive API's comments, allowed with
  `drive.file`). The commenter's tab posts a Drive comment holding the Kurviq
  comment (as JSON in the comment text, marked). An editor's Kurviq, on its
  next check, takes such comments into the scene file (checked with the same
  rules, the author from Drive's comment author) and deletes the Drive comment.
  Until then the commenter sees their comment as "waiting for an editor".
  Nothing passes through Kurviq's servers.

## Shared folders

Today guests open a shared Kurviq folder through the server, which uses the
owner's stored sign-in (`drive.file` doesn't let a guest's Kurviq see files
the owner's Kurviq created). Without stored tokens:

- **First choice, to verify:** the guest picks the shared folder once in
  Google's picker. If picking a folder gives `drive.file` access to the files
  in it (Google's docs are not clear for existing files; test it), the guest's
  Kurviq works on the folder directly with the guest's own sign-in.
- **Fallback:** the guest picks the folder's scenes in the picker (several at
  once), and Kurviq lists them as a group. New scenes the owner adds later
  need another pick; the folder group shows "3 new scenes in this folder:
  open them".
- The owner's server-side registration and token go away either way.

## Sign-in

Kurviq's sign-in keeps the Google refresh token only in an encrypted cookie
(or, for the local install, in the session it holds itself), never in a
database. The only server-side record is "signed out everywhere at" per
account (an id and a time, no data), which stays (decided).

## Migration

1. New releases stop creating live sessions (`LIVE_SYNC` off), so no new data
   is stored.
2. Open live scenes are drained: every scene object saves what is pending to
   Drive (it can, it still has the tokens), then deletes everything
   (`DELETE` all tables, `deleteAll()`); a script walks all scene objects the
   account objects know.
3. Shared folders: owners' tokens are deleted; guests are asked to pick the
   folder (or its scenes) once.
4. Public viewer reads from Drive in the browser; the edge cache for scene
   content is turned off.
5. The privacy page states the rule and lists what remains (feedback and
   contact messages, statistics counters, short links if kept).

### Follow-up release (after the drain is confirmed)

The release that ships the relay leaves the old scene objects in a drain-only
form (`online/worker/scene.ts`): each saves what it still holds to Drive and
deletes everything, when an editor next opens its scene, when its owner's tab
calls `/live/drain` (once per account after sign-in), or with its own alarm.
Once that is confirmed in production:

- [ ] Confirm the drain: Fabian opens kurviq.com signed in (the app calls
      `/live/drain`); in the browser console
      `fetch("/live/drain", { method: "POST" }).then((r) => r.json())` answers
      `results: []` (nothing left the account guard knows) or only
      `state: "empty" | "drained"` with `left: 0`. Open each scene that was live
      once (an editor's ticket drains a file still marked `kurviqSync`).
- [ ] Remove `SceneRoom` (`scene.ts`), `drain.ts`, the `/live/drain` and
      `/drive/notify` routes and the client's drain call, with a wrangler
      migration `{ "tag": "v5", "deleted_classes": ["SceneRoom"] }` (deletes
      every remaining object's storage) and the `SCENE` binding.
- [ ] Then `TOKEN_KEY` (and `TOKEN_KEY_PREVIOUS`) is no longer read: remove it
      from the Worker, `online/secrets.mjs`, `dev-vars.mjs` and the Cloudflare
      secrets (`wrangler secret delete TOKEN_KEY`); `PSEUDONYM_KEY` is already
      unread (delete the secret). (The sign-out-everywhere retry of a Google
      revocation is gone already: it is tried within the request only.)
- [ ] The account guard drops its `scenes` / `connected` tables (only the
      epoch stays) and `AccountGuard` no longer needs `SCENE`.

### To check with the real Google

- Does an `appProperties` update (the pen's mark) change the file's
  `modifiedTime`? The fake Google doesn't move it (`pen.mjs` checks md5 and
  modifiedTime stay); the design doesn't depend on it (tabs compare md5).
  Check: open a scene, note `modifiedTime` in Drive's file details (or
  `files.get?fields=modifiedTime`), wait a minute with the scene open (the
  holder renews the mark), compare.
- A Drive rate limit on the ticket's `files.get` answers 503 (try again), as
  the fake does with a 429 fault.

## Decided (2026-11-13)

- Short links stay as the one exception (file id + name, no content).
- The sign-out-everywhere record stays (account id + time).
- One editor at a time; whoever wants to draw together connects a database.
- The memory-only relay is acceptable (encrypted messages pass through memory,
  nothing is written).

## Still to verify (by testing)

- Does picking a folder in Google's picker grant `drive.file` access to the
  files inside it?
- Does an `appProperties` update change the file's `modifiedTime`?

## Acceptance criteria

**No customer data or tokens on our servers**
1. After the migration, every scene Durable Object's storage is empty (`storage.list()` returns nothing), and no
   code path writes scene content, comments or Google tokens to Durable Object storage, D1 or KV (code review of
   `online/worker`: only short links, sign-out-everywhere records, statistics counters, feedback and contact
   messages are written).
   Status (2026-11-13): sign out everywhere keeps no token any more, not even sealed: Kurviq is revoked at
   Google within the request (three tries, about 17 s at most); if Google can't be reached, the epoch still ends
   every Kurviq session and the answer tells the person to remove Kurviq at
   https://myaccount.google.com/permissions. Account objects delete a token an earlier version kept for a later
   try (meta key `revoke`) when they next start; nothing seals tokens any more (only the drain still reads those
   the retired live sync sealed, until the follow-up release).
2. The relay Durable Object makes no storage calls and doesn't use WebSocket hibernation attachments (grep and a
   test of its class).
3. `TOKEN_KEY` and `PSEUDONYM_KEY` are no longer read by the Worker; the shared-folder tables hold no tokens (the
   folder registration and its tables are gone or empty).
4. The public viewer loads a public scene from Drive in the browser; `/api/public/<id>` doesn't serve scene
   content any more (it may answer name/version metadata for link previews, uncached content never).

**One editor at a time (the pen)**
5. The first person opening a scene with edit rights can edit; a second editor who opens it sees it read-only
   with "<Name> is editing · Ask to edit", and sees the editor's changes within about a second.
6. "Ask to edit" shows the holder "<Name> asks to edit · Hand over / Keep"; "Hand over" saves the holder's
   changes to Drive first, then the asker can edit and the former holder is read-only.
7. "Take over" is offered when the holder has been idle for 5 minutes or is disconnected, and works.
8. Two people clicking "Edit" at the same moment: exactly one gets the pen (relay decides).
9. Closing the holder's tab frees the pen within 2 minutes (or at once when the relay notices the close).
10. Only the holder's browser saves to Drive; the saved file contains the holder's changes; viewers never write.
11. A newcomer while the holder has unsaved changes sees them (catch-up through the relay).
12. Pointers: the holder's pointer is visible to viewers (name, color).
13. Relay unreachable: the Drive mark (`appProperties.kurviqPen`) decides; a fresh mark makes the scene read-only
    for others, a stale one (2 minutes) lets the next person edit.
14. Agents edit only through the pen holder's tab; an agent of a viewer is told who is editing.

**Offline and merges**
15. Edits made offline merge into Drive when back (element by element); nothing the other person saved meanwhile
    is lost; conflicting edits of the same element keep both (conflict copy).

**Comments by commenters**
16. A Drive commenter can add, reply to, resolve their comments while an editor holds the pen: the comment shows
    for everyone within seconds and is in the Drive file after the editor's next save, recorded on the
    commenter's behalf.
17. With no editor present: the commenter's comment goes to Drive's comments (mailbox), shows "waiting for an
    editor"; the next editor who opens the scene takes it into the file and removes the Drive comment.
18. A commenter can't change others' comments (text, pin, name, agent mark): the editor's tab refuses them
    (`commenterRefusal`).

**Shared folders without stored tokens**
19. A person a Kurviq folder is shared with gets its scenes after picking the folder (or its scenes) in Google's
    picker once; new scenes in the folder show as "new scenes in this folder: open them" if they need a pick.
20. Nothing about the folder or its owner's sign-in is stored on Kurviq's server.

**Kept**
21. Short links, sign-out-everywhere, statistics, feedback and contact still work as before.
22. The privacy page states what Kurviq stores (the exceptions above) and nothing else.
