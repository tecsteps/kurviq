# The local install on https

Status: proposal (Should), 2026-11-13

## Why

On plain `http://draw.test` the browser offers no Web Crypto (`crypto.subtle`).
Live sync stops there today ("Live sync needs a secure page"), and the relay of
the Drive spec (`2026-11-13-drive-collaboration-without-server-data.md`)
encrypts its messages end to end with Web Crypto too, so the local install would
stay without "together, live". Comments work without it (a SHA-256 fallback
exists for author keys).

## How

- `npm run setup:domain` sets up `https://draw.test` (`herd proxy draw
  http://localhost:3001 --secure`); `SCENES_APP_URL` follows. kurviq.com's
  sign-in already accepts `https://*.test` as a local address.
- The browser treats https://draw.test as a new site: scenes kept only in the
  browser (local-only) stay behind at http://draw.test. A one-time "Move my
  browser scenes" action: the old site exports them as one file, the new site
  imports it (both in the user's browser; nothing passes a server). Scenes in
  Drive come back by themselves after signing in.
- The README's setup section and the troubleshooting note are updated.
- Alternative for people without Herd: `http://localhost:3001` (a secure origin
  for browsers), with the same move.

## Checks

- On https://draw.test: `crypto.subtle` exists, the relay connects.
- The move carries every local-only scene (elements, images, fonts, comments).

## Acceptance criteria

1. `npm run setup:domain` serves the local install at `https://draw.test`; `crypto.subtle` exists there; sign-in
   with Google works from it.
2. "Move my browser scenes" on http://draw.test exports every local-only scene (elements, pictures, fonts,
   comments) as one file; importing it on https://draw.test shows the same scenes, unchanged.
3. The relay (live view, pen) works on https://draw.test.
4. README describes the setup and the move.
