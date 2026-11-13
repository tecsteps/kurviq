# Kurviq: feature ideas (MoSCoW)

Status: living list, updated 2026-11-13 (Must and Should items have a spec each
in `specs/`; Must 1 is superseded by the two collaboration specs)

What Kurviq could build next, based on what Google Drive offers with Kurviq's
current permission (`drive.file`: only files Kurviq created or the user opened
with it; no broader scope, so no Google security assessment) and on the gaps
found while building sharing and comments.

**Data rule:** Kurviq's servers keep no customer data and no tokens, not even
temporarily (`specs/2026-11-13-drive-collaboration-without-server-data.md`).
Scenes live in the user's Google Drive, their browser, or their own database
(`specs/2026-11-13-own-database.md`). The accepted exceptions: short links
(name → file id), the sign-out-everywhere record (account id + time),
anonymous statistics counters, and messages people send to Kurviq on purpose
(feedback, contact).

---

## Must have

| # | Feature | Why | Spec | Status |
|---|---|---|---|---|
| 1 | ~~Live sync for everyone~~ | Superseded: on Drive, one editor at a time with a memory-only relay (live view for everyone else; implemented, `docs/relay/CONCEPT.md`); real-time co-editing with your own database | `2026-11-13-drive-collaboration-without-server-data.md`, `2026-11-13-own-database.md` | superseded (Drive part implemented) |
| 2 | Thumbnails in Google Drive | Drive and the picker show scenes as an empty checkerboard | `2026-11-13-drive-thumbnails.md` | proposal |
| 3 | Scene text searchable in Google Drive | Drive's search finds a scene by its words, not only its name | `2026-11-13-drive-search-text.md` | proposal |
| 4 | Email notifications for comments | Without them comments go unnoticed; redesigned without any storage on our side (no digests) | `2026-11-13-comment-notifications.md` | proposal |

## Should have

| # | Feature | Why | Spec | Status |
|---|---|---|---|---|
| 5 | Share with your organization | "Anyone at tecsteps.com with the link" is the usual company setting | `2026-11-13-share-with-organization.md` | proposal |
| 6 | "New → Kurviq scene" inside Google Drive | Start a scene in a project folder, from Drive | `2026-11-13-new-scene-from-drive.md` | proposal |
| 7 | Access with an end date | Reviewers' access ends by itself | `2026-11-13-access-end-date.md` | proposal |
| 8 | Comment polish | Shortcut, filters, unread, counts; the review's comment findings | `2026-11-13-comment-polish.md` | proposal |
| 9 | The local install on https | Web Crypto for the relay's end-to-end encryption; "Move browser scenes…" takes local scenes to the new address | `2026-11-13-local-install-https.md` | implemented |

---

## Could have

- **Link previews in Google Docs, Chat and Gmail** ("smart chips" through a
  Google Workspace add-on): a pasted Kurviq link shows the scene's thumbnail
  and name. Strong for adoption; needs a Marketplace listing and Google's
  review.
- **Named versions** ("Before the workshop"): a Drive revision kept forever
  with a name, built on the existing history and milestones.
- **Team shared drives**: scenes and folders that belong to a company, not a
  person. The API calls already pass the shared-drive flags; folders and
  sharing there are untested.
- **What changed since my last visit**: highlight others' changes when you
  come back, from Kurviq's own history (Google's Activity API would need an
  extra permission).
- **Approval flow** on top of comments: "Ready for review" → reviewers resolve
  → "Approved", with the date and names in the file.

## Won't have (for now)

- **A broader Drive permission** (reading all of the user's files): Google's
  security assessment and more distrust from users, for little gain.
- **Sending invitations through the Drive API**: they landed in recipients'
  spam; Drive's own Share dialog stays.
- **Google's in-page share dialog** (ShareClient): hangs when Kurviq's
  account isn't the browser's first Google account (tested 2026-11-13).
- **Drive's own comments as the place comments live**: comments stay in the
  scene file (they travel with copies and versions); Drive's comments serve only
  as a mailbox for commenters' comments (Drive spec).
- **Drive labels** (admin-managed metadata): only fits organizations that
  already use them.
