// The comments' keys (./ui.tsx): Shift+C starts placing a new comment
// (Excalidraw uses no Shift+C: its tools are plain letters, Shift+X; Alt+Shift+C
// copies as PNG, Ctrl+Alt+C copies styles), never while typing somewhere.

/** shown in the tooltips */
export const NEW_COMMENT_KEY = "Shift+C";

type Key = { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean; repeat?: boolean; isComposing?: boolean };

/** Shift+C (CapsLock or not), no other modifier */
export const isNewCommentKey = (event: Key) =>
  event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !event.repeat && !event.isComposing && event.key.toLowerCase() === "c";

/** inputs that take no text: keys there are still shortcuts */
const NOT_TEXT = new Set(["button", "checkbox", "color", "file", "image", "radio", "range", "reset", "submit"]);

type Target = { tagName?: string; type?: string; isContentEditable?: boolean } | null;

/** the key goes into a text: a text field, a text area (Excalidraw's text editor, a comment box), a select or rich text (contenteditable) */
export const typingIn = (target: Target) => {
  if (!target) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tag = target.tagName?.toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") {
    return true;
  }
  return tag === "INPUT" && !NOT_TEXT.has((target.type ?? "text").toLowerCase());
};
