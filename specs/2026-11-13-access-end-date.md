# Access with an end date

Status: proposal (Should), 2026-11-13

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
