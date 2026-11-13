# Comment polish

Status: implemented (Should), 2026-11-13: Shift+C (`comments/shortcut.ts`), filters with counts,
"hide resolved after 7 days", unread dots and the scene list's counts (`comments/listRules.ts`,
`comments/sceneCounts.ts`, per browser in localStorage: `comments/local.ts`); "waiting for an editor" ends
when a load of the file has the comment (`comments/store.ts`); one copy helper (`src/useCopy.ts`). Tests:
`scenes-plugin/test/commentList.test.ts`, e2e `scenes-plugin/test/e2e/comments-polish.mjs`.

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

## Decisions (implementation)

- **Shift+C**: free in Excalidraw (its tools are plain letters and Shift+X; Alt+Shift+C copies as PNG,
  Ctrl+Alt+C copies styles). Handled in the capture phase so it works over the shared viewer too; never
  while focus is in a text field, text area, select or contenteditable (Excalidraw's text editor, the rich
  text editor, a comment box). Esc closes the topmost of: placing, a new comment, the open thread, the list.
- **Filters** are one choice (Open is the default); the pins on the canvas follow it (the open thread always
  shows). "Mine" = threads you started or wrote in; "@Me" = a comment mentions your full name as the
  suggestions write it, your first name or your address's local part. The old "Show resolved" switch is
  the "Resolved" filter now.
- **Unread**: a thread is unread when someone else wrote in it after it was last opened in this browser; a
  thread never opened counts from when this browser started keeping track (so old threads don't all light
  up). At most 3000 threads are remembered.
- **Scene list counts**: the open scene's live; the others' from the browser's stored copy, counted again
  only when that copy changed (length, baseline, dirty), cached in localStorage.
- **Waiting for an editor**: the mark ends when a load of the file (or the live session) has the comment
  in that version or a newer one.
- **U21**: `scenes-plugin/src/useCopy.ts` (`copyText`, `useCopy`); the comments use it. `online/ui.tsx`
  (`CopyLink`, `CopyButton`) still to switch to it.
