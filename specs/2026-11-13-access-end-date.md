# Access with an end date

Status: implemented 2026-11-13 (with the fake Google; the open question below is still open). Rows of
viewers and commenters (people and groups) in the share panel: "Access until…" (a date field, today to a
year ahead; the access ends at the end of that day in the user's time zone), "until 30 Nov · Change · No end
date"; `drive.ts` `setAccessEnd` PATCHes `expirationTime` (or `removeExpiration=true`) with the role. Editors'
rows show an end date Drive has, without the control. The fake Google takes `expirationTime` on user
permissions (future, at most a year ahead; `/admin/share` also takes a past one) and an expired permission
gives no access and is no longer listed. Tests: `scenes-plugin/test/shareAccess.test.ts`, e2e
`scenes-plugin/test/e2e/share-panel.mjs`.

## Why

External reviewers or customers get access for the length of a project, and it
ends without anyone having to remember.

## How

- Drive permissions take an `expirationTime` (people and groups; viewers and
  commenters, not editors).
- In the share panel, rows of viewers and commenters get "Access until…" (a
  date field); Kurviq PATCHes the permission (`changeRole` already PATCHes).
  The row shows "until 30 Nov"; "No end date" removes it.
- Kurviq doesn't invite people itself (Drive's own dialog does); it sets the end
  date on access that exists.
- Nothing stored.

## Checks

- Unit: the PATCH body, the row text.
- With the fake Google: an expired permission no longer opens the scene (the
  fake needs `expirationTime` support).

## Open

- Does Drive accept `expirationTime` on `drive.file` files for all account
  types (consumer and Workspace)?

## Acceptance criteria

1. In the share panel, a viewer's or commenter's row offers "Access until…"; setting a date shows "until <date>"
   and Drive's permission has that `expirationTime`.
2. "No end date" removes it. Editors' rows don't offer it.
3. After the date (fake Google: an expired permission) the person can no longer open the scene.
