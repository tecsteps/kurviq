<!-- Exported from the Claude Doc https://claude.ai/artifact/Px93qyvQSvVFpK93MNYw5K on 2026-10-31. The doc is the working copy; this file is the snapshot the implementation follows. -->

# Case study

Two independent case studies walked every situation through the concept: Claude Opus 144 cases (53 handled, 51 ambiguous, 35 gaps, 5 wrong) and Codex GPT-6 Astra 121 cases (36 handled, 32 ambiguous, 39 gaps, 13 wrong). Every gap, wrong or ambiguous case is resolved by one of the rules below; handled cases needed no change.

Case ids: O = Opus, C = Codex.

| Cases | Situation | Rule now in the concept | Section |
| --- | --- | --- | --- |
| O C4, C C07 | An answer from the server overwrote edits made after the batch was sent | Tabs keep confirmed state and their own pending changes as two layers; an answer removes only its own pending change | Event model |
| O C3 | Two quick batches for the same element collided with each other | A batch may name the tab's own pending batch as its base | Event model |
| O C2, C C02 | Two live editors were treated as "offline" | Live means: made on this connection after the tab was up to date; queued changes are offline | Event model |
| O C6 | "Later wins" on the whole element reverted another person's different property | Per-property rebase in the tab (decided); only the same property: later wins | Event model |
| C C04, C09 | Bound arrows, labels, text edits split across batches | One action is one batch, accepted or refused whole | Event model |
| C C19, C20 | Undo and redo could overwrite others | Undo and redo are normal changes over the same checks; remote changes never enter the undo history | Event model |
| C C21 | Applied remote changes could be sent back as edits | Changes from the DO are never sent back | Event model |
| O C9, C10 | Elements referring to deleted frames, shapes or containers were accepted | The DO checks references and refuses with a reason | Event model |
| O C20 | Every tab repaired clashing indices and sent the repair | Only the DO repairs indices | Event model |
| O X11, RC10 | Refused batches left screens disagreeing | Every refusal has a reason and the tab always resolves it | Event model |
| O C15, C17, C C14 | Same image twice collided; fonts with the same name overwrote each other | Images and fonts identified by a hash of their bytes | Event model |
| C N10, T01, T07, O M2 | Browser durability and queues per space | IndexedDB keyed by account, file and tab; "in this browser" only after the write; "not saved" plus export on failure; any tab of the account sends | Event model |
| O J1 | An empty DO had no token or key to load Drive | The first editor's tab seeds the DO with an encrypted snapshot | Connecting |
| C J08, J09, J10, O J12 | Joining after hibernation or with a stale scene open | One coherent starting point with generation id; answers checked against the open scene | Connecting |
| O RC6, C Q06 | After data loss, confirmed changes became offline copies or were replayed twice | Drive files carry, per tab, the last batch they contain; tabs resend only the rest | Connecting |
| O D3, D4, D7, RC9, C D03, D06, D07, D08, Q09 | Trash, restore, permanent delete, local only: saving went on into the trash or a scene came back | Lifecycle record with epoch: trashed, restored, tombstone | Connecting |
| C M02 | A retried "Put in Drive" could create two files | The creation is recorded first and reused | Connecting |
| O R2, R4, R5, C R02, R04 | Renames in Drive, same names, missing file ending | Identity is the file id; renames from Drive arrive by watch or renewal; duplicates show the owner; scenes recognised by app property | Connecting |
| O A5, A2, J16, C T03, A10 | Account switch, expired sign-in, "Open with" from another account | Everything keyed by `sub`; old account's connections closed first; expired sign-in keeps the queue; account choice asked | Connecting |
| O N5, M8, N7 | Dead connections, ghost presence, Google outage | 10 s answer timeout; presence with last activity; access proofs extended up to 2 hours while Google is down | Connecting |
| C H03, H04, S03, N08 | Save membership and slow uploads | One upload at a time with an exact batch list; rows deleted only after confirmation | Saving |
| O C26, J4, C27, C P01, P02, H08 | Outside changes invisible while idle; images and fonts dropped; stamp-only comparison | Content notifications start a merge; full-content comparison including images, fonts, order and settings; limits of history stated | Saving |
| C P03 | Outside changes attributed to a Google account without proof | Marked "outside Kurviq" with Drive's last modifier | Saving |
| O X17, N12, C H06, H07 | Changes of an author who cannot be saved as; dependents | Rule kept (decided); accept or discard also resolves dependent work; token hand-over retried until it succeeds | Saving |
| O A9 | A removed editor's changes are auto-accepted after 7 days | Kept as decided, always recorded on behalf of the author | Saving |
| O C29 | Backlog with many alternations | The next round starts at once | Saving |
| O N10 | Owner's Drive full reported as an author problem | Reported as "Drive full" | Saving |
| O C22, C C17, C18 | Agents on a stale baseline or applied twice | Agents work on the tab's live state; commands carry an id | Saving |
| O A14 | Google account ids readable in public files | Per-scene pseudonyms (decided) | Saving |
| O X9, C S07, S08 | A replaced key would make stored data unreadable | Key creation recorded with its fingerprint; never a new key for an existing scene | Encryption |
| O X15, C H09 | Pins cost the owner's storage; restore semantics | One milestone per day, at most 30 pins (decided); restore is a new change | History |
| C A03, A06, A08 | Revocation relied on D1 | Revocation mark in a per-account DO; every message checks proof expiry | Security |
| C S09, S11, O J14, X12, C24 | Invalid changes and limits | Validation before storing and while saving; limits refuse before accepting; chunking below row and message limits | Security |
| C P04 | Promised one-minute freshness for public viewers | 1 to 2 minutes under light load; viewer shows the last save time | Security |
| C M09 | "Local-only scenes never reach our server" was not true for hosted MCP | Wording corrected: never stored; agents through hosted MCP pass content in transit | Summary |
| C M05, S13, C22 | Copies and assets incomplete | "Keep a local copy" complete only with all images and fonts | Connecting |
| C S06 | Rollout compatibility | Step 1 covers all tabs and devices of one account; others view-only; protocol version; no direct Drive writes for marked files | Plan |
| C P06 | Costs from one workload only | Several workloads measured before launch | Costs |
| O J8, A4, X16 | Unknown platform behaviour | Listed as checks in step 1 | Plan |
| O X21, X22 | Wording: two kinds of "ticket"; stale test item | Connect ticket and access proof named apart; test list updated | Tokens, Plan |
