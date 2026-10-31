<!-- Exported from the Claude Doc https://claude.ai/artifact/Px93qyvQSvVFpK93MNYw5K on 2026-10-31. The doc is the working copy; this file is the snapshot the implementation follows. -->

# Kurviq: event store and Drive saves

Oct 31, 2026 · @Fabian Wesner

## Summary

Every scene stored in Drive saves through its own Durable Object (DO), always, also for a single user; Drive stays the real copy, and scene content and tokens are deleted from active storage once Drive has them.

- **Always on for Drive scenes, off for local-only scenes.** Local-only scenes are never stored on our server (an agent using kurviq.com's hosted MCP does pass what it reads through our Worker in transit). Signed-in editors and viewers of Drive scenes connect to the scene's DO; anonymous viewers of public links read the last Drive save through the Worker's public endpoint, as today.
- **The DO is the authority.** Tabs send element changes within about a second. The DO checks each change against the element version the tab saw, re-stamps accepted elements with a new version, stores them and sends them to every open tab, which applies them as they come.
- **No edit lock.** Several tabs or people can edit at once; collisions are detected per element and nothing is lost silently.
- **Drive gets grouped versions.** Every minute while changes are pending, and when editing ends, the DO writes one Drive version per run of one user's work, with that user's own Google access, through a crash-safe save procedure.
- **Tokens only until the sync.** An author's refresh token is stored encrypted from their first unsaved change until their changes are in Drive, at most 4 hours after their last tab closed.
- **Three save stages for the user:** in this browser, on the server, in Drive. The browser keeps its changes until Drive has them, so even a lost server loses nothing.
- Content is encrypted with a key per scene kept on the Drive file, so our database is useless without Google access to that file. **Deletion is honest:** content and tokens leave active storage after the sync; Cloudflare's point-in-time recovery can still restore them for up to 30 days, and `/privacy` says so.

The last section lists what the two reviews found and how each point was resolved.

## Architecture

*(Architecture diagram: see the Claude Doc.)*

The scene's Durable Object is the only place that orders and stores changes; it sends each change live to every other open tab and saves grouped versions to Drive. Opening a scene, the scene list and the Picker keep reading Drive directly from the browser, as today.

## Where events live: Durable Object SQLite, not D1

Both are SQLite with full SQL. The DO's own storage wins because the DO already decides the order: writing next to it is one step, not a second system that can fail separately.

|  | Durable Object SQLite (recommended) | D1 |
| --- | --- | --- |
| Where | inside the scene's DO, same machine | separate database service, one primary location |
| Write path | DO orders and stores in one step, confirmed before the tab hears "saved" | DO orders, then a network call to D1; two steps that can fail apart |
| Load | one small database per scene | one database shared by all scenes, writes queue up behind each other |
| Size limit | 10 GB per scene (approximate) | 10 GB per database (approximate) |
| Recovery | point-in-time restore, 30 days | Time Travel restore, 30 days |
| Queries across scenes | no | yes |
| Price (approximate) | about $1 per million rows written, storage $0.20 per GB-month | about $1 per million rows written, storage $0.75 per GB-month |

D1 still has a small job: an index across scenes ("which scenes have changes not yet in Drive, and whose"). It lets Kurviq remind the right author and find every stored token copy when someone signs out everywhere. It holds no content: file ids and hashed account ids only, written through an outbox in the DO (D1 is a separate system, so a failed write is retried), and each entry is deleted with the scene's sync.

Prices and billing rules: see "Costs", checked against Cloudflare's pricing pages on 2026-10-31.

## Event model and collisions

The DO, not the tabs, decides which state of an element is current: it re-stamps every accepted element, and tabs apply the DO's stream as it comes instead of merging it with Excalidraw's own rules.

**Why re-stamping is needed.** Excalidraw's own merge (`reconcileElements`) keeps a local element when its version is higher. Two tabs can both produce "version 12" with different content, and a tab holding a higher version would ignore the DO's winner. Screens and Drive would then disagree without anyone noticing.

| Field | Meaning |
| --- | --- |
| seq | number assigned by the DO, strictly increasing per scene: the one order everyone agrees on |
| author | the Google account's stable id (`sub`), taken from the connection ticket, never from what the tab claims |
| via | "user" or "agent" (agents edit through the user's tab; set by the tab, so advisory) |
| tab, batch | the tab's id and its own counter: a resent batch is recognised and stored once |
| element | the element's new state (a delete is a state with `isDeleted`) |
| base | the element's version and `versionNonce` as the tab last received them from the DO (0 for a new element) |

- **Batches.** The tab collects changes for about 300 ms and sends the last state of each changed element, one event per element per batch. Each accepted batch is written to the DO's SQLite as one row before anyone hears of it: the answer to the sender and the messages to other tabs leave only once the write is durable (Cloudflare's output gate). A restart can never forget a change someone was told about.
- **Logical operations stay whole.** Everything one action changes (a shape with its bound arrows and label, a group move, a text edit with its layout) travels in one batch and is accepted or refused as a whole.
- **Accepting.** If an event's base matches the element's current version and nonce, the DO accepts it and re-stamps it: version = current + 1, a fresh `versionNonce`. The answer and the message to all other tabs carry the re-stamped version. A tab may send a second batch for an element before the first is answered: its base then names its own pending batch, which the DO accepts if that batch produced the current state.
- **The tab keeps two layers.** The confirmed state from the DO, and on top its own unsent and unanswered changes. An answer updates the confirmed layer and removes only the matching pending change; newer local edits stay on top. Changes from the DO are applied without entering the user's undo history and without being sent back.
- **Gestures in progress.** An element being dragged or a text being typed is not overwritten by an incoming change: the tab keeps its local draft and the base the gesture started from, and sends the result when the gesture ends. If the element changed meanwhile, the collision rules below apply.
- **Undo and redo** reverse only the user's own steps, and only properties whose current value is still the one the user's step produced. A property someone else changed since is left alone, and the user sees a short note. Undo and redo then go through the same checks as any change.
- **Collision** (base does not match, or the element is unknown to the DO while the base is not 0): the DO refuses the event and returns the current state.
  - **Live** (decided by a flag set when the change was made: the tab was connected and up to date at that moment, whichever connection finally carries the batch): the tab re-applies only the properties its user changed onto the current state and resends (decided). Only if both changed the same property does the later change win; the other author sees "Anna changed this at the same time: restore yours?" until the next sync.
  - **After offline** (changes made while disconnected or behind): nothing of the colliding batch is applied. The tab saves its whole local scene, with images and fonts, as a new scene "Scene (offline changes)". Only changes whose whole "touching" group (see "Saving") contains no colliding element are re-sent. Batches older than 30 days are never replayed; they always go into such a copy.
- **References are checked.** The DO refuses an element that refers to a deleted or unknown frame, container, shape or group member; the tab rebases or moves it into the offline copy. Every refusal has a reason, and the tab always resolves it, so screens never silently disagree.
- **Element order.** Fractional indices are readable to the DO, which repairs clashes when it accepts a batch and sends the repair; tabs never send repairs of their own.
- **Not only elements.** Events also carry scene settings (background, grid), the scene name, images (the `files` map) and embedded fonts (`kurviqFonts`), each with its own base. Images and fonts are identified by a hash of their bytes, so adding the same image twice is not a collision. Fonts additionally get a scene-wide mapping from their hash to Excalidraw's numeric font id, assigned by the DO without clashes; elements are remapped if two fonts arrived with the same number.
- **Current state** is the last saved state plus the batches since. The saved state is kept as an encrypted snapshot (readable fields in clear per element, so base checks work without the key). With each confirmed upload, in one transaction, the DO writes the change to the snapshot and deletes that upload's batch rows; compaction happens once per round. A crash between two uploads of a round therefore never loses saved work. The snapshot is also the base for merging outside changes, so no old Drive revision has to be downloaded.
- **Offline queue.** The tab keeps every change in IndexedDB, keyed by account (`sub`), Drive file id and tab, until Drive has it, not just until the DO answered. "In this browser" is shown only after that write succeeded; if browser storage fails, the status says "not saved" and offers an export. Tabs never overwrite each other's queues, a queue is sent from any open tab of the same account, and a queue of another account is held back, never sent as the signed-in user.

## Connecting, joining and switching

Whether a scene uses our server follows only its Drive setting; every connection starts with a short-lived ticket and a handshake, so a tab never edits on top of state it has not seen.

| Scene | Our server | Saving |
| --- | --- | --- |
| Local only (laptop icon), or user signed out | no connection, nothing stored with us | in the browser only, as today |
| In Drive (cloud icon) | changes, encrypted refresh tokens and per-scene metadata in the scene's DO | DO to Drive |

**Connecting.**

1. The tab asks the Worker for a ticket: `POST /scene/<fileId>/ticket` with the sign-in cookie, or the local install's sealed session in the body (never in a URL).
2. The Worker checks the session and issues a ticket valid 60 s, usable once, bound to this file and this account (`sub`).
3. The tab opens the WebSocket on a new route, `/scene/<fileId>/live?ticket=…`, served by a new DO class, separate from today's agent `Pairing` DO and its `/live` route.
4. The ticket also carries the person's role (edit or read), which the Worker checked with Drive; no Google token goes to the DO at connect (see "Tokens and access proofs").

**Joining (handshake).** The tab sends the Drive revision it loaded, its last seen seq and the DO's generation id. The DO answers with one coherent starting point: the events since then, or the full current state (snapshot plus events) when the tab is too far behind or the generation changed. Events that arrive meanwhile are queued for that tab, so nothing falls between snapshot and stream. Every answer names the file id and the tab's open-scene token; a tab that has switched scenes ignores it.

**An empty DO** (first use, or content deleted after a sync) holds no token and no key, so it does not load Drive itself. When issuing an editor's ticket, the Worker reads the file's current revision and checksum with that editor's access and puts them into the ticket. The editor's tab may seed the DO with an encrypted snapshot only if it loaded exactly that revision; otherwise it reloads from Drive first. The first valid seed wins; later seeders rebase onto it. A reseed after the normal cleanup keeps the generation; only lost metadata starts a new one. Viewers who connect before any editor load the saved file from Drive themselves and get live changes once an editor has seeded the DO.

**After a new generation** (the DO's data was lost), tabs resend only what Drive does not have yet. Every saved Drive file carries receipts: per tab (a random id per scene, so tabs cannot be linked across scenes), the batches it contains, as a contiguous mark plus the exceptions above it; receipts older than 30 days are dropped. A resent batch whose base matches the current content is rebased automatically; one that builds on another tab's lost, unsaved batch cannot be, and goes into an offline copy. Missing receipts (for example removed by an outside app) mean reconciling by content, never blind replay.

**Switching.**

- **Put in Drive.** The tab creates the Drive file as today, then connects. Changes made during the switch stay in the local copy and are sent once connected.
- **Keep only here, scene used by you alone.** Allowed only when no other tab is connected and no other author has unsaved changes. The DO first closes the scene: it refuses new connections and writes and finishes any running save. Only then does it send its final state; the tab stores that state with all images and fonts in the browser and confirms; then the DO deletes the scene's content and tokens and the Drive file goes to the trash as today.
- **Keep only here, shared scene or others' unsaved changes.** Refused (a new rule: today the owner can still move a shared scene out of Drive). Offered instead: "Keep a local copy", a new local-only scene, complete only once every image and font it uses is stored in the browser; the shared scene is not touched.
- **Signing out (this browser).** Immediate: the cookie is cleared and this browser's connections close. Stored tokens of this account stay until their changes are in Drive, so sign-out never waits on a sync. Scenes become local only in this browser; local edits made while signed out reach the shared scene only through "Put in Drive" as a new scene, never silently.
- **Sign out everywhere.** Kurviq is revoked at Google, every stored token copy (found through the D1 index) is deleted, and this account's unsaved changes become "cannot be saved as their author" (see "Saving").

**Scene lifecycle.** Each scene's DO keeps a small lifecycle record (state and epoch) that survives every cleanup: active, trashed, or local only.

- **Trashed** (in Kurviq or in Drive's interface, reported by the Drive watch or seen before a save): saving stops, every tab is told, changes are kept up to 7 days and can be saved as a new scene. Drive would accept writes to a trashed file, so the DO checks before each save.
- **Restored from the trash:** a new epoch starts and the tabs reload; changes from before stay recoverable as a copy, never applied automatically.
- **Permanently deleted:** the lifecycle record turns into a tombstone; batches for it are refused and offered as a new scene.
- **Put in Drive twice by a retry:** the tab records the creation before it starts and reuses it, so an unanswered request never creates a second file.
- **Name and identity.** A Drive scene is identified only by its file id. A rename in Kurviq is an event like any other; a rename in Drive's interface arrives through the Drive watch or the next access-proof renewal and is sent to all tabs. Two scenes may have the same name; the scene list then shows the owner to tell them apart, and recognises Kurviq scenes by their app property, not by the `.excalidraw` ending.

**Accounts in one browser.** Everything (connections, queues, caches) is keyed by the account's `sub`. Switching accounts closes the old account's connections first and resets the canvas to the confirmed state, so the new account never sends the old one's edits; its unsent changes stay its own and are never sent as the new account. A sign-in that merely expired is not a sign-out: changes stay queued and Kurviq asks to sign in again. "Open with Kurviq" from Drive with a different Google account than the signed-in one asks which account to use.

**Cloudflare unreachable.** The tab keeps editing and queues changes locally ("in this browser"). It never writes to Drive itself, so there is never a second writer.

**Connections.** A batch not answered within 10 seconds means the connection is treated as dead: the tab reconnects, goes through the handshake and resends; the DO stores a resent batch only once. Pings are answered without waking the DO, so a vanished tab is noticed at the latest when its access proof expires (15 minutes); the presence list shows when each person was last active. If Google is unreachable (timeouts or server errors only, never a refusal such as "not found" or "access denied"), the Worker extends existing access proofs, at most 2 hours after the last successful check and never past a sign-out everywhere, instead of disconnecting everyone; new connections wait until Google answers again.

**Old app versions** still write to Drive directly. The Drive file is marked (`appProperties.kurviqSync = "do-1"`); new versions refuse to write such a file directly, and a write by an old version is handled as a change made outside Kurviq.

## Saving to Drive: grouping events per user

At each save the DO replays the events not yet in Drive and writes one Drive version per run of one user's work, each with that user's token. An event joins its author's version unless it builds on someone else's unsaved event.

*(Grouping diagram: see the Claude Doc.)*

Your first example gives 2 versions, as you expected. The second gives 3, not 2: User 1's last change (D → B) builds on User 2's change, so User 2's version must come first.

**The algorithm, per save round:**

1. Take the events not yet in Drive, in seq order.
2. The author of the earliest one whose changes can be saved is next (call them a). A new group also starts wherever `via` switches between user and agent.
3. Walk the events in order with an empty set of blocked elements. An event of a that touches no blocked element joins a's group. Any other event (another author, or touching a blocked element) blocks every element it touches for the rest of the walk.
4. Write a's version: the last saved Drive state plus, for each element in a's group, its state from a's last event in the group (not the current state, which may already contain later changes by others).
5. Remove those events and repeat from step 2 until none are left.

**What counts as "touching".** An event touches its own element plus every element and asset it refers to before and after the change: an arrow's start and end shapes, a label's container and a container's labels, the frame, all members of every group in `groupIds` (a group id names a group, not an element), the image data behind `fileId` and the embedded font behind `fontFamily`. Checking both states catches a reference that the change removes. This is deliberately cautious: it can create an extra version, but never a Drive version with an arrow bound to a shape that is not there yet, a missing image or a missing font. Clashing fractional indices are repaired by the DO when it accepts a batch (see "Event model").

**Save rounds:**

- **Rhythm.** A save round runs every minute while changes are pending, and right after the last tab disconnects. If a round could not write everything (see "Many alternations"), the next round starts at once. All timers (rounds, retries, leases, the 7-day limit) share the DO's single alarm through a small schedule table; the alarm handler can safely run twice.
- **One upload at a time.** Each upload has a fixed content and an exact list of the batches it contains (not necessarily consecutive). Changes accepted while it runs wait for the next one; finishing an upload never touches them. Each saved file carries the receipts described under "Joining".
- **Crash-safe saving.** Each save gets an operation id, written into the file content, so the content's checksum is unique. Before uploading, the DO records the operation with its batch list, that checksum and the revision it builds on. When Drive confirms, one transaction updates the snapshot and deletes the saved batch rows. After a crash, the DO lists the revisions since that base: one with the recorded checksum means done, even if newer revisions followed. Otherwise any newer revision is first handled as an outside change, then the DO uploads anew. Never a blind re-upload over newer content.
- **Changes made outside Kurviq.** Detected by a Drive watch notification about content, by an access-proof renewal (which also reads the file's newest revision, name and trash state), or before a round. If no author's token is stored at that moment, the DO asks one connected tab of anyone who can read the file to fetch a one-time access token through the Worker; it is kept in memory for this merge only. The DO first checks whether the newest revision is its own last save; if not, it downloads the current file and merges three-way against its snapshot, comparing actual content including order (`index`), images, fonts and scene settings; matching version stamps alone never count as equal (today's comparison helper has to change for this). An element changed on both sides: Kurviq's pending change wins (decided); the outside version stays in Drive's history. The merged outside revision becomes the new snapshot base, already saved and marked "outside Kurviq"; it is sent to all tabs as confirmed changes and never enters the walk, so it never blocks anyone. A write that lands between check and upload is caught right after: the DO lists revisions, finds a foreign one before its own, merges and saves again. Against an outside app writing continuously, Drive's history is the safety net, not a guarantee.
- **Squash overwritten work?** No (decided): User 2 would vanish from Drive's history.
- **Many alternations.** At most 5 versions per round; the remaining groups follow in the next round, started immediately. Never a combined version under one person's name.
- **Changes that cannot be saved as their author** (lease ran out, Kurviq revoked, lost edit rights, never opened the file in Kurviq): the walk skips them, so other people's independent work keeps saving. Work that builds on them waits. After 24 hours, editors see "Anna's changes could not be saved: accept them as yours, or discard"; accepting or discarding also resolves everything that builds on them. Discarded batches are recorded, so a later resend from Anna's browser is refused and goes into an offline copy instead of returning silently. If nobody decides within 7 days, the next editor whose work depends on them accepts them, and changes nobody's work depends on are accepted by the next editor who connects. This applies also when the author has lost access (decided); the changes are kept until then. Either way the record is kept in the file content: each element carries its last author as a per-scene pseudonym (decided), and a short list (the last 50) records "saved by \[pseudonym\] on behalf of \[pseudonym\]". Pseudonyms are derived by the Worker from the account id, the file id and a server secret, so they cannot be linked across scenes even by someone who holds both scene keys. Nothing is ever saved under someone else without that record.
- **Drive full or rate-limited.** Reported as what it is ("the owner's Drive is full"), not as an author problem; changes stay on the server and saving resumes when possible.
- **Agents.** Agents work through the user's tab on its live state, and their commands carry an id so a retry never applies twice. An agent's changes form their own version, marked as today (`appProperties.agentRev`). Until that version is in Drive, the tab uses the DO's seq of the agent's last change as the agent baseline, so `read_scene` never reports the agent's own edit as a user change.

## Tokens and access proofs

Access is proven to the Worker with the sign-in cookie; an editor's refresh token reaches the DO only sealed, and is stored only together with that author's first unsaved change, at most 4 hours after their last renewal.

This works with today's sign-in: it is Google's web server flow, the Worker holds the client secret, and the refresh token sits sealed in the user's httpOnly cookie. `drive.file` grants belong to the Kurviq app, not the browser, so the DO can write exactly as the tab does.

1. **Access proof.** At connect the Worker checks the session and asks Drive with the user's access whether they may edit or read the file (`capabilities`). The resulting access proof carries the role and is valid 15 minutes (the connect ticket itself is single-use and valid 60 seconds). While connected, the tab renews it every 10 minutes (a POST with the cookie) and at once when the DO asks, after a sharing notification. Without a valid proof the DO stops sending to that tab and closes the connection. So access ends at most 15 minutes after it was removed in Drive, or 2 hours while Google is unreachable (see "Connections").
2. **Author's refresh token.** An editor's ticket and each renewed proof carry the editor's refresh token, sealed by the Worker with `TOKEN_KEY` (a Worker secret outside the database; AES-GCM bound to the file id, the author's `sub`, an expiry and a key id). The DO keeps it attached to that editor's connection and copies it into its token table in the same transaction that accepts the author's first batch. A batch is therefore never accepted without its author's token, and no separate hand-over can fail. Viewers' connections never carry a token.
3. **Lease.** The expiry is the last renewal plus 4 hours; every renewal of an author with unsaved changes extends it. So it ends at most 4 hours after the author's last tab closed.
4. **Each save.** The DO decrypts the token, gets a 1-hour access token from Google, keeps it in memory and writes the author's version.
5. **Deleted** when the author's last change is in Drive (the normal case, usually within a minute), when the scene is switched to local only, on "sign out everywhere", and when the lease runs out; the connection's copy goes with the connection. Then their changes wait and are saved the next time they connect. A restored copy past its expiry, or older than a sign-out everywhere, is refused.
6. **The cookie stays valid.** Google's refresh tokens do not rotate (noted in `auth.ts`), so the stored copy and the cookie work side by side. Revoking Kurviq in the Google account ends both.

**Changes to the sign-in itself:**

- **Stable identity.** The session keeps only the email address today. It must keep Google's `sub`, which never changes; today's refresh ignores Google's identity token, so the code must read the sub there, or ask for a new sign-in when a refresh returns none.
- **Expiry for sealed sessions.** The local install's sealed session has no expiry today. It gets an issue time and an expiry, renewed on use.

**When saving as the author fails:** see "Changes that cannot be saved as their author" under "Saving".

## Encryption: the key lives with the Drive file

Scene content in our database is encrypted with one key per scene, and that key is stored only on the scene's Drive file; without Google access to that file, our data is useless.

**The key.** A random 256-bit AES-GCM key, stored as a private Kurviq property on the Drive file (`appProperties.kurviqKey`, base64 with a key id and the file id, well within Drive's 124 bytes per property). It is metadata, not part of the drawing: Drive's interface does not show it, other apps cannot read it, and it is not in the downloaded `.excalidraw` file. Only signed-in requests through Kurviq's OAuth client, by someone with access to that file, can read it. Google refuses private properties to API keys ("You cannot use an API key to retrieve private properties", Drive docs on properties; confirmed with Kurviq's key on a public scene on 2026-10-31). Access to the key is therefore signed-in access to the file, and to nothing else.

**Why one key per scene.** A key per user would break sharing or expose all of a user's scenes once one is public; one key for all of Kurviq would be a server secret again. Per scene, a leak of one key opens only that scene, and even a public scene's key stays private.

**Lifecycle.**

1. A scene put in Drive gets its key from the tab, sent with the first upload.
2. Existing Drive scenes get theirs on the first editor's connection after the switch. The Worker creates it while issuing that editor's ticket, under a lease from the DO that only one request can hold at a time: it reads the property; if a key is there, the DO adopts it; otherwise the Worker writes a new one and the DO records its fingerprint. The lease lasts longer than any Drive request may take, so a delayed write from an earlier attempt can never land after a later one. Until a key exists, edits stay in the browser queue ("in this browser"); the DO refuses batches without a key id. Once a scene has a key, a missing or changed key property is an error to resolve, never a reason to create a new key, which would make stored changes unreadable.
3. **No rotation** (decided): one key for the scene's lifetime. Someone who loses access keeps the key they had, but would also need a leak of our database to use it, and only for changes made since.
4. If Drive copies app properties when a file is copied, the copy carries the original's key with a mismatching file id. Tabs ignore such a key; the first editor who opens the copy in Kurviq gets a new one the same way. Until then the copy has no live mode.
5. Older app versions cannot send plaintext: the ticket carries a protocol version, and the DO refuses older ones.

**Who sees what.**

| Who | Sees in readable form |
| --- | --- |
| Tabs of people with access | everything: they fetch the key from Drive with their own access, encrypt each element's content before sending and decrypt what they receive |
| Our database and its backups | only what ordering and collision checks need: element ids, versions, references (arrow to shape, label to container, groups, frame), deletions, sizes, authors (`sub`) and times; content, text, images, settings, fonts and the scene name are encrypted |
| The DO during a save | the plaintext, in memory for a few seconds: it fetches the key with the author's access, decrypts, merges, builds the file, uploads, forgets the key |
| Anonymous viewers of a public scene | no key and no connection to the DO: they see the last Drive save (usually 1 to 2 minutes old), checked as today; live changes need signing in with read access |

**The boundary.** Readable to the DO: `id`, `version`, `versionNonce`, `isDeleted`, `index`, and the references `boundElements` (ids), `containerId`, the start and end binding element ids, `frameId`, `groupIds`, `fileId` and `fontFamily`. Everything else is encrypted: geometry, style, text, image data, scene settings, fonts and the scene name. Tabs remove the readable fields before encrypting and put them back from the readable copy after decrypting, so the DO's re-stamped version is always the one in force. Each encrypted element has its own random IV; file id, element id and key id are bound in as additional data, so an encrypted element cannot be moved to another element or scene.

**What this protects, and what not.** A leak of our database or of Cloudflare's 30-day backups reveals no content to anyone who never had access to the scene. People who once had access keep the key and could read changes made since in such a leak. It does not protect against our Worker being taken over while it runs: during saves it holds keys and, with a stored refresh token, could fetch them. The readable fields listed above stay readable, and Google can see the key like the file itself.

**Real end-to-end encryption** (the server never sees the key) would mean only an author's tab could build and save Drive files, so saving would stop whenever the author closes Kurviq. That contradicts saving independently of the browser, so it is not chosen.

**To verify in step 1:** whether Drive copies app properties when a file is copied. Either way is safe: the file id stored with the key reveals a copy, which then gets its own key.

## History

History is Drive's versions only: Kurviq deletes its events after each sync, so the save rhythm decides how far back Drive's history reaches.

A Drive version is written only for a minute with changes, and it holds all changes of that minute, however many. Idle minutes add nothing, so 100 versions are 100 minutes with changes, not 100 changes and not 100 minutes of clock time. The table below counts minutes of active editing.

**Drive's limits** ([Drive docs](https://developers.google.com/workspace/drive/api/guides/manage-revisions)): versions are kept about 30 days, and once a file has 100 of them, older ones can go earlier. Up to 200 versions can be marked "keep forever".

| Save interval while editing | 100 versions cover |
| --- | --- |
| every 10 s (today's idle save) | about 17 minutes of editing |
| every minute | about 1.7 hours (chosen) |
| every 5 minutes | about 8 hours |

- **The table assumes one author.** With several authors a round can write up to 5 versions, so the history reaches back correspondingly less.
- **Pins ("keep forever") cost the owner's Drive storage**, because each pinned version is a full copy of the file, images included. So Kurviq pins sparingly (decided): one milestone per day with edits, plus the latest agent mark, at most 30 pins per scene including that mark. Google allows 200 pins per file in total; Kurviq counts the user's own pins too and stops pinning milestones, visibly, when the file is near that limit. If un-pinning turns out to work (a check in step 1; today's code relies on it), the previous agent mark is un-pinned instead of deleted; if not, agent marks are no longer pinned at all. When the budget is full, Kurviq deletes its own oldest pinned revision, never the latest agent mark and never a revision it did not pin itself (it records which ones it pinned). Google documents that a pinned revision can afterwards only be downloaded or deleted; today's `markAgentVersion` tries to un-pin the previous agent mark, whether that works is checked in step 1.
- **Restoring** an old version creates a new change on top of the current state; it never resets the DO's numbering. Kurviq shows whether an old version's content is still available.
- **Per author.** Grouping gives each version its real author, so Drive's history shows who did what.
- **Collision losers** can be restored only until the next sync; after that only Drive's versions remain.

## Failure cases

The rule throughout: no work is lost silently, and the browser keeps every change until Drive has it, so even a lost server costs nothing that was ever made in a browser.

| Case | What happens |
| --- | --- |
| Connection drops for a few seconds | Batches are resent; the DO recognises a resent batch by tab and counter and stores it once. |
| Offline longer | Changes queue in the browser ("in this browser"). On reconnect the handshake brings the tab up to date; colliding changes and everything touching them go into "Scene (offline changes)" with the whole local scene. Batches older than 30 days are never replayed. |
| Tab closed with unsent changes | They stay in browser storage and are sent the next time Kurviq opens, whichever scene. |
| Tab closed after sending | Nothing needed from the browser: the change was stored before it was confirmed, and the DO saves with the author's stored token. |
| Cloudflare unreachable | The tab queues locally and never writes to Drive itself. |
| Two people change one element at the same moment | Merged per property; only for the same property the later change wins, and the other author can restore theirs until the next sync. |
| DO restarted or evicted | Every confirmed batch, the snapshot, save records and encrypted tokens are on disk; nothing confirmed is lost. |
| DO stops during a save | The save record decides: done if a revision with the recorded checksum exists, otherwise newer revisions are merged first and the save runs again. |
| Drive save fails | Retried with growing pauses through the schedule table; changes stay "on the server". |
| Author cannot be saved as | Their changes wait; others' independent work keeps saving; editors decide after 24 hours (see "Saving"). |
| Drive file changed outside Kurviq | Merged per element against the last saved snapshot; Kurviq's pending change wins a clash (see "Saving"). |
| Drive file trashed or access removed | Saving stops; editors are told and can save the scene as a new file; changes are kept up to 7 days. |
| No key yet for an existing scene | Edits stay in the browser queue until one editor's tab has created the key. |
| Our store lost or attacked | Drive has the last save; browsers still hold everything not yet in Drive and resend it after the handshake starts a new generation. Content is encrypted with keys we do not store; tokens are useless without `TOKEN_KEY`. |

## Security, privacy, retention

Access is checked at connect and again whenever Drive reports a sharing change, content and tokens leave active storage after the sync (the encrypted snapshot stays while tabs are connected), and `/privacy` states both the active retention and Cloudflare's 30-day recovery window.

Scene content in the DO and in its backups is encrypted with the scene's key from Drive (see "Encryption"); the table below lists how long even the encrypted data stays.

| Data | Leaves active storage when |
| --- | --- |
| changes (batch rows, encrypted) | the save that contains them is recorded as done |
| snapshot of the last save (encrypted) | no tab has been connected for 10 minutes and everything is in Drive |
| collision losers (encrypted) | the next save round |
| changes of an author who cannot be saved as, or of a trashed file | trashed file: at most 7 days; author who cannot be saved as: until an editor accepts or discards them, automatically after 7 days |
| author's refresh token (encrypted, lease) | their last change is in Drive; scene switched to local only; sign out everywhere; at most 4 hours after their last renewal |
| access tokens | memory only, for one save or one access check |
| socket attachments | the connection closes; they hold account id, tab id, role, proof expiry and, for editors only, the sealed refresh token |
| metadata: seq, generation, last Drive revision and checksum, save records without content, resend counters per tab | kept; resend counters expire after 30 days |
| all of the above | restorable by Cloudflare's point-in-time recovery for up to 30 days after deletion |

- **Who may edit or watch.** Proven by the access proofs described in "Tokens and access proofs": checked by the Worker with Drive at connect, renewed every 10 minutes and on request. A tab without a valid proof receives nothing more, and every message the DO sends or accepts checks the proof's expiry. Drive checks again on every save, since it is made with the author's own access.
- **Sharing and content changes.** While anyone signed in is connected, the DO keeps a Drive watch on the file (`files.watch`). The Worker creates and renews it during an access-proof renewal, with that person's access, before it expires (at most 1 day), and stops it when the last person leaves. The webhook checks the channel's secret token and resource id. Sharing changes make the DO ask every tab to renew its proof at once; content changes by others start an outside-change merge; trash and rename notifications update the lifecycle record and the name; notifications about Kurviq's own saves are dropped in the Worker. Drive does not guarantee delivery; the renewals bound the delay anyway (15 minutes, 2 hours while Google is unreachable).
- **Sign out everywhere** sets a revocation mark in a small per-account DO (strongly consistent, unlike D1); tickets, proofs and stored tokens of that account are checked against it. D1 is used only to find stored token copies to delete.
- **`drive.file` and collaborators.** A collaborator who never opened the file through Kurviq gets "not found" from Drive, even for a public link. Kurviq explains this and offers the Picker; it is not a missing permission.
- **Anonymous viewers.** They never reach a scene's DO: they use today's cached public endpoint, which reads only the saved Drive file. Its cache is shortened to 60 seconds without stale serving (decided). Under light load viewers see changes within 1 to 2 minutes; save backlogs or outages make it longer, so the viewer shows the time of the last save. Turning off public sharing takes effect within about 2 minutes. Requests are limited per IP, so random file ids cannot use up quota.
- **Identity** comes from the ticket (the account's `sub`), never from what a tab claims.
- **Validation.** The DO checks every batch's size and readable fields before storing it; during a save it checks that each encrypted element decrypts and is a valid Excalidraw element. An invalid change is set aside with a visible error for its author and never blocks other changes or replaces the last good save.
- **Limits** per account and scene: batch size, changes per minute, image size, scene size, pending storage, connections per scene. A batch over a limit is refused before it is accepted, the tab keeps it and explains what to do; nothing is ever cut off silently. Rows stay below Cloudflare's 2 MB row limit by chunking.
- **Logs** stay off (`observability` disabled), and the code logs no content or tokens.
- **If the Worker and its secrets were taken over,** an attacker could read scenes while they are being saved and use stored refresh tokens of authors with unsynced changes (usually minutes, at most 4 hours after they left), limited to files Kurviq created or opened (`drive.file`). Drive's version history would let users roll changes back. Today the Worker already unseals refresh tokens for every `/auth/token` call.

## Costs on Workers Paid

About $5 a month up to a few thousand hours of editing, and about $35 at 10,000 hours: the DO is billed only while its handlers run, and the main cost is writing every change to disk before confirming it. Step 1 measures this before launch.

**What Cloudflare bills here** ([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)):

- **Duration** only while `webSocketMessage()`, `webSocketClose()`, `alarm()` or the constructor run. The time between messages is free, because the DO is eligible for hibernation. Awaiting the upload to Drive inside `alarm()` is billed in full.
- **Things that keep the DO billed** (up to 15 minutes each) are forbidden in the code: `setTimeout`, `setInterval`, `ctx.waitUntil()`, unfinished `fetch` outside a handler, outbound sockets, `ws.accept()`. Pings are answered by `setWebSocketAutoResponse()`, which wakes nothing.
- **Free:** outgoing WebSocket messages, `ws.send()` to many tabs, `serializeAttachment()`.
- **Rows written:** every insert and every delete counts. Tables use an `INTEGER PRIMARY KEY` (or `WITHOUT ROWID`), so an insert is one row, not two.

**Assumptions per editing hour:** 3,600 messages at about 10 ms; 60 save rounds at about 2 s. About 8,000 rows written: 3,600 batch rows stored and 3,600 deleted after the save, about 360 snapshot rows, save records, schedule entries and resend counters. About 300 DO requests: incoming messages count 20 to 1 (180), plus alarms, access-proof renewals and the few sharing notifications that reach the DO. Usage above the included amount is rounded up to the next whole million.

| Editing hours per month | Rows written | DO time | Requests | Total (approximate) |
| --- | --- | --- | --- | --- |
| 100 | 0.8 M | 2,000 GB-s | 0.03 M | $5 |
| 1,000 | 8 M | 20,000 GB-s | 0.3 M | $5 |
| 10,000 | 80 M, $30 over | 200,000 GB-s | 3 M, $0.30 over | about $35 |

Included per month: 50 M rows written, 400,000 GB-s, 1 M DO requests; Worker requests (tickets, webhooks) have their own 10 M. **Measured in step 1** with `rowsWritten` on each SQL call and Cloudflare's per-namespace metrics (GraphQL `durableObjectsPeriodicGroups`).

These figures assume one editor working at a time. Several editors, many viewers, image-heavy scenes (each Drive version uploads the whole file) and agents are measured separately before launch, and per-scene limits stop runaway costs before they happen.

## Decisions and plan

All design decisions are made (2026-10-31); the plan below builds on them.

| Decision | Decided |
| --- | --- |
| Where changes live | DO SQLite per scene; D1 only for an index of scenes with pending syncs |
| Save rhythm | every minute with changes, and when the last tab disconnects; one pinned milestone per day, at most 30 pins per scene |
| Live collisions | merged per property; same property: later change wins, restore offered until the next sync |
| Offline collisions | whole local scene saved as a new scene |
| Overwritten work (example 2) | keep every author's version |
| Refresh tokens | stored only for authors with unsaved changes; deleted once synced, at most 4 hours after their last renewal |
| Changes that cannot be saved as their author | editors decide after 24 hours; accepted automatically after 7 days by the next dependent editor (or the next editor who connects, if nothing depends on them), also for authors who lost access; always recorded |
| Access checks | access proofs renewed every 10 minutes (valid 15), plus Drive push notifications on sharing, content, trash and rename changes |
| Encryption | one key per scene in the Drive file's private app properties; tabs encrypt content |
| Key rotation | none: one key per scene for its lifetime |
| Public link cache | 60 seconds, no stale serving |
| Authors in the file | per-scene pseudonym per element (derived from account id and scene key) |
| Clash with an outside change | Kurviq's pending change wins; the outside version stays in Drive's history |

**Plan, each step shippable on its own:**

1. **One account, safely, on all its tabs, devices and the local install.** Scene DO on its own route, tickets and access proofs, handshake with generations and receipts, seeding checked against Drive, re-stamping, durable writes before confirming, two-layer tabs, gestures, conditional undo, per-property rebase, encrypted snapshot updated per upload, one-upload-at-a-time crash-safe saving, stored tokens with leases, outside changes merged with a one-time token, encryption with the per-scene key under a creation lease, scene lifecycle, offline copies, account switching, the `kurviqSync` marker and protocol version (new versions never write a marked file directly; writes by old versions are merged as outside changes), "in this browser / on the server / in Drive" status, `sub` in the session, the pin fix, the 60-second public cache. Other people's tabs are view-only in this step. First behind a switch for our own scenes; measure rows and DO time.
2. **Several people.** Editing by others, grouping per author, pseudonyms, changes that cannot be saved as their author, Drive watch for sharing and content changes, signed-in viewers live instead of polling Drive.
3. **Remaining edge cases.** "Keep a local copy", sign out everywhere, copies made in Drive.
4. **Launch.** `/privacy` updated, `TOKEN_KEY` set with rotation, limits in place, costs measured for one editor, several editors, many viewers, image-heavy scenes and agent use; then on for everyone.

**Checks in step 1:** whether the Picker can grant access to a file that is only shared by link; whether revoking Kurviq at Google also removes its `drive.file` grants; whether Drive copies app properties on a copy; whether deleting an old pinned revision works as documented; Cloudflare's WebSocket message size limit (images are sent in chunks below it).

**Tests before step 2 ships:** undo with two editors on one element, a drag in progress while a change to the same element arrives, brief disconnects during a drag, a DO stopped in the middle of a save, a DO restarted right after confirming a change, a Drive outage during a save round, a revoked Google access, a sharing change while someone is connected, an old app version writing the file, a scene copied in Drive (gets its own key).

## Review findings

Three review rounds, each by Claude Opus and Codex GPT-6 Astra reading the concept and Kurviq's code, plus two independent case studies, found 15 critical and about 60 important points; all are resolved in the sections above.

| Round | Finding | Found by | Resolution |
| --- | --- | --- | --- |
| 3 | A crash between two uploads of a round lost saved work | both | snapshot updated and batch rows deleted in one transaction per confirmed upload (Event model, Saving) |
| 3 | Receipts "last batch" could not express gaps | both | contiguous mark plus exceptions, per-scene tab ids; reconciliation when receipts are missing (Connecting) |
| 3 | A tab could seed the DO with a stale revision | both | the Worker puts Drive's current revision into the ticket; only a matching seed is accepted; first seed wins (Connecting) |
| 3 | Key creation could race | Codex | created by the Worker under a lease from the DO, read before write (Encryption) |
| 3 | "Keep only here" handover had a write race | Codex | the DO closes the scene first, then hands over the final state (Connecting) |
| 3 | No credential to merge outside changes while idle | both | one-time access token fetched through a connected tab; renewals also read revision, name and trash state (Saving, Security) |
| 3 | Token hand-over could fail after a batch was accepted | both | sealed token arrives with the ticket and is stored in the same transaction as the first batch (Tokens) |
| 3 | 7-day rule contradicted retention; discards could return | both | changes kept until accepted (rule kept as decided); discarded batches refused on resend (Saving, Security) |
| 3 | Short network drops turned collisions into offline copies | Opus | live or offline decided by a flag set when the change was made (Event model) |
| 3 | Outside changes entered the walk without an author | Opus | the merged outside revision becomes the saved base, never part of the walk (Saving) |
| 3 | Undo could overwrite another person's later change | Codex | undo only reverts properties still holding the user's value (Event model) |
| 3 | Agent's own edit reported as a user change until saved | both | DO seq used as agent baseline until Drive has the version (Saving) |
| 3 | Font hashes alone did not prevent numeric font id clashes | Codex | DO assigns numeric font ids without clashes and remaps elements (Event model) |
| 3 | Pins: user pins, un-pin uncertainty | both | Google's 200 counted in total; un-pin checked in step 1, otherwise no agent pins (History) |
| 3 | Google outage extension too broad; revocation bound stated as 10 minutes | both | only on timeouts and server errors, max 2 hours after the last check; bound is 15 minutes (Connections, Tokens) |
| 3 | Plan postponed recovery cases one account can already hit | Codex | step 1 covers them and the local install (Plan) |
| 3 | Pseudonyms computable by holders of two scene keys | Codex | derived with a server secret (Saving) |
| 3 | Stale statements (pins, index repair, freshness, "today's code already refuses") | both | corrected throughout |
| 2 | Confirmed changes could be lost before the 10-second write | both | every batch is written before it is confirmed (Event model, Costs) |
| 2 | Access checks needed every viewer's token in the DO | both | access proofs checked by the Worker; refresh tokens only for editors, stored with their first change (Tokens) |
| 2 | Key rotation could make unsaved changes unreadable | both | no rotation (decided) (Encryption) |
| 2 | Crash recovery could re-upload over a newer outside version | Codex | operation id in the content; revisions since the base searched; outside changes merged first (Saving) |
| 2 | Plaintext and encrypted fields not separated | Opus | readable fields listed; tabs strip and restore them (Encryption) |
| 2 | No stored base for rebuilds and merges | Opus | encrypted snapshot of the last save (Event model) |
| 2 | Outside merges and index repairs never reached the tabs; no winner rule | both | sent to all tabs; Kurviq's pending change wins (decided); indices repaired by the DO on accept (Saving, Event model) |
| 2 | Images and fonts missing from "touching" | Opus | `fileId` and `fontFamily` added (Saving) |
| 2 | Webhook unverified, own saves trigger notifications | both | channel token checked; sharing, content, trash and rename handled; own saves dropped (Security) |
| 2 | No behaviour before a key exists; old versions might send plaintext | Opus | edits wait in the browser; protocol version in the ticket (Encryption) |
| 2 | A gesture's base advanced could hide a collision | Codex | a gesture keeps its starting base and local draft (Event model) |
| 2 | Resending "non-colliding" offline changes could break references | Codex | only changes whose whole touching group is free of collisions (Event model) |
| 2 | Old replays after 30 days could resurrect deleted elements | Codex | batches older than 30 days go into a copy, never replayed (Event model) |
| 2 | Attribution in file-level app properties would overflow | Codex | per-element pseudonym and a list of the last 50 records in the file content (Saving) |
| 2 | Pin budget and today's un-pin call | both | one budget of 30 Kurviq pins; un-pin checked in step 1 (History) |
| 2 | Public cache could serve old or revoked scenes for 10 minutes | both | 60 seconds without stale serving (decided) (Security) |
| 2 | Row and request counts contradicted the design | both | recalculated (Costs) |
| 1 | Tabs keep their own higher-version element and silently disagree with the DO | both | DO re-stamps version and nonce; tabs apply its stream (Event model) |
| 1 | "Keep only here" deletes other people's unsaved work | both | only for a scene used by you alone, after closing it; otherwise "Keep a local copy" (Connecting) |
| 1 | Deleted elements come back after the DO forgot them | Opus | unknown element with a non-zero base counts as a collision (Event model) |
| 1 | One failing author blocks everyone; the 5-version cap saved others' work under one name | both | skipped authors don't block independent work; recorded acceptance; cap continues next round (Saving) |
| 1 | Access checked only at connect | both | access proofs renewed every 10 minutes plus sharing notifications (Tokens, Security) |
| 1 | Local install would reuse `/live` and put the session in a URL | both | own route and DO class, single-use tickets via POST, session expiry (Connecting) |
| 1 | No join protocol; Drive can be minutes behind | both | handshake with generations and receipts (Connecting) |
| 1 | No crash-safe save; one alarm per DO | Codex | save records; schedule table on the single alarm (Saving) |
| 1 | Outside changes merged without a base | both | three-way merge against the stored snapshot (Saving) |
| 1 | Scene settings, images, fonts, name missing from events | both | included, images uploaded in chunks first (Event model) |
| 1 | Partial offline apply left dangling references; a 10 s rule used clocks | both | live or offline by a flag set when the change was made; whole local scene becomes the new scene (Event model) |
| 1 | Agent marks for `read_scene` lost in grouping | Opus | agent changes form their own version (Saving) |
| 1 | "Deleted" rows restorable for 30 days | both | stated in `/privacy`; tokens bound to scene, account and expiry (Security, Tokens) |
| 1 | Identity by email; offline queue sent as the wrong account | both | `sub` in the session; queue keyed per account (Tokens, Event model) |
| 1 | Sign-out could block on a sync and missed other token copies | both | sign-out is immediate; sign out everywhere through a per-account DO (Connecting, Security) |
| 1 | Recovery promises exceeded the design | Codex | browser keeps changes until Drive has them; three save stages in the UI (Failure cases) |
| 1 | Old app versions keep writing Drive directly | both | `kurviqSync` marker and protocol version; their writes merged as outside changes (Connecting, Encryption) |
| 1 | Summary claimed signed-out users never reach the server | both | anonymous viewers reach the Worker's public endpoint, not the DO (Summary) |

Every case from the two case studies and the rule that now covers it: Case study
