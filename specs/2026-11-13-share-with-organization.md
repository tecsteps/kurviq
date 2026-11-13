# Share with your organization

Status: proposal (Should), 2026-11-13

## Why

"Anyone at tecsteps.com with the link" is the usual setting in companies.
Drive's own dialog offers it; Kurviq's share panel doesn't.

## How

- A fourth option under "General access", shown only for Google Workspace
  accounts (not gmail.com): "Anyone at tecsteps.com with the link can view /
  comment / edit".
- Drive permission `{ type: "domain", domain: "<the user's domain>", role:
  reader | commenter | writer, allowFileDiscovery: false }` (set by
  `setLinkAccess`; `linkAccessOf` reads it back, a domain permission next to an
  "anyone" one shows both).
- Opening such a link is like opening a shared scene (`/s/<fileId>`, Google's
  picker grant once).
- Nothing stored.

## Checks

- Unit: `linkAccessOf` with domain permissions; the option is hidden for
  gmail.com.
- With the fake Google: a colleague of the domain opens the link, someone
  outside can't.

## Acceptance criteria

1. For a Workspace account (e.g. @tecsteps.com) General access offers "Anyone at tecsteps.com with the link can
   view / comment / edit"; for @gmail.com accounts the option is absent.
2. Choosing it creates a `domain` permission with that role and `allowFileDiscovery: false`; the panel shows it
   after reopening.
3. A signed-in person of the domain opens the scene link (after the picker grant once) with that role; a person
   outside the domain can't.
4. Switching back to "Only people added here" removes the domain permission.
