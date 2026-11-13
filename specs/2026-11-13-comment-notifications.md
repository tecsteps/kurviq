# Email notifications for comments

Status: postponed (decided by Fabian, 2026-11-13: "leave notifications out for now"); proposal (Must),
redesigned for the rule "no customer data on our servers, not even temporarily". Open before building it:
the mail service (Postmark was recommended for its suppression API; Cloudflare Email Service as the
alternative without a new account).

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

## Acceptance criteria

1. Mentioning a person (`@Name`, picked from the suggestions) sends that person one mail
   "<Name> mentioned you in '<Scene>'" with a link that opens the scene with the thread open.
2. A new thread mails the scene's owner (not the author themself); a reply mails the thread's other participants
   once; the same thread mails nobody twice within 10 minutes.
3. The mail contains no comment text.
4. `POST /api/notify` refuses: without sign-in (401), without access to the file (403), with permission ids that
   aren't the file's (they are ignored), and it never writes D1 or Durable Object storage (code review + a test).
5. An unsubscribe link stops further mails to that address (the mail service's suppression), nothing stored by
   Kurviq.
6. For a scene in the user's own database, the database sends the mail (no call to Kurviq's server).
