# Code review: MCP server and shared modules

Status: open

Findings of the code review of 2026-11-13 (see `2026-11-13-code-review.md`) in the area **MCP server and shared modules**, still open after the triage against the two specs of the same day. 31 findings: 1 high, 9 medium, 21 low. Ids as in the review (B bug, S smell, D dead code, U duplication, O over-engineering). A finding that is fixed gets a line "- **Status**: fixed in <commit>".

## Potential bugs

### B7. `edit_scene` with only comments, or only `isPresentation` / `restyle` / `reset` / `addTitleBlock`, is refused (Astra F33)
- **Area**: MCP server and shared modules (scenes-mcp)
- **Severity**: high
- **Confidence**: confirmed (found and reproduced by the Astra review through the registered tool handlers; traced in code by me)
- **Location**: `scenes-mcp/tools.mjs:438-463` (`editInput`), callers `:1231`, `:1474`; documented in `scenes-mcp/skill/kurviq-scenes/REFERENCE.md:179` ("`edit_scene` (also without element changes) takes `comments`")
- **Description**: Both edit tools call `editInput` first, and it throws "Nothing to do: pass add, update and/or delete…" unless there is at least one element operation. The other operations the tools accept (`comments`, `isPresentation`, `restyle`, `reset`, `addTitleBlock`) never reach the tab when used alone. So an agent cannot add or resolve a comment, or switch a scene to a presentation, without also changing an element, although the reference says it can; for someone with comment access only it is the one thing they are allowed to do.
- **Suggested fix**: Let `editInput` return an empty edit and decide "nothing to do" in the callers, where all operations are known. Test both tools with each operation alone.
- **Status**: fixed 2026-11-13 (`editInput` returns empty edits; both tools refuse only an edit with no operation at all, `isEmptyEdit` in `agentEdits.mjs`)

### B51. Retrying an applied edit with the same requestId and basedOn reports the agent's own edit as a user conflict
- **Area**: MCP server and shared modules (scenes-mcp)
- **Severity**: medium
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-mcp/tools.mjs:1477-1506` (conflict check before the command is sent), `scenes-mcp/tools.mjs:915-926` and `:1439` (the advice to retry), `scenes-mcp/editConflicts.mjs:124-186`
- **Description**: After a timeout the tool tells the agent to "call edit_scene again with the same arguments plus requestId" and promises the stored result (`alreadyApplied`). But the retry first runs `changesSince(name, beforeElements, basedOn)` and `resolveConflicts` against the scene as it is now. If the first attempt did land, the scene differs from `basedOn` by the agent's own edit, and `clashesOn` only compares base against current (never against the value the agent sets). Every update of the retry therefore clashes with the agent's own change. For an update-only edit the handler returns early with "Nothing was changed: all your updates clashed with the user's changes" and never reaches the tab, which would have answered `alreadyApplied`. For mixed edits the updates are stripped, the tab answers `alreadyApplied`, and the result carries both `alreadyApplied` and a WARNING with `conflicts` listing the agent's own values as `theirs`. In both cases the agent is told its applied edit was rejected and that the user changed the scene. Only with `basedOn`, which is the documented flow.
- **Suggested fix**: Ask the tab for a stored result of `requestId` before the conflict check (or send `basedOn` with the command and do the check in the tab, inside `onceForRequest`), and in `clashesOn` do not count a property whose current value already equals the value the update sets.
- **Status**: fixed 2026-11-13 (a property whose current value already is the one the update sets never clashes; a result with `alreadyApplied` carries no userChanges, warning or conflicts)

### B52. A failed flush is read as "up to date" and as "not local-only"
- **Area**: MCP server and shared modules (scenes-mcp)
- **Severity**: medium
- **Confidence**: confirmed for the wrong sync note; likely for the wrong-copy edit (needs a flush that times out)
- **Location**: `scenes-mcp/tools.mjs:149-159`, `:202`, `:1301-1313`, `:1410-1412`, `:1477-1478`; the error rows come from `scenes-server/server.mjs:470-477` and `online/worker/pairing.ts:190-197`
- **Description**: Both servers answer `/api/app/flush` with HTTP 200 and `{ tabs: n, results: [{ error }] }` when the tab does not answer within 15 s. `userSyncNote` filters error rows out and then falls through to "Up to date: the user's app pushed its changes of this scene before this read", which is false: nothing was pushed. `isLocalOnly` sees no `localOnly` row and returns false, so a local-only scene is treated as a Drive scene. `set_local_only` keeps "a copy already in Google Drive ... unchanged", so for such a scene `read_scene` returns the stale Drive copy and `edit_scene` writes the agent's edit into the Drive copy the user took out of sync, while the user's real (local) scene is untouched. When `flushUser` itself throws it returns `null`, and the note says "The user's app is not open", also wrong for a timeout.
- **Suggested fix**: Treat error rows (and a `null` flush while `/api/app/state` says connected) as "unknown": say so in `sync`, and refuse or retry instead of falling back to Drive when the local-only state of the scene could not be determined.
- **Status**: fixed 2026-11-13 (`sceneHome`: no answering tab, or a failed flush, refuses the read / edit / save instead of falling back to Drive)

### B53. Images whose size cannot be read become 1 x 1 px (or square), including simple WebP files
- **Area**: MCP server and shared modules (scenes-mcp)
- **Severity**: medium
- **Confidence**: confirmed (traced in code; the tab's `repairImages` does not resize)
- **Location**: `scenes-mcp/media.mjs:92-119` (only `VP8X` WebP is parsed), `scenes-mcp/media.mjs:238-241`
- **Description**: `imageSize` returns null for lossy (`VP8 `) and lossless (`VP8L`) WebP, the most common kinds, for SVGs without `width`/`viewBox` or with single-quoted attributes, and for anything served under an image extension. Then `natural = { width: 1, height: 1 }`, and `fallback = Math.min(400, natural.width || 200)` is 1 (the `|| 200` can never apply). An image added with `src` and no size becomes a 1 x 1 px element; with only `width: 800` it becomes 800 x 800, although the docs promise "width or height alone keeps the aspect ratio". REFERENCE.md recommends WebP.
- **Suggested fix**: Parse `VP8 ` and `VP8L` headers, and keep "unknown size" as null: use the 200/400 fallback, and refuse or warn when only one side is given and the ratio is unknown (or let the tab measure the image).
- **Status**: fixed 2026-11-13 (VP8 / VP8L WebP and single-quoted SVG sizes read; unknown size: 200 x 200, or both sides required)

### B54. save_scene(replace: true) drops the scene's comments and custom fonts; new scenes never carry their fonts
- **Area**: MCP server and shared modules (scenes-mcp)
- **Severity**: medium
- **Confidence**: likely (the written JSON is confirmed; whether the comments come back depends on the app holding a local copy to merge)
- **Location**: `scenes-mcp/tools.mjs:1744-1757`, written as is by `scenes-plugin/src/online/drive.ts:1004-1040`
- **Description**: The file is rebuilt as `{ type, version, source, elements, appState, files }`. The existing file's top-level `kurviqComments` and `kurviqFonts` are not carried over, and the tab's PUT writes the body unchanged. Replacing a scene therefore deletes every comment thread in the Drive file (tombstones included, so they are not "deleted" for merges, just absent) and its embedded fonts. A new scene using `"fontFamily": "Inter"` is saved without `kurviqFonts`, although the docs say the font "travels with the scene": people opening the shared file get a fallback font until the owner's app re-saves it. `clone_scene` spreads the whole file and keeps both.
- **Suggested fix**: Carry `kurviqComments` and `kurviqFonts` of the existing file into the replacement, and let the tab add the fonts on whole-scene saves (it already does for edits with `withFonts`).
- **Status**: fixed 2026-11-13: save_scene keeps the replaced Drive scene's `kurviqComments` and `kurviqFonts`, the tab adds the custom fonts an agent's scene uses (`withAgentFonts`), and replacing a local-only scene keeps its comments (`withReplacedComments` in `saveLocalScene`, merged with any the new scene carries)

### B55. Checkpoints hold only the elements: pictures, background and fonts are lost (Astra F34)
- **Area**: MCP server and shared modules (scenes-mcp)
- **Severity**: medium
- **Confidence**: confirmed (found and reproduced by the Astra review; the three `store.save` / restore places traced by me)
- **Location**: `scenes-mcp/tools.mjs:614`, `:992`, `:1572`; renderer `scenes-plugin/src/render.ts:227-242`
- **Description**: `get_scene` describes its checkpoint as the full scene, usable for `view_scene` or a new drawing, but stores `{ elements }` only, and `view_scene` builds `{ elements }` from it. `files`, `appState` (background) and `kurviqFonts` are missing. An image element's `fileId` alone cannot bring the picture back (the renderer fills only files it was given), so a checkpoint renders with missing pictures on a white background, and saving it under a new name writes a scene without its pictures and fonts.
- **Suggested fix**: Store the scene envelope in the checkpoint (files or references to them, background, fonts) and carry it through view and save; or say in the tool description that a checkpoint holds elements only.
- **Status**: fixed 2026-11-13 (checkpoints hold elements, files, background and fonts; view_scene and save_scene use them)

### B117. A successful save_scene is reported as an error when the follow-up command fails
- **Area**: MCP server and shared modules (scenes-mcp)
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-mcp/tools.mjs:982-992`, `:1760-1762`
- **Description**: After the PUT succeeded, `appCommand({ type: "open" })` and `store.save(savedCheckpointId, ...)` are awaited without a catch. If either times out (504), the tool answers `Error: ...` although the scene is saved. The agent retries, gets "Scene already exists. Don't overwrite it", and may reach for `replace: true`. `clone_scene` handles the same step correctly (`.catch((error) => ({ error }))`, line 1859).
- **Suggested fix**: Catch both follow-ups and report them inside a successful result (`saved`, plus `app: { error }` or a missing checkpoint).
- **Status**: fixed 2026-11-13

### B118. Errors while loading the base version are turned into "revision not found" or "first look"
- **Area**: MCP server and shared modules (scenes-mcp)
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-mcp/tools.mjs:1320-1323`, `:1328`, `:1332-1334`
- **Description**: `loadVersion(...).catch(() => null)` swallows every error, also a tab timeout or an offline Drive. With `since`/`basedOn` the agent is told "Revision not found: call without since/basedOn", which makes it drop the very parameter the conflict check depends on. Without it, a failed load of the agent version becomes `firstLook: true`: `read_scene` says "No earlier agent edit of this scene found" and `edit_scene` applies without any userChanges warning.
- **Suggested fix**: Map only 404 to "not found" and rethrow everything else.
- **Status**: fixed 2026-11-13

### B119. The conflict check and the edit are not atomic, and upsert / delete bypass the check
- **Area**: MCP server and shared modules (scenes-mcp)
- **Severity**: low
- **Confidence**: likely (window confirmed in code; needs a user push between the two reads)
- **Location**: `scenes-mcp/tools.mjs:1477-1511`; `scenes-plugin/src/cowork.ts:953-980` (non-live path loads the newest version again and applies on top, retrying on 409)
- **Description**: `edit_scene` loads the scene, computes conflicts in the MCP process, then sends the surviving updates. For a Drive scene that is not live, the tab loads the newest version again and applies the edit with no knowledge of `basedOn`; `onConflict` is sent but not used on that path. A user change pushed in between (the queue can hold an edit for up to 75 s online) is overwritten property by property without a conflict. Independently, the check covers `update` only: an `add` with `upsert: true` replaces a whole element the user changed since `basedOn`, with nothing in `conflicts`.
- **Suggested fix**: Send `basedOn` (or the base elements' ids and fields) with the command and run `resolveConflicts` in the tab against the version it actually edits; include upsert replacements in the check.
- **Status**: fixed 2026-11-13: upsert replacements are conflicts; the MCP check stays as the first pass (it answers "nothing applied" without a round trip) and sends the base of the named elements (`conflictBaseOf`); the tab runs `resolveConflicts` again against the version it actually edits (`checkConflictsHere` in cowork.ts, every Drive retry, live and local-only scenes), late conflicts are merged into the same `conflicts` (`withLateConflicts`), with a warning when only the tab found them

### B120. read_scene never shows comments of local-only scenes
- **Area**: MCP server and shared modules (scenes-mcp)
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-mcp/tools.mjs:704-707`, `:721`; `scenes-plugin/src/cowork.ts:1063-1071` (`parseScene` returns elements, files, appState, kurviqFonts only)
- **Description**: `sceneComments(current.file, ...)` reads `file.kurviqComments`, but the `local-read` answer has no such field. `edit_scene(comments: ...)` on a local-only scene does store comments (`editLocalScene` passes `data.kurviqComments`), so an agent can add a comment, get its id in `commentsAdded`, and never read it or any reply again.
- **Suggested fix**: Return `kurviqComments` from `readLocalScene` (and keep it through `leanScene`).
- **Status**: fixed 2026-11-13 (`readLocalScene` returns `kurviqComments`; `leanScene` keeps every other field)

### B121. Local and online differ for scenes without Google sign-in (`driveOptional`), with a raw JSON error locally
- **Area**: MCP server and shared modules (scenes-mcp)
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-mcp/tools.mjs:950-952`, `:179-181`; `scenes-mcp/server.mjs:48-82` (option not passed); `scenes-plugin/src/online/tabServer.ts:154-156`
- **Description**: Online, `save_scene` falls back to a local-only scene when the tab has no Drive. The local server does not pass `driveOptional`, although the local skill says the same thing ("Without sign-in ... all scenes are local-only ... you read and edit them there the same way") and the same tab code answers 503. Locally `save_scene("X", ...)` without sign-in fails in `loadSceneWithMd5`, which throws the body unparsed: `Error: {"error":"Google Drive is not connected ...","offline":true}`.
- **Suggested fix**: Drop the option and always apply the fallback; let `loadSceneWithMd5` use the same error parsing as `call`.
- **Status**: fixed 2026-11-13 (`driveOptional` dropped, the fallback always applies; scene reads parse the server's error); `online/worker/index.ts` no longer passes it

### B122. list_scenes finds local-only scenes by pattern-matching a status sentence
- **Area**: MCP server and shared modules (scenes-mcp)
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-mcp/tools.mjs:574-577`; the sentence is built in `scenes-plugin/src/live.ts:609-617`
- **Description**: The filter is `/ local-only /` on lines like `"<name>: <status> (...)"`. A synced scene named `my local-only notes` matches on its name; `indexOf(": local-only")` is then -1 and `slice(0, -1)` lists `my local-only notes: synce` as a local-only scene. Any rewording of the status line breaks the list silently.
- **Suggested fix**: Have `status` return structured rows (`{ name, status, localOnly }`) and read `localOnly`.
- **Status**: fixed 2026-11-13 (the tab's `status` returns rows `{ name, status, localOnly, note? }`, which list_scenes reads; the old sentence form is still parsed for older tabs; SKILL.md and the shared-folder e2e follow)

### B123. Local file access breaks when the MCP server is started with cwd `/`
- **Area**: MCP server and shared modules (scenes-mcp)
- **Severity**: low
- **Confidence**: confirmed for the logic; uncertain which clients start stdio servers in `/` (not checked)
- **Location**: `scenes-mcp/media.mjs:19-31`, `scenes-mcp/server.mjs:62-77`
- **Description**: With `base === "/"`, `base + path.sep` is `"//"`, so every absolute path fails `startsWith` and is refused with `must be inside /`. Image `src` paths, edit files and `export_pdf` (also its default file) then never work. README-AGENTS.md says the server "works from any directory".
- **Suggested fix**: Compare with `path.relative(base, target)` (not starting with `..`, not absolute).
- **Status**: fixed 2026-11-13 (`insideRoot` in media.mjs, used by server.mjs too)

### B124. SCENES_LIVE_PREVIEW from `.env` is ignored
- **Area**: MCP server and shared modules (scenes-mcp)
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-mcp/server.mjs:61` (uses `process.env`; lines 46, 56, 57 use the merged `env`)
- **Description**: `SCENES_AGENT_MODE=live` is documented as a `.env` setting and is read from the merged `env`. `SCENES_LIVE_PREVIEW=false` in the same file has no effect.
- **Suggested fix**: Read `env.SCENES_LIVE_PREVIEW`.
- **Status**: fixed 2026-11-13

### B125. Image fetching trusts the URL's extension over the response and reaches any host
- **Area**: MCP server and shared modules (scenes-mcp)
- **Severity**: low
- **Confidence**: confirmed (traced in code); impact judged, not exploited
- **Location**: `scenes-mcp/media.mjs:46-73`, `:205-209`
- **Description**: `fetchBytes` follows redirects to any http(s) host, loopback and link-local included (locally also the scenes server on :3101, which accepts requests without an Origin). `mimeType: MIME_BY_EXT[ext] || mimeType` lets the URL's extension override the response's Content-Type, so any response under a path ending in `.svg`/`.png` is stored in the scene file as an image data URL, and from there goes to Drive and to everyone the scene is shared with. The agent cannot read the bytes back through the tools, so this is a write-only channel, but it puts non-image content of internal endpoints into shared files. Online the same code runs in the Worker (public hosts only).
- **Suggested fix**: Prefer the response's Content-Type (extension only as a fallback for `application/octet-stream`), check the first bytes as `online/worker/index.ts:107-120` does, and refuse loopback / private / link-local targets after redirects.
- **Status**: fixed 2026-11-13 (redirects followed hop by hop, each refused when on this machine or a private network; the response's type decides, the bytes must be an image)

### B126. A commenter can change the author name (and agent mark) on other people's comments
- **Area**: MCP server and shared modules (scenes-mcp)
- **Severity**: low
- **Confidence**: likely (the check is traced; not tried against a live scene)
- **Location**: `scenes-mcp/sceneComments.mjs:299-307` (`commentReadable`), `:327-340` (`commenterReadableRefusal`), used at `online/worker/scene.ts:2158-2170`
- **Description**: The readable part the server checks covers id, thread, key, at, text hash, pin hash and gone. `by.name`, `by.agent` and `edited` are only inside the encrypted body. A commenter may re-send someone else's comment with the same key, text and pin but another display name (or with the agent mark added or removed) and a higher `u`; the server accepts it, `readableMatches` passes in every tab, and the newer version wins the merge. The unused `commenterRefusal` has the same gap.
- **Suggested fix**: Add a hash of `by.name` and `by.agent` to the readable part and refuse a change of it by anyone but the author.
- **Also in the Astra review**: F35 (reproduced there: `commenterReadableRefusal` returns null and `readableMatches` true for a changed `by.name` / `by.agent`).
- **Update 2026-11-13 (specs)**: The server check goes, but the same gap is in `commenterRefusal`, which becomes the editor tab's check: refuse changes to `by.name`, `by.agent` and `edited` of others' comments.
- **Status**: fixed 2026-11-13 (`commenterRefusal` refuses changes to `by.name`, `by.agent` and `edited` of others' comments; tests in sceneComments.test.ts)

### B127. Agent comment changes can lose the merge against a comment stamped by a faster clock
- **Area**: MCP server and shared modules (scenes-mcp)
- **Severity**: low
- **Confidence**: confirmed for the logic; needs clock skew between devices
- **Location**: `scenes-mcp/sceneComments.mjs:402`, `:418-428`, `:116-124`
- **Description**: `resolve`, `reopen`, `edit` and `delete` stamp `u = now + index`. If the stored comment's `u` is ahead of this browser's clock, the agent's version has the lower `u`: it is stored locally, but the next merge with Drive or another tab (`newer`) brings the old version back. `presentationChange` in `presentation.mjs:48-51` guards against exactly this with `Math.max(now, previous + 1)`.
- **Suggested fix**: Use `u: Math.max(at, previous.u + 1)` for changes of existing comments.
- **Status**: fixed 2026-11-13 (`applyCommentOps` stamps resolve / reopen / edit / delete with `changeStamp`: after the stored version also when its stamp is ahead of this clock; test in sceneComments.test.ts)

### B128. Feedback is refused for the ordinary word "data:"
- **Area**: MCP server and shared modules (scenes-mcp)
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-mcp/feedback.mjs:31`
- **Description**: `/\b(?:javascript|vbscript|data)\s*:/i` matches plain prose such as "Lost data: the scene was empty" and answers "Plain text only, please: no code, markup or scripts", which does not tell the user or agent what to change. The text is stored with bound parameters and shown as text, so the pattern protects nothing that the tag and backtick patterns do not.
- **Suggested fix**: Match only URL-like forms (`data:[a-z]+/`, `javascript:` followed by non-space), or drop `data`.
- **Status**: fixed 2026-11-13

## Code smells

### S8. Tool descriptions and comments describe an architecture and tools that no longer exist
- **Area**: MCP server and shared modules (scenes-mcp)
- **Severity**: medium
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-mcp/tools.mjs:593`, `:2006`, `:2044` (name `read_open_scene` / `edit_open_scene`, which exist only in live mode; the default and the online server are detached); `:1705` ("writes scenes/<name>.excalidraw"); `:1429`, `:788` ("The user's app picks it up / merges it within seconds", "never ... call the scenes server's HTTP API" also online); `:5`, `:12-18`, `:86-88`, `:144`, `:1290-1293` (comments: upstream tools "unchanged", "its own headless Excalidraw tab", "throwaway headless renderer"); `scenes-mcp/sceneName.mjs:1`
- **Description**: Agents read these descriptions as instructions. In detached mode `get_scene`, `get_conflict` and `resolve_conflict` point to tools the agent does not have. `scenes/<name>.excalidraw` is a leftover of the file/GitHub era. The comments still describe a headless agent tab, while both servers delete `agentSide` and run everything in the user's tab (`scenes-server/server.mjs:299-303`, `online/worker/pairing.ts:209-210`), and `read_me` is in fact replaced (`tools.mjs:2106-2110`).
- **Suggested fix**: Build the three descriptions from `MODE` (as `save_scene` and `open_scene` already do), remove the `scenes/` wording, and rewrite the header and section comments to the current design.
- **Status**: fixed 2026-11-13

### S40. Documentation contradicts the tools
- **Area**: MCP server and shared modules (scenes-mcp)
- **Severity**: low
- **Confidence**: confirmed (compared with tools.mjs, `.mcp.json`, `online/worker/index.ts`, `scenes-plugin/src/live.ts:599`)
- **Location**: `online/llms.txt:27`; `README-AGENTS.md:10-14`, `:42-43`, `:113-134`; `scenes-mcp/skill/kurviq-scenes/SKILL.md:18-19` (same text in `online/worker/skill.ts:21`)
- **Description**: (1) llms.txt says "Formatted text: write markdown in `text`"; the tools and REFERENCE.md say `markdown` instead of `text`, and that a plain `text` update drops the formatting. (2) README-AGENTS.md still tells online users to hand over `https://kurviq.com/mcp/<key>`, which the Worker refuses (llms.txt says so). (3) README-AGENTS.md says `.mcp.json` registers the server as `excalidraw`; it is `kurviq-local`. (4) Its tool table lacks `add_font` and `short_link`. (5) SKILL.md says `app_status` shows `drive: false`; `app_status` returns `drive` as a sentence ("not connected (...)", "online"); the boolean is only in `list_scenes` → `app` and `/api/app/state`.
- **Suggested fix**: Correct the five places; for (5) either document the string or return a boolean next to it.
- **Status**: fixed 2026-11-13: (2), (3), (4) in README-AGENTS.md, (1) in online/llms.txt (`markdown` instead of `text`), (5) in SKILL.md and online/worker/skill.ts (`drive`: "not connected")

### S41. Author keys are unsalted hashes of e-mail addresses in files anyone with the link can read
- **Area**: MCP server and shared modules (scenes-mcp)
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-mcp/sceneComments.mjs:13-15`, `:233-238`
- **Description**: The header argues the address itself is never stored because the file is readable by everyone it is shared with. `authorKey` is 64 bits of SHA-256 over a fixed prefix plus the address, so anyone with a list of candidate addresses can confirm who commented. It is a pseudonym, not protection of the address.
- **Suggested fix**: State this limit in the comment and the privacy text, or derive the key per scene (e.g. keyed with the file id) so keys cannot be matched across scenes.
- **Status**: not changed, by decision 2026-11-13: a per-scene salt (the file id) would work for the Worker (claims.ck has the file id) but not for every caller: local-only scenes have no file id, a scene's id changes when it goes from local-only to Drive or is copied (clone_scene, keep a local copy), and the comment UI's key is per person; its authors would lose their own comments. The limit (a pseudonym, not a secret) is now stated in sceneComments.mjs's header; the privacy page does not mention comments yet (owner's text)

### S42. Functions extracted only to pass their arguments through
- **Area**: MCP server and shared modules (scenes-mcp)
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-mcp/tools.mjs:687-701`, `:709-724`, `:726-746`, `:748-767`, `:769-791`, `:793-806`, `:888-905`
- **Description**: `readOpenResult`, `readSceneResult`, `applyOpenEdit`, `detachedEditCommand`, `detachedEditResult`, `renderSceneImage` and `openEditResult` each have one caller, take 8 to 13 named parameters and end in `const result = ...; return result;`. They hide the handler's flow without owning a job, and every new edit option has to be threaded through three signatures.
- **Suggested fix**: Build the command's optional fields once (one helper for both modes) and inline the rest.
- **Status**: fixed 2026-11-13 (one `editOperations` for both modes, `editResult` / `nothingAppliedResult` shared, the rest inlined)

## Dead code

### D1. `agentSide`, `agentCommand` and `renderImage({ userTab })` no longer do anything
- **Area**: MCP server and shared modules (scenes-mcp)
- **Severity**: medium
- **Confidence**: confirmed (repo-wide search: `agentSide` is set in tools.mjs and deleted by both servers, read nowhere)
- **Location**: `scenes-mcp/tools.mjs:144-146`, `:837`, `:1016-1019`, `:1510`; `scenes-server/server.mjs:299-303`; `online/worker/pairing.ts:209-210`
- **Description**: `agentCommand` adds `agentSide: true` in detached mode; both servers delete the field before routing. `agentCommand` and `appCommand` are therefore the same call in every mode, and so are `renderImage(..., { userTab: true })` and `local ? appCommand : agentCommand`. The code still reads as if the agent had its own tab.
- **Suggested fix**: Remove `agentSide`, `agentCommand` and the `userTab` option; call `appCommand` everywhere.
- **Also in the Astra review**: F36.
- **Status**: fixed 2026-11-13 (`agentCommand`, `agentSide`, `userTab` gone from tools.mjs; the `delete command.agentSide` lines removed from both relays)

### D2. The Node fallback conversion can only run in one case, where it harms
- **Area**: MCP server and shared modules (scenes-mcp)
- **Severity**: medium
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-mcp/tools.mjs:257-272`; `scenes-mcp/convert.mjs:8-203`
- **Description**: `convertInNode` is used when the `convert` command answers 409 or 504. With no tab (409) `save_scene` cannot finish: a Drive save already failed in `prepareSaveDestination` (`tools.mjs:960`, called before the conversion at `:1739-1742`), a local save fails at `local-save`, and online the Worker refuses the call before it starts (`online/worker/index.ts:264-280`). The only path that saves a fallback result is a convert timeout (504) followed by a tab that answers the save. Then the scene is stored with estimated text sizes, markdown reduced to plain text by a second parser (`plainOfMarkdown`), string labels dropped (`label?.text`, line 197), labels in the shape's stroke color (line 150; documented: dark unless set), text added with `containerId` not registered on its container, and `slide`, `stickynote`, font names and template copies unhandled, reported only as `convertedBy: "node (estimated text sizes)"`. Outside this path the 200 lines are exercised only by `scenes-plugin/test/richTips.test.ts`.
- **Suggested fix**: Remove the fallback and answer the timeout with the usual retry advice; keep `needsConversion` only.
- **Status**: fixed 2026-11-13 (convert.mjs keeps `needsConversion` only)

### D34. Unused option `uploadUrl`
- **Area**: MCP server and shared modules (scenes-mcp)
- **Severity**: low
- **Confidence**: confirmed (repo-wide search)
- **Location**: `scenes-mcp/tools.mjs:76-77`; passed at `online/worker/index.ts:291`
- **Description**: Destructured and never read; the upload address reaches agents through `kurviqReference(access.uploadUrl)`. `savePdf` passed online (`index.ts:305`) is equally unreachable, because `export_pdf` is not registered when `localFiles` is false.
- **Suggested fix**: Remove both.
- **Status**: partly fixed: `uploadUrl` is no option any more and `savePdf` is optional (export_pdf only with it); remains: `online/worker/index.ts` still passes `uploadUrl` and `savePdf`

### D36. Exports nobody imports
- **Area**: MCP server and shared modules (scenes-mcp)
- **Severity**: low
- **Confidence**: confirmed (repo-wide search in scenes-plugin, online, scenes-mcp, scenes-server, scripts)
- **Location**: `scenes-mcp/feedback.mjs:6` (`FEEDBACK_KINDS`; tools.mjs:543 repeats the list), `scenes-mcp/sceneComments.mjs:17-19` (`MAX_COMMENTS`, `MAX_TEXT`, `MAX_NAME`; `online/worker/contact.ts:77` has its own `MAX_NAME`), `scenes-mcp/editConflicts.mjs:65` (`formatText`), `scenes-mcp/inspect.mjs:8` (`elementBounds`); test-only: `editConflicts.mjs:207` (`findConflicts`), `sceneComments.mjs:241` (`sha256Fallback`, documented as such)
- **Description**: All are used inside their own file only (or by a test) but exported and, for the first two files, declared in the `.d.mts`.
- **Suggested fix**: Drop the `export` (and the declarations), or use `FEEDBACK_KINDS` in the tool schema.
- **Status**: partly fixed: `FEEDBACK_KINDS` is the tool's schema, `formatText` and `elementBounds` are no longer exported, `findConflicts` stays exported for its tests; remains: the exports of `sceneComments.mjs` (comments area)

## Duplications

### U6. Two parallel tool sets and repeated blocks inside tools.mjs
- **Area**: MCP server and shared modules (scenes-mcp)
- **Severity**: medium
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-mcp/tools.mjs:1203-1227` vs `:1443-1469` (the `update`, `reset`, `restyle`, `addTitleBlock`, `upsert`, `isPresentation` schemas, word for word); `:1244-1262` vs `:1486-1506` (conflict check and "nothing applied" answer); `:726-746` vs `:748-767` (optional command fields); `:848-866` vs `:868-886` (read images); `:1022-1036` vs `:1344-1358`; `:617-627` vs `:658-670` (`get_scene` repeats `sceneView`); `:172-195` (`loadSceneWithMd5` vs `loadSceneFile`, with different error handling)
- **Description**: Live mode (`read_open_scene`, `edit_open_scene`, `save_open_scene`) and detached mode implement the same reading, conflict handling and reporting twice, about 400 lines. Since both now run in the user's tab, a change to edit options or conflict reporting has to be made in two places, and they have already drifted (e.g. `idList` capping only in the detached result, lines 776-778 vs 894-896).
- **Suggested fix**: Share one options schema, one conflict step and one result builder; consider whether live mode is still needed as a separate tool set.
- **Status**: fixed 2026-11-13 (one edit schema, conflict step and result builder for both modes; whether the live mode stays is O2)

### U39. The local scenes server and the Worker's pairing object are two copies of the same relay, with different timeouts
- **Area**: MCP server and shared modules (scenes-mcp)
- **Severity**: low
- **Confidence**: confirmed (traced in code)
- **Location**: `scenes-server/server.mjs:81`, `:100-134`, `:298-336`, `:460-478`, `:500-541`; `online/worker/pairing.ts:46-49`, `:91-111`, `:123-141`, `:185-198`, `:232-251`
- **Description**: Tab ranking, `flushTabs`, the scene relay and command dispatch exist twice. They already differ: online gives `scene-edit`, `local-edit`, `render`, `deck-check`, `convert`, `http` 75 s, the local server 30 s for everything, so the same edit with pictures times out locally and not online. The same tools then behave differently per host for no stated reason.
- **Suggested fix**: Move the ranking, the slow-command list and the timeouts into a shared module (as done for `sceneName.mjs`), or at least use the same values.
- **Status**: fixed 2026-11-13 (`scenes-mcp/tabRelay.mjs`: tab ranking `bestTab`, the slow-command list, command / slow / flush timeouts; imported by `scenes-server/server.mjs` and `online/worker/pairing.ts`; locally slow commands now get 75 s like online; test tabRelay.test.ts)

### U40. Small helpers copied between scenes-mcp and the plugin
- **Area**: MCP server and shared modules (scenes-mcp)
- **Severity**: low
- **Confidence**: confirmed (compared both sides)
- **Location**: `needsConversion`: `scenes-mcp/convert.mjs:5-6` vs `scenes-plugin/src/live.ts:416-417` and `scenes-plugin/src/render.ts:233-235` (the plugin copies lack the `markdown` case); `withBoundText`: `scenes-mcp/inspect.mjs:43-54` vs `scenes-plugin/src/render.ts:157-171`; `markdownOfElement`: `scenes-mcp/richText.mjs:7-10` vs `scenes-plugin/src/richText/agent.ts:56-59` (different fallback text); comparable-value canonicalisation: `scenes-mcp/editConflicts.mjs:15-46` vs `scenes-mcp/elementContent.mjs:9-33` (they disagree on `[]` versus missing); path confinement: `scenes-mcp/media.mjs:20-31` vs `scenes-mcp/server.mjs:62-77`
- **Description**: Each pair states one rule twice and the copies have started to diverge. Example: an element with `version` and `markdown` counts as "needs conversion" in tools.mjs but not in the tab that converts it.
- **Suggested fix**: Import the scenes-mcp versions in the plugin (the modules are already shared), let `editConflicts` use `elementContent`'s normalisation, and export one `insideRoot(base, target)` helper.
- **Status**: fixed 2026-11-13: render.ts and live.ts import `needsConversion` (convert.mjs), render.ts `withBoundText` (boundText.mjs), editConflicts compares with `comparable`, `insideRoot` is shared; the `markdownOfElement` copy in richText/agent.ts was unused and is gone

## Over-engineering

### O14. Every read and edit ships the whole scene through the tab several times
- **Area**: MCP server and shared modules (scenes-mcp)
- **Severity**: low
- **Confidence**: confirmed (traced in code); cost not measured
- **Location**: `scenes-mcp/tools.mjs:613-614` (`get_scene` stores a checkpoint of the full scene on every call), `:1512-1516` and `:931-946` (the edit result's `elements` are sent back as `scene` for the picture, and the pre-edit scene again for the user's changes), `:1575-1579` (`view_scene(name)` loads the scene into the MCP process to send it back to the same tab)
- **Description**: The tab that owns the scene serves it to the MCP process, which returns it to the same tab to render. Online this passes the pairing WebSocket and the Worker's CPU budget (the reason `leanReads` exists). A render command naming the scene (and a revision) would avoid the round trips; the checkpoint written by every `get_scene` is used only if the agent later views or saves it.
- **Suggested fix**: Let `render` take `{ name, revision }` and resolve it in the tab; create the `get_scene` checkpoint lazily or drop it in favour of `view_scene(name)`.
- **Status**: partly fixed 2026-11-13: get_scene stores a checkpoint only with `checkpoint: true`; view_scene(name) sends a render command naming the scene (`sceneName`, optional `revision`), which the tab reads itself (local-only: its own copy; else as `/api/scenes/<name>`), so the scene no longer travels to the MCP and back. Remains: the pictures of edit results (the edited elements and the pre-edit version of the user's changes) still ship elements, as they show versions the tab no longer holds by name

### O15. Redirect protocol check that cannot fail
- **Area**: MCP server and shared modules (scenes-mcp)
- **Severity**: low
- **Confidence**: confirmed (fetch only follows http(s) redirects)
- **Location**: `scenes-mcp/media.mjs:51-53`
- **Description**: After `fetch(..., { redirect: "follow" })` the final URL is always http or https; the "redirected to a non-web address" branch is unreachable and suggests a protection (against internal targets) that is not there.
- **Suggested fix**: Remove it, or replace it with the host check proposed under "Image fetching trusts the URL's extension".
- **Status**: fixed 2026-11-13 (replaced by the per-hop host check of B125)

