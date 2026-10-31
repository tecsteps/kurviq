# Kurviq: Excalidraw scenes for humans and agents, synced with Google Drive

_Built on [Excalidraw](https://github.com/excalidraw/excalidraw). Unofficial, not affiliated with Excalidraw._

**Online, no install: <https://kurviq.com>** (see [Kurviq: the online version](#kurviq-the-online-version)).
This repo is its source, and also runs locally:

Local Excalidraw with **multiple scenes**, kept in your browser and, once
you sign in with Google, synced with your Google Drive, usable by humans
(the scene pill in the app) and agents (MCP tools).

Upstream code is kept **untouched** and is not part of this repo: `npm run setup`
clones it at the tested commits pinned in `scripts/setup.mjs`.

| folder | what |
|---|---|
| `excalidraw/` | upstream clone of excalidraw/excalidraw, **not modified** |
| `excalidraw-mcp/` | upstream clone of excalidraw/excalidraw-mcp, **not modified** |
| `scenes-plugin/` | the UI/logic, injected into `excalidraw-app` at build time by `scenes-plugin/vite.config.mts` (uses public `<Excalidraw/>` extension points only: `renderTopLeftUI` + custom `<Sidebar/>`s) |
| `scenes-server/` | tiny local Node server: relays the MCP server's requests (scenes, agent commands) to the open app, prints PDFs with headless Chrome, renders pictures headless when no tab is open. Stores nothing, see below |
| `scenes-mcp/` | MCP server = excalidraw-mcp's tools + scene tools (`tools.mjs`; `server.mjs` = local stdio server) |
| `online/` | **Kurviq**, the online version at <https://kurviq.com>: Cloudflare Worker (Google sign-in, public scenes, agent pairing, remote MCP), `llms.txt`, deploy config |

## Kurviq: the online version

<https://kurviq.com> is the same app as a website. No account, nothing to
install:

- **Without an account** your scenes are saved in your browser (localStorage
  and IndexedDB; Kurviq asks the browser to keep them permanently).
  Everything works: scenes, slides, formatted text, PDF export (via the
  browser's print dialog).
- **Sign in with Google** (optional; welcome screen or the scene list) to
  sync your scenes with your Google Drive, on all your devices, and to share
  them. Each scene is one file `<name>.excalidraw` (images embedded) in a
  folder **Kurviq** in your My Drive; Kurviq finds the folder by a hidden
  marker, so you may rename or move it. Kurviq asks only for `drive.file`
  (plus `drive.install` for "Open with"): it sees the files it created and
  the files you opened with it, nothing else in your Drive.

  Changes are saved about 10 s after you stop drawing; changes by others
  arrive within a minute and are merged element by element (see
  [Sync with Google Drive](#sync-with-google-drive)). Drive keeps old
  versions for about 30 days (**History**); deleted scenes go to Drive's
  bin. The sign-in stays: Kurviq keeps Google's refresh token in an
  encrypted, httpOnly cookie of your browser; its server stores nothing.
  **Sign out** under **Google Drive…** in the scene list forgets it in this
  browser (remove Kurviq's access altogether at
  <https://myaccount.google.com/permissions>).
- **AI agents (MCP):** click **MCP** (top left) for a prompt to give your
  agent (Claude Code, Codex, Cursor, Claude, …): it adds
  `https://kurviq.com/mcp` and signs in (OAuth). On first use your browser
  opens a Kurviq page where you allow the agent; the agent's client keeps
  its tokens, Kurviq stores nothing (the tokens are sealed by the Worker and
  name your browser's pairing). The agent then works through your open
  Kurviq tab: it reads, draws and edits your scenes (with or without
  Google), and its edits are merged with yours and saved to Drive by your
  tab. The tab must be open while the agent
  works. **Sign out all agents** gives your browser a new pairing, which cuts
  every agent off. The old personal link `https://kurviq.com/mcp/<key>` is
  refused (the agent is told to sign in). Agents find everything they
  need at <https://kurviq.com/llms.txt>.
  Images from the agent's machine (illustrations, screenshots): the agent
  uploads them with `curl --data-binary @image.png <upload address>` (from
  the MCP server's instructions) and adds them by the `fileId` it
  gets back; the Worker passes the file straight to the tab (nothing is
  stored), and the image's bytes never go through the model.

- **Share a scene:** **Share…** (the pen on the open scene, or the Slides
  sidebar). Add people by email (Can view / Can edit; Google emails them
  the Kurviq link), set **General access** ("Only people added here",
  "Anyone with the link can view", "Anyone with the link can edit"; editing
  still needs a Google account), change or remove access, **Copy link**,
  **Copy presentation link**, **Open in Drive**. There are no teams or
  spaces: sharing is per scene, and Drive's permissions are the only truth
  (sharing a file in Drive itself works the same). Links: your own scenes
  `kurviq.com/<scene>`, shared ones `kurviq.com/s/<fileId>/<name>` (the name
  is only for reading; renaming keeps the file, so links keep working).
  Old `kurviq.com/@<owner>/<scene>` links say they are from an older version
  and to ask for a new link.
- **Opening a shared link:** a scene open to "anyone with the link" can be
  viewed, presented and copied (**Make a copy**) without any account; the
  Worker reads it with an API key (`/api/public/<fileId>`, one-minute edge
  cache, up to 25 MB; the page is titled after the scene for link
  previews). Otherwise Kurviq asks you to **Sign in with Google**. Because
  of `drive.file`, Kurviq may not open a file shared with you until you
  allow it once: **Allow Kurviq to open it** opens Google's Picker with that
  file selected; click Select. Without the link: **Shared with you…** in the
  scene list opens the Picker on Drive's "Shared with me" (Kurviq scenes
  only); the scenes picked there are listed from then on (one picked opens
  right away), so Google's sharing email isn't needed. If you can edit, **Edit** opens it in the
  editor: your own scene among your scenes, someone else's in a space of its
  own for that one file (the tab reloads into it; **Back to my scenes**
  returns). Scenes shared with you that Kurviq may open are listed in the
  scene list with the owner's name. People without a Google account: Google
  asks invitees to create one for their address (no Gmail needed).
- **Open with Kurviq** in Google Drive (on an `.excalidraw` file) opens it
  in Kurviq (`/drive/open` → `/s/<fileId>`).
- **Share a presentation:** **Copy presentation link** (Share…) gives the
  scene's link with `?present`:
  it opens presenting (`&slide=3` starts at slide 3; skipped slides are
  left out). Browsers allow fullscreen only after a click, so it starts in
  the window with a **⛶ Fullscreen** button (or F); → / click next, Esc ends.
- **Kurviq's own decks:** <https://kurviq.com/features> shows everything
  Kurviq adds. Decks in `online/scenes/` (listed in
  `scenes-plugin/src/publicScene.tsx`) open at `kurviq.com/<name>` in the
  same viewer.

Differences to the local install: Excalidraw's live collaboration and
shareable links (excalidraw.com servers) are switched off, local file paths
can't be used by agents, and PDFs are made with the browser's print dialog. Kurviq is operated by
Tecsteps GmbH: [imprint](https://kurviq.com/imprint),
[privacy](https://kurviq.com/privacy) (no accounts, no tracking, no request
logs; the pages are in `online/pages/`).
- **Feedback:** the **Feedback** link (bottom right) sends a bug report or
  change request; agents can send one with `send_feedback`. Plain text only,
  limited length, at most 10 per hour; stored in a D1 database
  (`kurviq-feedback`, `online/worker/feedback.ts`). Running it yourself:
  `wrangler d1 create`, then put its id into `wrangler.jsonc`.

### Running Kurviq yourself (Cloudflare)

`npm run build:online` builds the app into `online/dist/app`; `online/` holds
the Worker (`worker/`), `wrangler.jsonc` and `llms.txt`.

- Local test: put `KURVIQ_GOOGLE_CLIENT_SECRET` (and `KURVIQ_GOOGLE_API_KEY`
  for public scenes) into `.env`, then `npm run dev:online`
  (http://localhost:8787).
- Google Cloud: a project with the Google Drive API and the Google Picker
  API. OAuth consent screen External and **In production** (in Testing,
  refresh tokens expire after 7 days), scopes `openid`, `email`, `profile`,
  `drive.file`, `drive.install`. A web OAuth client with the origins
  `https://<your domain>` (kurviq.com: also `https://www.kurviq.com`) and
  `http://localhost:8787`, redirect URIs `https://<your domain>/auth/callback`
  and `http://localhost:8787/auth/callback`. Drive UI integration ("Open
  with"): Open URL `https://<your domain>/drive/open`, MIME type
  `application/vnd.excalidraw+json`, extension `excalidraw`. An API key
  restricted to the Drive API (server side, public scenes) and a browser API
  key for the Picker. The public values (client id, browser API key, project
  number = the Picker's app id) go into `online/google.json`.
- kurviq.com is deployed by GitHub Actions
  ([`.github/workflows/deploy-kurviq.yml`](.github/workflows/deploy-kurviq.yml))
  on every push to `main`, with the repository secrets `CLOUDFLARE_API_TOKEN`
  and `CLOUDFLARE_ACCOUNT_ID`; don't deploy it from a local machine. (GitHub
  hosts the code and the deploy; scenes are never stored there.)
- Your own deployment: `cd online && npm install`, set the secrets once with
  `npx wrangler secret put GOOGLE_CLIENT_SECRET`,
  `npx wrangler secret put GOOGLE_API_KEY` and
  `npx wrangler secret put COOKIE_KEY` (value: `openssl rand -base64 32`);
  the var `GOOGLE_CLIENT_ID` overrides `online/google.json`'s client id;
  adjust `vars` and `routes` in `wrangler.jsonc`, then `npm run deploy:online`
  in the project root.

## Install with an agent

Paste this prompt into any coding agent (Claude Code, Codex, Cursor, …). It
installs everything end to end and checks that it works. Scenes are kept
in your browser and, once you sign in with Google in the app, in your Google
Drive: there is no repository to set up.

````text
Install Kurviq locally (https://github.com/tecsteps/kurviq) on this
machine end to end, and verify that it works. Work step by step, run the
commands yourself, and fix problems as you go. Ask me only when you need a
decision or something only I can do (such as logging in).

1. Prerequisites. Check and install what is missing, or tell me if you can't:
   - git, Node.js 18 or newer, yarn (classic) and pnpm
     (`corepack enable` provides both on recent Node versions)
   - Google Chrome or Chromium (used to print PDFs and to render scene
     images when no browser tab is open). If it is not in the default
     location, note its path for CHROME_PATH.

2. Get the code. Unless I said otherwise, clone into ~/kurviq:
   git clone https://github.com/tecsteps/kurviq.git ~/kurviq
   If the folder already exists, `git pull` instead.

3. Configure. `cp .env.example .env` (keep an existing .env, only add missing
   settings). Leave the ports as they are unless 3001 or 3101 is taken.
   For SCENES_APP_URL:
   - If Laravel Herd is installed (`which herd`): run `npm run setup:domain`
     and keep SCENES_APP_URL=http://draw.test
   - Otherwise set SCENES_APP_URL=http://localhost:3001

4. Install: `npm run setup`. It clones excalidraw and excalidraw-mcp at
   pinned commits and builds them; this takes several minutes. Do not modify
   the excalidraw/ or excalidraw-mcp/ folders.

5. Start: run `npm start` in the background, keep it running, and write its
   output to a log file. Wait until both are up:
   - `curl -s localhost:3101/api/scenes` returns JSON with a "scenes" list
   - `curl -s -o /dev/null -w "%{http_code}" localhost:3001` returns 200
     (the first start of the app can take a minute)

6. Register the MCP server under the name "excalidraw", for all projects,
   using the absolute path of scenes-mcp/server.mjs:
   - Claude Code: `claude mcp add excalidraw --scope user -- node <abs path>/scenes-mcp/server.mjs`
   - Codex: add [mcp_servers.excalidraw] with command "node" and that path
     as args to ~/.codex/config.toml
   - Other clients: add it to their MCP JSON config
     ({"mcpServers":{"excalidraw":{"command":"node","args":["<abs path>"]}}})
   For Claude Code also install the skill:
   `mkdir -p ~/.claude/skills && ln -sfn <abs path>/scenes-mcp/skill/excalidraw-scenes ~/.claude/skills/excalidraw-scenes`

7. Verify the MCP server end to end. The tools work through the app open in
   a browser: open the app URL in my browser (or ask me to) and keep it
   open. You may not see the new tools in this session yet, so talk to it
   directly over stdio: start
   `node <abs path>/scenes-mcp/server.mjs`, send the JSON-RPC messages
   initialize, notifications/initialized and tools/list (one JSON object per
   line), and check that the tools include list_scenes, save_scene,
   view_scene and delete_scene. Then call, through the same connection:
   a. list_scenes {}                        → no error
   b. save_scene {"name": "zz-install-check", "elements":
      "[{\"type\":\"rectangle\",\"id\":\"r1\",\"x\":0,\"y\":0,\"width\":200,\"height\":80,\"label\":{\"text\":\"It works\"}}]"}
                                            → the scene appears in the open app
   c. view_scene {"name": "zz-install-check"} → returns a PNG image
   d. delete_scene {"name": "zz-install-check"} → removes it again

8. Report back:
   - the app URL (http://draw.test or http://localhost:3001), which I should
     open in my browser, and that I can sign in with Google there (scene list
     → Sign in with Google) to sync my scenes with Google Drive
   - which agent clients you registered the MCP server with, and that I have
     to restart running agent sessions to get the tools
   - the result of every check in step 7, and anything you had to fix
   - how to start it later: `npm start` in the install folder
````

## Setup & run

```bash
git clone https://github.com/tecsteps/kurviq.git && cd kurviq
cp .env.example .env   # the defaults work
npm run setup     # clone (if missing) + install + build upstream repos, link node_modules
npm start         # scenes server (:3101) + app (http://draw.test)
```

Config lives in `.env` (template: `.env.example`, `.env.local` overrides):
`SCENES_SERVER_PORT`, `SCENES_SERVER_URL`, `SCENES_APP_URL`,
`KURVIQ_AUTH_URL`.

**Google sign-in for the local install** goes through kurviq.com
(`KURVIQ_AUTH_URL`, default <https://kurviq.com>): **Sign in with Google**
sends the local page to kurviq.com/auth/login with its own address as the
return address (localhost, 127.0.0.1, `*.localhost` and `*.test` are
allowed). It comes back with the session sealed in the URL fragment, keeps
it in localStorage and trades it for access tokens at kurviq.com/auth/token
(CORS for local origins only). Syncing with Drive then runs in the browser,
exactly as on kurviq.com. Signing in and refreshing the token need
kurviq.com to be reachable; drawing offline keeps working.

**Hostname `draw.test`:** the app runs on port 3001. Laravel Herd's nginx
forwards http://draw.test to it, live reload included. This is set up once with
`npm run setup:domain` (`herd proxy draw http://localhost:3001`) and undone with
`herd unproxy draw`. Without Herd, use http://draw.localhost:3001, which
works with no setup, and set `SCENES_APP_URL` to match. Browsers keep separate
storage per hostname, so local scenes on http://localhost:3001 don't show up
on draw.test. Everything synced to Google Drive does.

## Using it

The pill next to the menu (top-left) shows the current scene; a dot means
changes not in Drive yet. Click it for the scene list (type to filter or create;
click a scene to switch). Two panels open from there:

- **The pen** on the open scene manages it:
  - **Save**: save the current scene to Drive now (asks for a name the first time)
  - **Save as…**: save under a new name and continue there
  - **New**: new empty scene
  - **Share…**: who may open the scene, and its links (see
    [the online version](#kurviq-the-online-version))
  - **History**: the scene's versions in Drive (newest first, with who made
    them; Drive keeps them about 30 days). Click one to see it; **Restore this version** puts
    it back on the canvas as a normal edit: undo with ⌘Z, and it is saved as
    a new version, so nothing in the history is lost.
- **Google Drive…** (at the bottom of the list): sign-in, **Sync now**,
  the sync settings and the **Activity** log.
- **Rename · Duplicate · Delete**: in the pen's panel of the open scene.
  Rename and delete happen in Drive too (a rename keeps the file, its
  history and its links; a deleted scene goes to Drive's bin, restorable
  for 30 days). Offline they apply locally right away and reach
  Drive when it's back. Duplicate copies the scene incl. changes that aren't
  pushed yet; auto-sync pushes the copy. Delete only removes the version in
  Drive you have seen: if someone changed it there meanwhile, it is kept.
  A scene deleted on another machine disappears here too, unless you changed
  it locally (then it's kept and pushed again).
- **Discard local changes**: reload the scene from Drive

Scenes have URLs: `http://draw.test/<scene name>`. Agent edits arrive
within seconds through the sync (see README-AGENTS.md). The
"Try Excalidraw+" banner is hidden via `scenes-plugin/src/scenes.scss`.

### Slides

Every frame of a scene is a slide. **Slides** (top-left, next to the scene
pill) opens the deck:

- **Present** (or "From here" on a slide): fullscreen, editor hidden, the
  camera glides from slide to slide. Keys: → / Space / PageDown next (also
  the next click step), ← back, Home / End, a number + Enter jumps, G all
  slides, L laser pointer, B black screen, Esc ends. **Presenter** opens a
  second window with the current and next slide, speaker notes and a timer.
- **Add slide** (at the end of the list) adds a 16:9 frame (1920 × 1080)
  after the selected one. Drag slides in the list (or press ↑ / ↓ on one)
  to reorder; the active slide's card has icons for template on / off,
  back to template, duplicate and delete. On the
  canvas the slides always lie in deck order, seven per row: the canvas
  follows every change in the list. A duplicate keeps the slide's content,
  click steps and notes and goes right after its original; everything can
  be undone with ⌘Z. Per slide: title, "skip when presenting" (backup
  slides), "show template".
- **On the canvas**, after each slide's name: a list icon (shows the slide
  in the slide list) and the notes icon. The template's pen opens it for
  editing.
- **Speaker notes:** the notes icon after a slide's name (filled
  when there are notes) opens them in a popover, with formatting (bold,
  lists, colors, links … the same toolbar as text on the canvas). Saved as
  markdown in the slide; the presenter view shows them formatted.
- **Click steps:** select elements on a slide and pick "Click 1", "Click 2" …
  under "Selection appears"; they fade in one click at a time.
- **Template:** one "Template" frame holds what every slide shows: header,
  footer, logo, background, headline and eyebrow. Edit it once; every slide
  follows. Template texts can use `{page}` `{total}` `{title}` `{deck}`
  `{date}`. On slides the copies are locked (headline and eyebrow not: each
  slide writes its own words). What you change on one slide stays there,
  property by property: a headline colored by hand keeps its color and
  still follows the template's position and font. Select a changed copy
  and a **Changed here** bar lists its changes (text, color …): each goes
  back to the template on its own, also for several selected elements. The
  card's **back to template** icon does it for a whole slide, **Reset all
  slides** (Style tab) for the deck.
- **Headline & eyebrow:** every template has both (an older deck gets them
  once, when it opens): slides' own headlines where the template's goes
  become theirs (words kept, place and style from the template), other
  slides (a title slide …) keep their layout. Don't want the eyebrow?
  Delete it on the template. The template's **Body text** sample isn't on
  the slides: its font, size and color are the style of new text.
- **Deck style** is the template: style its elements with Excalidraw's own
  tools (there is no separate theme). The Style tab
  has Edit template, Reset all slides and the
  transition between slides (glide or cut).
- **PDF**: the whole deck, the selected slide or any slides ("1, 3-5"),
  one 16:9 page per slide, title slides and template included. Text stays
  real text (selectable, searchable) with the fonts embedded once, and
  pictures used on many slides (like the logo) are stored once: a 12-slide
  deck is about 300 KB. The scenes server prints it with your Chrome; if it
  can't, the browser's print dialog opens instead ("Save as PDF").
- Deleting a template element on one slide (unlock it, delete it) keeps it
  off that slide, on every device, until **back to template**.

All of it is stored in the scene itself, so decks sync, merge and travel
like any other scene, and agents can build them (see the skill). The scene
"Example - Presentation" shows what is possible.

### Formatted text

Text can be formatted in parts, like in a word processor: a bold title,
normal text, then bullets in a smaller size, all in one text or one
shape's label. While you edit a text, a toolbar above it offers size, bold,
italic, underline, strikethrough, checklist, numbered and bulleted lists,
link, text color, highlight and clear formatting. The usual shortcuts work
too:

| Shortcut | |
| --- | --- |
| ⌘B / ⌘I / ⌘U | bold / italic / underline |
| ⌘⇧X | strikethrough |
| ⌘⇧7 / ⌘⇧8 / ⌘⇧9 | numbered list / bullets / checklist |
| Tab / ⇧Tab | indent / outdent a list item |
| ⌘K | link (⌘-click opens it while editing) |
| ⌘⇧H | highlight |
| ⌘⇧. / ⌘⇧, | larger / smaller (the selection; with nothing selected, the whole text) |
| ⌘\ | clear formatting |
| ⌘Z / ⌘⇧Z | undo / redo while editing |

(Ctrl instead of ⌘ on Windows and Linux.) Click a checkbox to tick it.
Pasting from Google Docs or a web page keeps bold, italic, links and
lists. The properties panel's font size, font and color still apply to
the whole text; sizes set in the text stay relative to it.

The formatting is stored in the element (`customData.rich`); its `text`
stays the plain words, list markers included, so search, copy and other
Excalidraw apps still see the text. Exports (PNG, SVG, PDF) show the
formatting, and in SVG and PDF text stays text, links included. Agents
write formatted text as markdown (see the skill).

### Fonts

Besides Excalidraw's own fonts, any font can be added: **font picker →
"+ Add font…"**, either by name from Google Fonts (Geist, JetBrains Mono,
Inter …; on kurviq.com fetched through the Worker, so browsers never talk to
Google) or as a file (.woff2, .woff, .ttf, .otf; only fonts you may share).
A font gets a number derived from its name (the same everywhere), and a
scene that uses it carries the font in a `kurviqFonts` field of its file,
so it looks the same for teammates, in shared and public links, in PDFs and
for agents. This browser keeps every font it has seen for its other scenes;
Excalidraw's font picker offers them too. Agents use them by
name (`"fontFamily": "Geist"`); `app_status` lists them. One style per font
(regular); bold and italic are drawn by the browser. Code:
`scenes-plugin/src/fonts.ts`, `fontsUI.tsx`, `online/worker/fonts.ts`.

### Text padding

Shapes with text (rectangle, ellipse, diamond) have a **Text padding**
slider below Opacity in the properties panel: how far the text keeps from
the border (default 5 px), per shape.

### Sync with Google Drive

The browser is the source of truth and works offline (train!): scenes live in
localStorage/IndexedDB, Google Drive is a sync target. Each scene tracks the
Drive version it is based on (the MD5 of its content, Drive's
`md5Checksum`), which gives a visible status:
✓ synced · ↑ not pushed · ↓ newer in Drive · ⇅ changed on both sides · ! conflict · ○ not in Drive yet · ⌂ local only.

- **Local only** (per scene: "This scene: local only, never in Drive", or
  the "Local only" checkbox when creating one): the scene stays in this
  browser and is never pushed or pulled. A copy that is already in Drive
  stays there unchanged. Switch back to auto-sync any time to publish it
  (merged with the Drive copy, if there is one). Agents can still read and
  edit it through the open app. Without sign-in every scene is local only.

- **Auto-sync** (default on; per-scene override "always / manual only"):
  pushes after 10s without edits and when you leave the tab; pulls scenes
  without local changes; checks Drive every 60s while the app is open
  (agent edits arrive at once); downloads all scenes so
  they're available offline.
- **Both sides changed** (two people, or you and an agent, on the same
  scene): an element-level three-way merge against the last version both
  sides had (the browser keeps the last 4 versions of each file in
  IndexedDB as merge bases). Elements are compared by
  content, so re-saved but unchanged elements don't count. Different
  elements merge automatically. When the same element was changed on both
  sides, the newer edit wins, like in live collaboration (an edit beats a
  delete); the Activity log names those elements. Switch off "Settle clashes
  automatically" to decide yourself instead: the scene then shows a
  **conflict** with *Keep mine* (overwrite Drive), *Take Drive's* or *Keep
  both* (yours becomes a copy), or an agent decides element by element
  (`get_conflict` / `resolve_conflict`).
- **Several people:** share a scene with them (**Share…**, Can edit). Your
  edits reach Drive about 10 s after you stop drawing, and each app notices
  other people's changes within a minute. Views are never moved by a merge.
  Not realtime: no live cursors. Clock differences between machines decide
  "newer" when the same element is changed within seconds.
- **Offline:** everything keeps working. **Google Drive…** shows "Drive not
  reachable — working locally", and syncing resumes when the connection is
  back.
- Pushes are safe: a push only goes through if Drive still has the version
  it is based on (no silent overwrites); otherwise the app merges first.
- Everything that happens is listed in the **Activity** log under **Google Drive…**.

Editing works as usual in localStorage. Switching away stashes the scene
(incl. images) in IndexedDB, so unsynced work in several scenes is kept.
When opening a scene without local changes, the Drive version is loaded.

### Where data lives (stateless servers)

Scene data lives in exactly two places: **your browser** (localStorage +
IndexedDB) and **your Google Drive** (the folder **Kurviq**, plus files
others shared with you). Neither the scenes server nor the MCP server nor
kurviq.com's Worker stores anything:

- The local scenes server keeps no scenes and runs no git: it relays the
  MCP server's requests to your open tab, prints PDFs with headless Chrome
  and renders pictures headless when no tab is open.
- The Google sign-in is a sealed blob in your browser (an encrypted httpOnly
  cookie on kurviq.com, localStorage in the local install); the Worker
  trades it for one-hour access tokens and keeps nothing.
- Agents' change tracking comes from Drive: after an agent edit your tab
  marks that Drive revision "keep forever" and stores its id in the file's
  `appProperties` (`agentRev`), unpinning the previous one; "what did the
  user change" is the diff to that revision. Agent drafts (`create_view`
  checkpoints) live in your open tab.
- In memory there are only live connections (which tabs are open, which
  scene each shows, pending agent commands). All of it is rebuilt after a
  restart.

## Agents (MCP)

👉 **Step-by-step guide for coding agents: [README-AGENTS.md](README-AGENTS.md)**

`.mcp.json` registers the server for Claude Code in this folder
(`node scenes-mcp/server.mjs`, stdio).

**Agents work through your open tab.** They read, edit and render scenes in
the Kurviq tab you have open (any scene), with the real Excalidraw; your tab
merges their edits into what you have open and saves them to Drive with
your sign-in. Without sign-in, agents work on local-only scenes the same
way. `SCENES_AGENT_MODE=live` in `.env` lets agents co-edit the open canvas
live (undoable with ⌘Z).

Only the app and the MCP tools may write scenes: the scenes server refuses
writes from anything else (e.g. an agent's own curl script) and content that
names a different scene than the one it is saved as.

| tool | |
|---|---|
| `read_me`, `create_view` | upstream excalidraw-mcp drawing tools (create_view returns a `checkpointId`) |
| `read_scene` | a scene + what the user changed since the agent's last edit (`userChanges`), with a `revision` |
| `edit_scene` | add / update / delete elements; the user's tab merges and saves it right away |
| `view_scene` | PNG image of a scene or a draft, optionally zoomed |
| `list_scenes` / `get_scene` | the user's scenes, and a scene as data |
| `save_scene` | save a NEW drawing (`checkpointId` or `elements`); existing scenes only with `replace=true` |
| `rename_scene` / `clone_scene` / `delete_scene` | in the user's app and Drive |
| `app_status` / `open_scene` | what the user's app shows, whether Drive is connected (`drive`) and each scene's sync status; switch it to a scene (only on request) |
| `get_conflict` / `resolve_conflict` | show a merge conflict (each clashing element in both versions, plus images) and resolve it element by element, or wholesale |

Typical flows: new drawing `read_me` → `create_view` → `save_scene`;
changing a scene `read_scene` → `edit_scene(basedOn: revision)`.

## Updating upstream

```bash
(cd excalidraw && git fetch && git checkout origin/master && yarn install)
(cd excalidraw-mcp && git fetch && git checkout origin/main && pnpm install && pnpm run build)
```

Once it works, put the new commit hashes into `scripts/setup.mjs` and commit.

If upstream changes `excalidraw-app/App.tsx` so the injection anchors
(`renderTopRightUI={`, `<AppSidebar />`) disappear, the dev server fails with
a clear `[excalidraw-scenes]` error; adjust `scenes-plugin/vite.config.mts`.
`npm run typecheck` checks the plugin against the current upstream types.

## Security

- **Scene content is data, never code:** formatting from scenes (shared
  links, files, agents, the clipboard) is checked value by value (colors,
  sizes, list kinds; links only `http(s)` and `mailto`) before it reaches
  the page.
- **kurviq.com** sends a strict Content-Security-Policy (scripts only from
  the site itself, the page's inline scripts by hash and Google's Picker
  from apis.google.com; Google's Drive API as the main other connection; no
  framing), generated into `_headers` by the
  build. Excalidraw's `#url=` / `#json=` / `?id=` scene loaders are off.
- **Sign-in:** the return address after Google is parsed and must stay on
  the site or be a local install (localhost, 127.0.0.1, `*.localhost`,
  `*.test`); on kurviq.com the refresh token never reaches the page (it is
  sealed with AES-GCM in the `kq_google` cookie); the page only gets
  one-hour access tokens. Kurviq asks for `drive.file`, so it can't see
  the rest of your Drive.
- **Agent links:** tools run only while a Kurviq tab is connected to the
  link; only Kurviq's pages may connect as a tab; answers are accepted only
  from the tab a command went to; downloads (images) have a size and time
  limit.
- **Local scenes server:** answers only `localhost` / `127.0.0.1` (and the
  host of `SCENES_SERVER_URL`), accepts browser requests only from the app
  (`SCENES_APP_URL`, localhost on the app's port, plus any origins in
  `SCENES_ALLOWED_ORIGIN`, comma-separated) and only JSON bodies; local tools
  without an Origin (the MCP server) work as before. PDF pages must start
  with their no-scripts policy and print with scripts and network off.

## License

Kurviq is MIT licensed, see [LICENSE](LICENSE).

Kurviq is built on [Excalidraw](https://github.com/excalidraw/excalidraw)
(MIT, Copyright (c) 2020 Excalidraw) and uses
[excalidraw-mcp](https://github.com/excalidraw/excalidraw-mcp) (MIT). It is
an independent, unofficial project, not affiliated with or endorsed by
Excalidraw. Their code is not part of this repository (`npm run setup`
clones it unmodified), but builds include it together with their
dependencies and fonts: see [NOTICE.md](NOTICE.md) and the generated
notices at <https://kurviq.com/third-party-licenses.txt> and
<https://kurviq.com/third-party-licenses-server.txt>.
