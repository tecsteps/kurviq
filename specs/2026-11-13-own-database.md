# Your own database: real-time collaboration and guests without Google

Status: proposal, 2026-11-13; decisions of 2026-11-13 included (OAuth from
the start, one space per database, SMTP optional, public scenes as the
owner's choice)

## Idea

For advanced users, Kurviq can sync a scene to a database **they own**
instead of Google Drive. That unlocks what Drive can't give without Kurviq
keeping data (see `2026-11-13-drive-collaboration-without-server-data.md`):

- real-time collaboration like Excalidraw+: every stroke within a second,
  other people's pointers, selections and names on the canvas;
- sharing with people who have no Google account: invited by email, signed in
  with a one-time code sent by email (no usernames, no passwords).

Kurviq's servers stay out of it: the browser talks to the user's database
directly. Kurviq serves the app, nothing else.

## Where a scene lives

Each scene has exactly one home:

| Home | Who can open it | Collaboration |
|---|---|---|
| This browser only | Only here | None |
| Google Drive | People it is shared with in Drive (Google accounts) | Merge within seconds; optional live relay (see the Drive spec) |
| Your database ("Team space") | People invited by email (with or without Google) | Real time, pointers, presence |

- **Default for new scenes:** a setting ("New scenes are kept: in this
  browser / in Google Drive / in <database name>"), next to today's sync
  settings.
- **Switching an existing scene:** the scene panel gets "Move to…" with the
  three homes. Moving copies everything (elements, images, fonts, comments,
  presentation settings) to the new home, opens it there, and offers to delete
  the old copy (Drive: to Drive's bin; database: deleted; browser: removed).
  Links to the old home show "This scene moved" with the new link (Drive: an
  `appProperties` mark on the old file before it goes to the bin; database: a
  small "moved" row).
- The scene list shows each scene's home with an icon (browser / Drive /
  database), as it shows the cloud and lock today.

## Which database

Kurviq talks to the database through an adapter. The first one should be the
one that is easiest to set up with a free tier:

| Option | Free tier | Real time | Email codes | Setup | Verdict |
|---|---|---|---|---|---|
| **Supabase** (Postgres) | 2 projects, 500 MB database, 1 GB files, 50k monthly users; free projects pause after a week without use | Realtime: broadcast, presence, database changes | Built in (email one-time codes); the default mailer is limited to a few mails per hour, a free SMTP (e.g. Resend) lifts it | One click with "Connect Supabase" (OAuth), or paste URL + key | **First adapter** |
| Firebase (Firestore) | Generous, no pause | Yes | Email links (not codes), codes via extension | Project + config paste | Second adapter if asked for |
| Your own Cloudflare (Kurviq's live sync in the user's account) | Free plan has Durable Objects with storage | Yes (today's live sync code) | Needs a mail service | "Deploy to Cloudflare" button | For technical teams; reuses the engine we have |
| PocketBase (self-hosted) | Own server | Yes | Plugin | Needs hosting | Not for "easy" |
| Convex / InstantDB | Free tiers | Yes | Partly | Paste config | Possible later; smaller ecosystems |

Supabase's pause after a week of inactivity is the main risk on the free
tier: Kurviq shows "Your database is paused: open Supabase to wake it" when it
can't connect, with a link to the project.

## Setup (Supabase): "Connect with Supabase" from the start

Supabase lets apps act on a user's projects through an OAuth app
([guide](https://supabase.com/docs/guides/integrations/build-a-supabase-oauth-integration)):
registered in Kurviq's Supabase organization (Settings → OAuth Apps), then
published. The guide names no review or approval step.

**Scopes** (chosen when the app is registered; changing them later means
every user authorizes again):

| Scope | For |
|---|---|
| Projects: write | Create a project ("Create a project") |
| Database: write | Run Kurviq's schema ("Create a SQL query") |
| Secrets: read | Read the project's API keys (the public anon key) |
| Auth: write (optional) | Set a custom SMTP for invitation emails |

**Flow:**
1. Settings → "Connect a database" → **Connect with Supabase** (Supabase's
   button, as its brand guidelines ask).
2. Supabase asks the user to allow Kurviq (PKCE, as Supabase recommends).
3. The code comes back to Kurviq. The token exchange needs Kurviq's client
   secret, so it goes through Kurviq's Worker the way Google sign-in does:
   the Worker adds the secret, passes the tokens to the browser and keeps
   nothing (no database row, no cookie for Supabase tokens).
4. In the browser: the user picks an existing project or "Create a new one"
   (region, name). A new project needs a database password: Kurviq generates a
   strong one, shows it once ("keep it in your password manager") and doesn't
   keep it; Kurviq itself never needs it (it talks to the project through
   Supabase's API with the anon key, not to Postgres directly).
5. Kurviq runs its schema (tables, row-level security, storage bucket,
   realtime settings), reads the anon key, and is done with the management
   token: it is dropped. A later schema upgrade asks the user to connect again
   ("Kurviq needs to update your database: Connect with Supabase").
6. Kurviq stores the connection (project URL, anon key, a name like
   "Tecsteps team") in the browser, and in the user's Google Drive app data
   (`appDataFolder`, a hidden per-app file) if they are signed in with Google,
   so it follows them to other browsers. Never on Kurviq's servers.

Fallback without OAuth (also for self-hosted Supabase): Kurviq shows the SQL
script to paste into Supabase's SQL editor and asks for URL and anon key.

**Email for codes** (decided: optional, suggested for teams): the setup
works with Supabase's built-in mailer. When invitations hit its hourly limit,
Kurviq shows how to add a custom SMTP (for example Resend's free tier); with
the optional Auth scope it can set it for the user.

## Data model (in the user's database)

One space per database (decided): a second team connects a second database
(Supabase's free tier allows two projects).

```
space         (name, created_at, settings jsonb)          -- exactly one row
members       (email, role: owner|editor|commenter|viewer, invited_by, created_at)
scenes        (id, name, public: none|view, created_by, created_at, updated_at, deleted_at)
scene_access  (scene_id, email, role, expires_at)          -- per-scene sharing on top of space roles
elements      (scene_id, id, version, version_nonce, data jsonb, updated_by, updated_at)
scene_meta    (scene_id, settings jsonb, presentation jsonb, fonts jsonb)
comments      (scene_id, id, thread, data jsonb, u, updated_by)  -- the same shape as kurviqComments
versions      (scene_id, id, name, snapshot jsonb, created_by, created_at)  -- milestones
files         (storage bucket "scene-files": images by content hash)
```

- Row-level security: every table checks the signed-in user's email against
  `members` / `scene_access`; editors write elements, commenters only their own
  comments (the same rules as `scenes-mcp/sceneComments.mjs`, as SQL policies
  or a small database function), viewers read.
- `elements` are rows, so two people changing different elements never
  conflict; the same element: the higher `version` wins (Excalidraw's own
  reconciliation, the same as its collaboration).
- Optional end-to-end encryption: content columns encrypted with a scene key
  that lives only in the share link's `#` part (never sent to any server, also
  not to the database owner's logs). Off by default (the database belongs to
  the user anyway), on for sensitive scenes.

## Real time

- **Changes:** a tab writes changed elements as rows (batched every 100 to
  200 ms during a gesture), and broadcasts them on the scene's realtime channel
  at the same time, so others see them before the database confirms.
  Late joiners load rows, then follow the channel.
- **Pointers, selections, presence:** realtime presence and broadcast only
  (nothing written to tables): name, color, pointer position, selected ids,
  "is typing". Throttled to about 20 updates per second.
- **Offline:** changes queue in the browser (as live sync's queue does today)
  and are written when back; conflicts per element by version.
- The existing live sync client (`scenes-plugin/src/online/liveSync.ts`) is
  the model: an adapter with the same surface (`attachCanvas`, `changeComment`,
  queue, conflict handling) but Supabase underneath.

## Sharing with people without Google

- **Invite:** the scene's share panel (or the space's members list) takes
  email addresses and a role. The invitee gets an email (sent by the user's
  database: Supabase's auth mailer, or their SMTP) with a link
  `https://kurviq.com/db/<project ref>/<scene id>#k=<anon key>` (the key in the
  `#` part never reaches Kurviq's server).
- **Sign in with email + code:** the link opens Kurviq, which asks for the
  email address, Supabase sends a 6-digit code, the user types it. No
  password, no Google account. The session lives in the browser (Supabase's
  tokens in local storage).
- **People with Google accounts** can use "Continue with Google" (Supabase's
  Google provider) instead of the code.
- **Removing access:** delete the member row; open sessions lose access at
  their next request (row-level security), realtime channels are left by the
  client when a request is refused.
- **Expiring access:** `expires_at` on `scene_access`, checked by the policies.
- **Public scenes** (decided: the owner's choice per scene, off by default):
  `scenes.public = view` lets anyone with the link read the scene (a policy
  for Supabase's anonymous role on that scene's rows and files), read-only,
  no account needed. Comments stay for members only.

## Agents (MCP)

Agents work through the user's open Kurviq tab, as today: the tab reads and
writes the database with the user's session. Nothing changes for the MCP tools
except that a scene's home can be a database.

## What stays on Kurviq's servers

Nothing new. The app is served as before; the database is the user's; email
codes are sent by the user's database. Kurviq's servers never see the
database's content, keys (except the public anon key in the link's `#` part,
which isn't sent to the server) or sessions.

## Steps

1. Adapter interface: what a scene home must offer (load, save or stream
   changes, files, comments, presence, sharing), with today's "browser" and
   "Google Drive" homes behind it.
2. "Connect with Supabase" (OAuth app, the Worker's stateless token exchange,
   project creation, schema), plus the paste-URL-and-key fallback.
3. Supabase adapter: a scene in the database, real-time changes, pointers and
   presence.
4. Sharing: members, invites by email, email-code sign-in, roles, comments
   with the same rules, public scenes.
5. Settings: default home for new scenes; "Move to…" for existing scenes
   (all three directions), moved markers.
6. Optional: end-to-end encryption per scene; Firebase adapter; "your own
   Cloudflare" deploy.

## Open questions

Decided (2026-11-13): OAuth from the start; one space per database; a custom
SMTP is optional (suggested when invitations hit the limit); public scenes are
the owner's choice per scene.

Still open:
- Supabase's free-tier figures in the table (database and file sizes, the
  pause after a week, the mailer's limit) are from memory: check them before
  the setup texts are written.
- What "publishing" an OAuth app involves at Supabase (the guide only says
  "once you've published your OAuth App").

## Acceptance criteria

**Scene homes**
1. Settings has "New scenes are kept: in this browser / in Google Drive / in <database>", the choice is used for
   new scenes and survives a reload.
2. Every scene shows its home (icon) in the scene list and the pill.
3. "Move to…" moves a scene between any two homes with everything (elements, pictures, fonts, comments, slides,
   presentation settings); the old place gets a "moved" note (a link to it opens the new place); deleting the old
   copy is offered.

**Connect Supabase**
4. "Connect with Supabase" runs Supabase's OAuth (PKCE), lists the user's projects, can create a new one (password
   shown once, not stored by Kurviq), runs the schema, and ends with a working connection; the management token is
   not kept anywhere (browser storage checked).
5. Kurviq's Worker only exchanges the code (adds the client secret) and stores nothing (route code + test).
6. The fallback (paste URL + key after running the shown SQL) works the same.
7. The connection (URL, anon key, name) is in the browser and, if signed in with Google, in Drive's app data; a
   second browser of the same Google account sees it.
8. A paused free project shows "Your database is paused: open Supabase to wake it".

**Real time**
9. Two people on the same database scene see each other's strokes within a second, their pointers (name, color)
   and selections; edits of different elements never conflict; the same element: the later version wins, nothing
   else is lost.
10. Offline edits queue and are written when back.

**Sharing outside Google**
11. Inviting an email address with a role sends an invitation (from the database's mailer); the invitee opens the
    link, enters their email, gets a 6-digit code, and is in with exactly that role (viewer can't edit, commenter
    only comments, editor edits).
12. Removing a member ends their access at their next request; an expiry date ends it at that date.
13. A public database scene ("anyone with the link can view") opens without an account, read-only, without
    comments.

**Nothing on Kurviq's servers**
14. No database content, keys (besides the public anon key in the link's `#`) or sessions pass through Kurviq's
    servers (network check: the browser talks to supabase.co directly).

**Agents**
15. `read_scene` / `edit_scene` work on database scenes through the user's tab, comments included.
