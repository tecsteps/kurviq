# Using Kurviq with a coding agent

Coding agents (Claude Code, Codex, Cursor, …) can draw diagrams, save them as
scenes, and co-edit scenes with you, all through one MCP server:
`scenes-mcp/server.mjs`. The agent works **through your open Kurviq tab**:
its edits run there with the real Excalidraw, and your tab saves them to
your Google Drive with your sign-in (without sign-in, scenes stay local
only in that browser). To install everything with an agent, use the prompt
in [README.md](README.md#install-with-an-agent).

**Kurviq (online, https://kurviq.com):** no install. The user clicks **MCP**
in Kurviq and gives you a personal link `https://kurviq.com/mcp/<key>`
(remote MCP, Streamable HTTP). You then work through the user's open Kurviq
tab with the same tools as below. Read https://kurviq.com/llms.txt
([online/llms.txt](online/llms.txt)).

```
agent ──MCP──> scenes-mcp ──HTTP──> scenes-server ──relay──> your Kurviq tab (Brave, Chrome, …) ──> Google Drive
                                      │                      (reads, edits, images,               (the folder Kurviq)
                                      │                       merges, syncs)
                                      └── headless Chrome: PDFs, and pictures when no tab is open
```

## 1. Start the app

```bash
cd /path/to/kurviq
npm start            # scenes server on :3101 + app on http://draw.test
```

Open **http://draw.test** in your browser and keep it open: agents work
through that tab. **Sign in with Google** there (scene list) to sync your
scenes with Google Drive; sign-in goes through kurviq.com
(`KURVIQ_AUTH_URL`). PDFs, and pictures when no tab is open, are rendered
with Chrome or another Chromium browser (`CHROME_PATH` in `.env`).

## 2. Connect your agent

The server is a stdio MCP server and works from any directory. Use the absolute
path: `/path/to/kurviq/scenes-mcp/server.mjs`.

**Claude Code, in this folder:** nothing to do. `.mcp.json` registers it as
`excalidraw`. Approve it when Claude Code asks the first time.

**Claude Code, in every project:**

```bash
claude mcp add excalidraw --scope user -- node /path/to/kurviq/scenes-mcp/server.mjs
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.excalidraw]
command = "node"
args = ["/path/to/kurviq/scenes-mcp/server.mjs"]
```

**Cursor, Claude Desktop and other clients:** add this to their MCP JSON config:

```json
{
  "mcpServers": {
    "excalidraw": {
      "command": "node",
      "args": ["/path/to/kurviq/scenes-mcp/server.mjs"]
    }
  }
}
```

**Scripted** (e.g. from another agent; the app must be open in a browser):

```bash
claude -p "Draw our login flow and save it as scene 'Login Flow'" \
  --mcp-config /path/to/kurviq/.mcp.json \
  --allowedTools "mcp__excalidraw__*"
```

## How you and the agent work together

- **Agent → you, at once:** every `edit_scene` runs in your open tab, which
  merges it into what you have open, without moving your view or touching
  your other changes, and saves it to Drive right away.
- **You → agent:** the agent reads your tab's current state of the scene,
  so it always works on your latest edits, pushed or not. Your app pushes to
  Drive about 10 s after your last edit.
- Agent edits arrive as a merge, so Cmd+Z in your tab doesn't undo them. Ask
  the agent, or restore an older version (pen → History).
- The agent only switches what you see when you ask it to (`open_scene`).

**Live mode** (the agent co-edits the canvas you have open, live: its
edits are undoable with Cmd+Z, and its drawing is mirrored into the scene
`agent-live`): set `SCENES_AGENT_MODE=live` in `.env` and restart your agent
sessions.

## Scene URLs

`http://draw.test/<scene name>` opens that scene, e.g. `/Madsack` or
`/Agent%20-%20House`. If the scene doesn't exist yet, an empty local scene with
that name is created, and it fills in once an agent saves it. The
URL follows whenever you switch scenes, and back/forward work.

## 3. Ask for things

The tools describe themselves, so plain requests work:

- "Draw the architecture of this repo and save it as scene **Backend Architecture**. Open it in my app."
- "What did I change in **Checkout Flow**? Add a 'Fraud check' step between 'Cart valid?' and 'Charge card'."
- "Look at the scene I have open and tidy up the arrows."
- "Switch my Excalidraw to **Agent - House**."
- "List all scenes."
- "Create an empty scene called **Sprint 42 Retro** and switch to it."
- "Rename **Sprint 42 Retro** to **Sprint 42 – Retro**." · "Duplicate **Madsack** as **Madsack v2**." · "Delete the scene **agent-live**."

## Tools

| Tool | What it does |
|---|---|
| `read_me` | Element format cheat sheet: shapes, labels, arrows, colors. The agent calls it once before drawing. |
| `create_view` | Draws a new diagram and returns a `checkpointId` (a draft, kept in your open tab). |
| **`view_scene`** | **Returns an actual PNG image to the agent**, of a scene or a draft. Optional `elementIds` / `region` zoom in, `maxSize` caps the size. `slide: 3` shows a slide exactly as presented (template, page numbers), `step: 1` after the first click; `slides: "all"` puts the whole deck in one image. |
| **`validate_deck`** | Checks a presentation slide by slide, measured by Excalidraw: cut-off, overlapping, overflowing, too small or low-contrast text, text hidden under shapes, elements not part of their slide, broken click steps, missing notes. Also lists the slides. |
| `export_pdf` | Writes a PDF of a deck (all slides or e.g. `"2-4"`), with real text. |
| `measure_text` | How wide and tall text will be in a given font and size (and how it wraps), measured by Excalidraw; also for formatted text (`markdown`). |
| **`read_scene`** | Reads a scene (your tab's current state) and reports **`userChanges`**: what you added, changed or deleted since an agent last edited it. Returns a `revision`; `since=<revision>` gives exactly the changes since then, `view=true` adds an image of them. |
| **`edit_scene`** | Adds, updates or deletes elements in your open tab, which merges them and saves the scene to Drive right away. Works like the editor: moved shapes take their labels and arrows along, a moved slide takes its content; `label: {text}` changes a shape's label; `markdown` instead of `text` writes formatted text (bold, lists, colors). Returns an image of the edited area and the new `revision`. |
| `get_scene` | A scene as data. `summary=true` (the default for big scenes) gives bounds, counts and all labels with positions. `region` / `elementIds` select a part. |
| `save_scene` | Saves a **new** drawing (`checkpointId` or `elements`). `open: true` switches your app to it. Existing scenes are changed with `edit_scene`; `replace: true` overwrites one completely. |
| `open_scene` | Switches your app to a scene, only when you ask. `create: true` makes a new one. |
| `rename_scene` / `clone_scene` / `delete_scene` | Rename, duplicate or delete a scene, in your app and in Drive (a renamed scene keeps its file and links; a deleted one goes to Drive's bin). |
| `set_local_only` | Makes a scene local only (kept in your browser, never synced to Drive) or syncs it again. `save_scene(local: true)` creates a new local-only scene. |
| `get_conflict` / `resolve_conflict` | Shows a merge conflict (each clashing element as base / yours / Drive's, plus images of both versions) and resolves it: element by element (`merge`), or wholesale (`mine`, `drive`, `both`). |
| `list_scenes` / `app_status` | Your scenes, and what your app has open, whether Drive is connected (`drive`) and each scene's sync status. |

### Co-working (you and the agent on the same drawing)

1. The agent draws: `read_scene` → `edit_scene(add=…)` → checks the returned image.
2. You change things by hand: add, move, delete, relabel.
3. You ask for more. The agent calls `read_scene` again, and the answer **automatically contains `userChanges`**: what you added, modified (with `changedFields` such as `["x","y"]` = moved or `["text"]` = relabelled) and deleted since the agent's last edit. With `view=true` it also gets a picture of your changes.

**How change detection works:** after an agent edit your tab marks that Drive revision "keep forever" and stores its id in the file's `appProperties` (`agentRev`), unpinning the previous one. `read_scene` compares the current version with that revision, or with an exact `revision` the agent passes. It lives with the file in Drive, so this works across conversations, context compaction, different agents and devices.

**Safety net:** if you changed something since the agent's version, `edit_scene` still applies its edit on top of yours, but the answer starts with a **WARNING** listing your changes plus an image of them, so the agent re-checks.

These rules are built into the MCP server's instructions (sent to every agent that connects) and into the Claude Code skill `excalidraw-scenes` (`scenes-mcp/skill/excalidraw-scenes/SKILL.md`, linked to `~/.claude/skills/`).

### Slides

Agents can build whole decks: frames are slides (`customData.slides` holds
order, notes, skip), elements can appear click by click (`step`), and one
template frame carries header, footer, logo and the deck style. The format
is in the skill (`scenes-mcp/skill/excalidraw-scenes/SKILL.md`, "Slides").
Template copies on the slides are made by your app when it opens the deck.

### Seeing scenes (huge ones too)

- `view_scene` returns a real image, rendered by Excalidraw itself in your open tab (headless Chrome when no tab is open), so no Playwright or browser automation is needed.
- For big scenes: `get_scene(summary=true)` shows where things are, then `view_scene(region=…)` or `view_scene(elementIds=[…])` zooms in on the part that matters.
- After editing: `view_scene(elementIds=<the ids it touched>)` shows just its own work, plus whatever overlaps.

### Drawing something new (no open canvas needed)

`read_me` → `create_view(elements)` → `view_scene(checkpointId)` to check → `save_scene(name, checkpointId)`

## Sync with Google Drive (what agents should know)

Your browser is the source of truth for your own edits and works offline. Each scene shows its status:
✓ synced · ↑ not pushed · ↓ newer in Drive · ⇅ changed on both sides (merged automatically) · ! conflict (you or an agent decide) · ○ only local.

- **Agents never push your work.** Your app's auto-sync pushes about 10 s after your last edit and checks Drive every 60 s. Agent edits are saved by your tab right away. Scenes with auto-sync off are pushed only when you say so.
- **Local-only scenes** never leave your browser. Agents still read and edit them, through your open app. Set it per scene in the sidebar ("This scene: local only, never in Drive") or with the "Local only" checkbox when creating a scene; switch back to auto-sync any time to publish it. Without Google sign-in, every scene is local only.
- `save_scene` is for new scenes; existing ones are changed with `edit_scene`, which only touches the elements it names.
- **Conflicts:** the merge compares elements by content, so only elements really changed differently on both sides clash. Ask the agent to resolve it: it looks at the clashes with `get_conflict` and decides per element with `resolve_conflict`, asking you when it's unclear.

## Troubleshooting

| Message | Fix |
|---|---|
| `Scenes server not reachable at http://localhost:3101` | Run `npm start` (or `npm run start:server`). |
| Kurviq is not open | Open the app (`SCENES_APP_URL`, e.g. http://draw.test) in your browser and keep the tab open. |
| `No browser tab is open and no Chrome found` | Pictures without an open tab (and PDFs) need Chrome or another Chromium browser. Set `CHROME_PATH` in `.env`, or open the app. |
| `Checkpoint "…" not found` | Drafts live in the open tab and are gone when it reloads. Call `create_view` again. |
| Scenes don't sync / Google Drive is not connected | Sign in with Google in the app (scene list). Sign-in goes through kurviq.com (`KURVIQ_AUTH_URL`), which must be reachable. |

To check the tools without an agent:

```bash
curl -s localhost:3101/api/scenes          # list scenes
curl -s localhost:3101/api/app/state       # what your browser has open
```
