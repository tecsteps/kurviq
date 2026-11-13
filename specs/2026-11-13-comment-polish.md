# Comment polish

Status: proposal (Should), 2026-11-13

## Why

Small things that decide whether comments are used every day. Comments are live
since 2026-11-13 (`scenes-plugin/src/comments`).

## How

- **Shortcut** for "New comment" (a key Excalidraw doesn't use; check its
  keymap first), Esc closes.
- **Filters** in the list: open / resolved / mine / mentioning me.
- **Unread:** a dot on threads with replies since you last opened them; per
  browser (`localStorage`: thread id → last seen), nothing on a server.
- **Scene list:** the number of open threads per scene, for scenes this browser
  has open or stored (reading other files just for that is too costly).
- **Resolved threads:** faded pins already; "hide resolved after 7 days" as a
  list option.
- **Commenters after the Drive spec:** their comments wait for an editor
  (relay or Drive's comments as a mailbox, see
  `2026-11-13-drive-collaboration-without-server-data.md`); the thread shows
  "waiting for an editor" until the file has it.
- From the code review: S38 (removing a thread closes the popover before a
  failed save can be shown) and S39 (mentions in the shared viewer come from the
  editor's scene) in `2026-11-13-code-review-browser-slides-richtext-comments.md`,
  U21 (copy to clipboard three ways) in
  `2026-11-13-code-review-browser-drive-client-online-ui.md` fit here.

## Checks

- Unit: filters and the unread rule.
- Browser: the shortcut opens placing, Esc cancels; unread dots clear on open.

## Acceptance criteria

1. The shortcut starts placing a new comment; Esc cancels placing and closes popovers; the shortcut does nothing
   while typing in a text or comment field.
2. The list's filters (open / resolved / mine / mentioning me) show exactly those threads; counts match.
3. A thread with replies since it was last opened in this browser shows an unread dot; opening it clears the dot;
   another browser keeps its own state.
4. The scene list shows the number of open threads for scenes this browser has.
5. "Hide resolved after 7 days" hides those pins and list entries; turning it off shows them.
6. A commenter's comment that waits for an editor shows "waiting for an editor" until the file has it.
7. S38: a failed thread delete keeps the popover open with the error; S39: mentions in the shared viewer offer the
   thread's people, not the editor's scene's; U21: one copy-to-clipboard helper (code review).
