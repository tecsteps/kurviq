# Working together on Drive scenes without keeping anything on our servers

Status: proposal, 2026-11-13; decisions of 2026-11-13 included (short links
and the sign-out record stay, one editor at a time, a memory-only relay)

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
