# Email notifications for comments

Status: proposal (Must), 2026-11-13; redesigned for the rule "no customer data
on our servers, not even temporarily"

## Why

Without notifications a comment goes unnoticed until someone opens the scene.

Who should hear of what: @mentioned people (at once), the scene's owner (new
threads), the people in a thread (replies).

## The constraint

Kurviq's servers keep no customer data (`2026-11-13-drive-collaboration-without-server-data.md`):
no queue of pending mails, no list of addresses, no per-person settings on our
side. That rules out digests kept by Kurviq; mails go out at once or not at all.

## How (Drive scenes)

- **Who sends:** the browser of the person commenting asks Kurviq's Worker to
  send: `POST /api/notify { fileId, threadId, mentions: [permissionId…] }`.
- **Addresses:** comments store no addresses (a name and a key). The Worker
  checks the caller's access to the file with *their* Google sign-in and reads
  the file's permissions with it, to map the mentioned people (by permission id)
  and the owner to addresses. It never trusts an address sent by a browser.
  Nothing is written: the addresses live in memory for this one request.
- **Content:** "<Name> mentioned you in '<Scene>'" and a link to the thread
  (`#comment=…`). No comment text: it is scene content, and the mail leaves
  Google Drive.
- **Sending:** a transactional mail service (for example Postmark or Resend,
  EU region; Cloudflare's own `send_email` reaches verified addresses only).
  The service keeps its own delivery logs: a processor to name in the privacy
  page.
- **Opt-out without our storage:** the mail service's suppression list
  (unsubscribe link handled by the service). Per-scene "notify me" settings are
  not possible without storage; a later option is a setting in the person's own
  Drive (app data), read by their own browser to filter in-app hints, not mails.
- **Limits without our storage:** the Worker can't count per sender over time
  without storing; the browser limits itself (a thread at most once per 10
  minutes, at most 20 mails per hour per tab), and the mail service's rate
  limits are the backstop.
- **Commenters' comments through Drive's comments** (the mailbox in the Drive
  spec): Google itself emails the file's owner about new Drive comments. To
  verify: whether those mails are acceptable as the owner's notification
  (their text is Kurviq's JSON; a readable first line would help).

## How (database scenes)

The user's own database sends (`2026-11-13-own-database.md`): a database
function or Supabase Edge Function on new comment rows, with the database's
own SMTP. Digests and settings are possible there (it is their data).

## Checks

- Worker: refuses without access, with forged permission ids, and never stores
  (no D1 or Durable Object write in the route).
- An @mention mails the mentioned person once; a reply mails the thread's
  people; the owner gets new threads.

## Open

- Which mail service (EU region, price, suppression handling)?
- Are Google's own comment mails good enough for commenters' comments?
