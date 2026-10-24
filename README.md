# Kurviq: git-backed Excalidraw scenes for humans and agents

_Built on [Excalidraw](https://github.com/excalidraw/excalidraw). Unofficial, not affiliated with Excalidraw._

**Online, no install: <https://kurviq.com>** (see [Kurviq: the online version](#kurviq-the-online-version)).
This repo is its source, and also runs locally:

Local Excalidraw with **multiple scenes** that are saved to a GitHub repo
(`SCENES_GIT_REPO`, default <https://github.com/tecsteps/excalidrawscenes>),
usable by humans (sidebar in the app) and agents (MCP tools).

Upstream code is kept **untouched** and is not part of this repo: `npm run setup`
clones it at the tested commits pinned in `scripts/setup.mjs`.

| folder | what |
|---|---|
| `excalidraw/` | upstream clone of excalidraw/excalidraw, **not modified** |
| `excalidraw-mcp/` | upstream clone of excalidraw/excalidraw-mcp, **not modified** |
| `scenes-plugin/` | the UI/logic, injected into `excalidraw-app` at build time by `scenes-plugin/vite.config.mts` (uses public `<Excalidraw/>` extension points only: `renderTopLeftUI` + a custom `<Sidebar/>`) |
| `scenes-server/` | tiny local Node server: commits & pushes `scenes/<name>.excalidraw` to the scenes repo with your local git credentials (via a transport clone in `scenes-server/.repo`); relays agent commands to the open app. **Stateless**, see below |
| `scenes-mcp/` | MCP server = excalidraw-mcp's tools + scene tools (`tools.mjs`; `server.mjs` = local stdio server) |
| `online/` | **Kurviq**, the online version at <https://kurviq.com>: Cloudflare Worker (GitHub sign-in, agent pairing, remote MCP), `llms.txt`, deploy config |

## Kurviq: the online version

<https://kurviq.com> is the same app as a website. No account, nothing to
install:

- **Without GitHub** your scenes are saved in your browser (localStorage and
  IndexedDB; Kurviq asks the browser to keep them permanently). Everything
  works: scenes, slides, formatted text, PDF export (via the browser's print
  dialog).
- **Connect GitHub** (optional) to sync your scenes with a repository, on all
  your devices and with other people:
  Click **Connect GitHub** (welcome screen, scene menu or Scenes sidebar):
  it signs you in with GitHub (once Kurviq is allowed, GitHub sends you
  straight back). A checklist then shows only what is still missing:
  1. **Create `<you>/kurviq-scenes`**: GitHub's form opens filled in
     (private), one click on "Create repository" ("I already have it" skips
     this; GitHub doesn't tell Kurviq about a repository it may not see yet).
  2. **Give Kurviq access to it**: the Kurviq app's installation page on
     GitHub, once per account ("Only select repositories" → kurviq-scenes).
  3. Sync is on; scenes from this browser come along.

  Kurviq gets access to the files of the repositories you allow, nothing
  else: the app has no administration rights, so it never creates or
  deletes repositories itself. A browser that synced with an older
  repository is offered a move to `kurviq-scenes` (its scenes are copied;
  the old repository stays as it is).

  Scenes are stored as `scenes/<name>.excalidraw`, pushed about 10 s after
  you stop drawing; changes by others arrive within a minute and are merged
  element by element (see [Sync with GitHub](#sync-with-github)). The
  connection stays for months: Kurviq keeps GitHub's refresh token in an
  encrypted, httpOnly cookie of your browser; its server stores nothing.
  **Disconnect** any time in the sidebar.
- **AI agents (MCP):** click **MCP** (top left) for a prompt to give your
  agent (Claude Code, Codex, Cursor, Claude, …): it adds
  `https://kurviq.com/mcp` and signs in (OAuth). On first use your browser
  opens a Kurviq page where you allow the agent; the agent's client keeps
  its tokens, Kurviq stores nothing (the tokens are sealed by the Worker and
  name your browser's pairing). The agent then works through your open
  Kurviq tab: it reads, draws and edits your scenes (with or without GitHub),
  and its edits are merged with yours. The tab must be open while the agent
  works. **Sign out all agents** gives your browser a new pairing, which cuts
  every agent off. The old personal link `https://kurviq.com/mcp/<key>` is
  refused (the agent is told to sign in). Agents find everything they
  need at <https://kurviq.com/llms.txt>.
  Images from the agent's machine (illustrations, screenshots): the agent
  uploads them with `curl --data-binary @image.png <upload address>` (from
  the MCP server's instructions) and adds them by the `fileId` it
  gets back; the Worker passes the file straight to the tab (nothing is
  stored), and the image's bytes never go through the model.

- **Teams (spaces):** install the Kurviq app on a GitHub organization and
  its members share `<org>/kurviq-scenes`. Switch spaces in the Scenes
  sidebar (each space keeps its own scenes in the browser). GitHub is the
  only source of who may do what: write access edits, read access views
  (read-only mode, nothing is pushed, agents can't edit either), and when
  access ends on GitHub (removed, repository archived, deleted or
  renamed, protected branch) Kurviq stops syncing and says why; the
  scenes stay in the browser.
- **Share a link:** **Copy link** (Scenes sidebar, current scene) gives
  `kurviq.com/@<owner>/<scene>`, unique because GitHub account names are.
  A teammate opens it, signs in with GitHub and sees the scene if GitHub
  lets them read the repository; with write access, **Edit in <owner>'s
  space** opens it there.
- **Public scenes:** **Make public** moves a scene to the public
  repository `<owner>/kurviq-public` (created when needed); its link then
  works for everyone, without sign-in, read through a stateless Worker
  route with a one-minute edge cache (`/api/public/<owner>/<scene>`; the
  page preloads it and is titled after the scene for link previews).
  **Make private** moves it back; what was public stays in the public
  repository's git history. Viewers can **Make a copy** (synced to their
  own repository when they're connected) or **▶ Present** it.
- **Share a presentation:** **Copy presentation link** (Scenes sidebar) or
  **Share** (Slides sidebar) gives `kurviq.com/@<owner>/<scene>?present`:
  it opens presenting (`&slide=3` starts at slide 3; skipped slides are
  left out). Browsers allow fullscreen only after a click, so it starts in
  the window with a **⛶ Fullscreen** button (or F); → / click next, Esc ends.
- **Kurviq's own decks:** <https://kurviq.com/features> shows everything
  Kurviq adds. Decks in `online/scenes/` (listed in
  `scenes-plugin/src/publicScene.tsx`) open at `kurviq.com/<name>` in the
  same viewer.

Differences to the local install: Excalidraw's live collaboration and
shareable links (excalidraw.com servers) are switched off, agents need your
open tab (no headless Chrome), local file paths can't be used by agents, and
PDFs are made with the browser's print dialog. Kurviq is operated by
Tecsteps GmbH: [imprint](https://kurviq.com/imprint),
[privacy](https://kurviq.com/privacy) (no accounts, no tracking, no request
logs; the pages are in `online/pages/`).

### Running Kurviq yourself (Cloudflare)

`npm run build:online` builds the app into `online/dist/app`; `online/` holds
the Worker (`worker/`), `wrangler.jsonc` and `llms.txt`.

- Local test: put `KURVIQ_GITHUB_CLIENT_ID`, `KURVIQ_GITHUB_CLIENT_SECRET` and
  `KURVIQ_GITHUB_APP_SLUG` into `.env`, then `npm run dev:online`
  (http://localhost:8787).
- GitHub App: callback URLs `https://<your domain>/auth/callback` (and
  `http://localhost:8787/auth/callback`), "Request user authorization
  (OAuth) during installation" on, user token expiry on, webhook off,
  repository permissions Contents: read and write, plus Administration:
  read and write so Kurviq can create `kurviq-scenes` (without it, users
  are sent to GitHub's "new repository" form). No private key needed.
- kurviq.com is deployed by GitHub Actions
  ([`.github/workflows/deploy-kurviq.yml`](.github/workflows/deploy-kurviq.yml))
  on every push to `main`, with the repository secrets `CLOUDFLARE_API_TOKEN`
  and `CLOUDFLARE_ACCOUNT_ID`; don't deploy it from a local machine.
- Your own deployment: `cd online && npm install`, set the secrets once with
  `npx wrangler secret put GITHUB_CLIENT_SECRET` and
  `npx wrangler secret put COOKIE_KEY` (value: `openssl rand -base64 32`),
  adjust `vars` and `routes` in `wrangler.jsonc`, then `npm run deploy:online`
  in the project root.

## Install with an agent

Paste this prompt into any coding agent (Claude Code, Codex, Cursor, …). It
installs everything end to end and checks that it works. Replace
`<SCENES_REPO_URL>` with the GitHub repo your scenes should be saved to, or
leave it in and the agent will ask you.

````text
Install Kurviq locally (https://github.com/tecsteps/kurviq) on this
machine end to end, and verify that it works. Work step by step, run the
commands yourself, and fix problems as you go. Ask me only when you need a
decision or something only I can do (such as logging in).

Scenes repo: <SCENES_REPO_URL>
(If this is still a placeholder, ask me for it. It must be a GitHub repo I can
push to; an empty repo is fine.)

1. Prerequisites. Check and install what is missing, or tell me if you can't:
   - git, Node.js 18 or newer, yarn (classic) and pnpm
     (`corepack enable` provides both on recent Node versions)
   - GitHub access for git: `gh auth status` should be logged in, or git
     push over HTTPS/SSH must work. Check with
     `git ls-remote <SCENES_REPO_URL>`.
   - Google Chrome or Chromium (used to render scene images when no
     browser tab is open). If it is not in the default location, note its
     path for CHROME_PATH.

2. Get the code. Unless I said otherwise, clone into ~/kurviq:
   git clone https://github.com/tecsteps/kurviq.git ~/kurviq
   If the folder already exists, `git pull` instead.

3. Configure. `cp .env.example .env` (keep an existing .env, only add missing
   settings). Set SCENES_GIT_REPO=<SCENES_REPO_URL>. Leave the ports as they
   are unless 3001 or 3101 is taken.
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

7. Verify the MCP server end to end. You may not see the new tools in this
   session yet, so talk to it directly over stdio: start
   `node <abs path>/scenes-mcp/server.mjs`, send the JSON-RPC messages
   initialize, notifications/initialized and tools/list (one JSON object per
   line), and check that the tools include list_scenes, save_scene,
   view_scene and delete_scene. Then call, through the same connection:
   a. list_scenes {}                        → no error
   b. save_scene {"name": "zz-install-check", "elements":
      "[{\"type\":\"rectangle\",\"id\":\"r1\",\"x\":0,\"y\":0,\"width\":200,\"height\":80,\"label\":{\"text\":\"It works\"}}]"}
                                            → commits the scene to the scenes repo
   c. view_scene {"name": "zz-install-check"} → returns a PNG image
   d. delete_scene {"name": "zz-install-check"} → removes it again
   Confirm with `git ls-remote <SCENES_REPO_URL>` or the GitHub page that
   commits arrived.

8. Report back:
   - the app URL (http://draw.test or http://localhost:3001), which I should
     open in my browser
   - which agent clients you registered the MCP server with, and that I have
     to restart running agent sessions to get the tools
   - the result of every check in step 7, and anything you had to fix
   - how to start it later: `npm start` in the install folder
````

## Setup & run

```bash
git clone https://github.com/tecsteps/kurviq.git && cd kurviq
cp .env.example .env   # set SCENES_GIT_REPO to your scenes repo
npm run setup     # clone (if missing) + install + build upstream repos, link node_modules
npm start         # scenes server (:3101) + app (http://draw.test)
```

Config lives in `.env` (template: `.env.example`, `.env.local` overrides): `SCENES_GIT_REPO`,
`SCENES_GIT_BRANCH`, `SCENES_SERVER_PORT`, `SCENES_SERVER_URL`,
`SCENES_APP_URL`.

**Hostname `draw.test`:** the app runs on port 3001. Laravel Herd's nginx
forwards http://draw.test to it, live reload included. This is set up once with
`npm run setup:domain` (`herd proxy draw http://localhost:3001`) and undone with
`herd unproxy draw`. Without Herd, use http://draw.localhost:3001, which
works with no setup, and set `SCENES_APP_URL` to match. Browsers keep separate
storage per hostname, so local scenes on http://localhost:3001 don't show up
on draw.test. Everything pushed to GitHub does.

## Using it

The pill next to the menu (top-left) shows the current scene; a dot means
uncommitted changes. Click it to open the **Scenes** sidebar:

- **Save**: commit & push the current scene (asks for a name the first time)
- **Save as…**: commit under a new name and continue there
- **New**: new empty scene
- click a scene to switch; **Sync now** checks GitHub right away
- **Rename · Duplicate · Delete**: under the current scene, or via the **⋯**
  menu of any scene in the list. Rename and delete happen on GitHub too (one
  commit each; a rename is a git rename, history is kept; deleted scenes stay
  in the git history). Offline they apply locally right away and reach
  GitHub when it's back. Duplicate copies the scene incl. changes that aren't
  pushed yet; auto-sync pushes the copy. Delete only removes the version on
  GitHub you have seen: if someone changed it there meanwhile, it is kept.
  A scene deleted on another machine disappears here too, unless you changed
  it locally (then it's kept and pushed again).
- **Discard local changes**: reload the scene from the repo

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
  to reorder; hover a slide to duplicate (⧉) or delete (×) it. On the
  canvas the slides always lie in deck order, seven per row: the canvas
  follows every change in the list. A duplicate keeps the slide's content,
  click steps and notes and goes right after its original; everything can
  be undone with ⌘Z. Per slide: title, speaker notes, "skip when
  presenting" (backup slides), "show template".
- **Click steps:** select elements on a slide and pick "Click 1", "Click 2" …
  under "Selection appears"; they fade in one click at a time.
- **Template:** one "Template" frame holds what every slide shows: header,
  footer, logo, background. Edit it once; every slide follows. Template
  texts can use `{page}` `{total}` `{title}` `{deck}` `{date}`. On slides
  the copies are locked; unlock one to change it on that slide only (it
  then stays as you made it). **Reset to template** brings the template
  version and the deck style back for one slide, **Reset all slides** for
  the whole deck.
- **Deck style:** font, title and text size, colors, sloppiness, stroke,
  fill and transition, stored with the template. New elements use it, and
  elements that still have the deck's values follow when you change it.
  Anything you styled by hand on a slide stays.
- **PDF**: the whole deck, the selected slide or any slides ("1, 3-5"),
  one 16:9 page per slide, title slides and template included. Text stays
  real text (selectable, searchable) with the fonts embedded once, and
  pictures used on many slides (like the logo) are stored once: a 12-slide
  deck is about 300 KB. The scenes server prints it with your Chrome; if it
  can't, the browser's print dialog opens instead ("Save as PDF").
- Deleting a template element on one slide (unlock it, delete it) keeps it
  off that slide, on every device, until **Reset to template**.

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
the deck style in the Slides sidebar offers them too. Agents use them by
name (`"fontFamily": "Geist"`); `app_status` lists them. One style per font
(regular); bold and italic are drawn by the browser. Code:
`scenes-plugin/src/fonts.ts`, `fontsUI.tsx`, `online/worker/fonts.ts`.

### Text padding

Shapes with text (rectangle, ellipse, diamond) have a **Text padding**
slider below Opacity in the properties panel: how far the text keeps from
the border (default 5 px), per shape.

### Sync with GitHub

The browser is the source of truth and works offline (train!): scenes live in
localStorage/IndexedDB, GitHub is a sync target. Each scene tracks the GitHub
version it is based on, which gives a visible status:
✓ synced · ↑ not pushed · ↓ newer on GitHub · ⇅ changed on both sides · ! conflict · ○ not on GitHub yet · ⌂ local only.

- **Local only** (per scene: "This scene: local only, never on GitHub", or
  the "Local only" checkbox when creating one): the scene stays in this
  browser and is never pushed or pulled. A copy that is already on GitHub
  stays there unchanged. Switch back to auto-sync any time to publish it
  (merged with the GitHub copy, if there is one). Agents can still read and
  edit it through the open app.

- **Auto-sync** (default on; per-scene override "always / manual only"):
  pushes after 10s without edits and when you leave the tab; pulls scenes
  without local changes; checks GitHub every 60s while the app is open (`SCENES_WATCH_INTERVAL_MS`
  in `.env` to change it; agent edits on this machine arrive at once);
  downloads all scenes so
  they're available offline.
- **Both sides changed** (two people, or you and an agent, on the same
  scene): an element-level three-way merge. Elements are compared by
  content, so re-saved but unchanged elements don't count. Different
  elements merge automatically. When the same element was changed on both
  sides, the newer edit wins, like in live collaboration (an edit beats a
  delete); the Activity log names those elements. Switch off "Settle clashes
  automatically" to decide yourself instead: the scene then shows a
  **conflict** with *Keep mine* (overwrite GitHub), *Take GitHub's* or *Keep
  both* (yours becomes a copy), or an agent decides element by element
  (`get_conflict` / `resolve_conflict`).
- **Several people:** everyone runs their own install against the same
  repo. Your edits reach GitHub about 10 s after you stop drawing, and each
  app notices other people's pushes within a minute (set
  `SCENES_WATCH_INTERVAL_MS`, e.g. `10000` for about 10 s). Views are never moved by a merge.
  Not realtime: no live cursors. Clock differences between machines decide
  "newer" when the same element is changed within seconds.
- **Offline:** everything keeps working. The sidebar shows "GitHub not
  reachable, working locally · N scenes waiting to sync", and syncing
  resumes when the connection is back.
- Pushes are safe: the server rejects a push whose base version isn't the
  current one on GitHub (no silent overwrites), and the app merges instead.
- Everything that happens is listed in the sidebar's **Activity** log.

Editing works as usual in localStorage. Switching away stashes the scene
(incl. images) in IndexedDB, so uncommitted work in several scenes is kept.
When opening a scene without local changes, the repo version is loaded.

### Where data lives (stateless servers)

Scene data lives in exactly two places: **your browser** (localStorage +
IndexedDB) and **the GitHub repo**. Neither the scenes server nor the MCP
server stores anything:

- `scenes-server/.repo` is only a transport clone: it is reset to GitHub's
  state before every commit and after a failed push, so it never holds
  anything GitHub doesn't have. Delete it any time; it is re-cloned.
- Agents' change tracking comes from git: agent commits carry a
  `Scenes-Source: agent` trailer, and "what did the user change" is the diff
  to the scene as of the last agent commit. Agent drafts (`create_view`
  checkpoints) live in the agent's headless Chrome, in a throwaway profile
  that is deleted when it stops.
- In memory there are only live connections (which tabs are open, which
  scene each shows, pending agent commands) and the last GitHub reachability
  check. All of it is rebuilt after a restart.

## Agents (MCP)

👉 **Step-by-step guide for coding agents: [README-AGENTS.md](README-AGENTS.md)**

`.mcp.json` registers the server for Claude Code in this folder
(`node scenes-mcp/server.mjs`, stdio).

**Agents have their own Excalidraw.** They read, edit and render scenes in a
hidden headless Chrome that the scenes server starts on demand, and every
agent edit is one commit on GitHub. Your browser is never remote-controlled:
your app pulls agent commits within seconds and merges them into what you
have open, and it pushes your changes of a scene when an agent asks for it.
`SCENES_AGENT_MODE=live` in `.env` switches back to agents working directly
in your open tab.

Only the app and the MCP tools may write scenes: the scenes server refuses
writes from anything else (e.g. an agent's own curl script) and content that
names a different scene than the one it is saved as.

| tool | |
|---|---|
| `read_me`, `create_view` | upstream excalidraw-mcp drawing tools (create_view returns a `checkpointId`) |
| `read_scene` | a scene + what the user changed since the agent's last edit (`userChanges`), with a `revision` |
| `edit_scene` | add / update / delete elements, committed right away; the user's app merges it |
| `view_scene` | PNG image of a scene or a draft, optionally zoomed |
| `list_scenes` / `get_scene` | scenes on GitHub, and a scene as data |
| `save_scene` | commit a NEW drawing (`checkpointId` or `elements`); existing scenes only with `replace=true` |
| `rename_scene` / `clone_scene` / `delete_scene` | on GitHub; the user's app follows |
| `app_status` / `open_scene` | what the user's app shows and each scene's sync status; switch it to a scene (only on request) |
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
  the site itself, the page's inline scripts by hash; GitHub's API as the
  only other connection; no framing), generated into `_headers` by the
  build. Excalidraw's `#url=` / `#json=` / `?id=` scene loaders are off.
- **Sign-in:** the return address after GitHub is parsed and must stay on
  the site; the refresh token never reaches the page; disconnecting takes
  the token lock and signs out the browser's other tabs.
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
