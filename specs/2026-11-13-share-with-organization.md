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
