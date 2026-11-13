// Focus handling for Kurviq's own modal dialogs: focus goes into the dialog
// when it opens, Tab and Shift+Tab stay inside it, Escape closes it, keys
// typed in it never reach the editor's shortcuts, and focus returns to where
// it was when it closes. A dialog opened over another one (e.g. the short
// link over the share dialog) has the keys while it is open.

import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** the element Tab should move to from `active` (null: let the browser move, it stays inside) */
export const nextFocus = (items: HTMLElement[], active: Element | null, backwards: boolean): HTMLElement | null => {
  if (items.length === 0) {
    return null;
  }
  const first = items[0];
  const last = items.at(-1) as HTMLElement;
  const inside = active !== null && items.includes(active as HTMLElement);
  if (backwards && (active === first || !inside)) {
    return last;
  }
  if (!backwards && (active === last || !inside)) {
    return first;
  }
  return null;
};

/** the open dialogs, the topmost last */
const openDialogs: (HTMLElement | null)[] = [];

/** keyboard handling of a modal dialog (see the file's comment) */
export const useDialogFocus = (dialog: RefObject<HTMLElement | null>, onClose: () => void) => {
  // the latest onClose (callers may pass a new function on every render)
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const root = dialog.current;
    openDialogs.push(root);
    // only what can take focus (not hidden inputs, nothing in a closed part)
    const items = () => (root ? [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hidden && el.getClientRects().length > 0) : []);
    (root?.querySelector<HTMLElement>("[data-autofocus]") ?? items()[0])?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (openDialogs.at(-1) !== root) {
        return; // a dialog over this one has the keys
      }
      if (event.key === "Escape") {
        event.stopPropagation();
        event.preventDefault();
        close.current();
      } else if (event.key === "Tab") {
        const next = nextFocus(items(), document.activeElement, event.shiftKey);
        if (next) {
          event.preventDefault();
          next.focus();
        }
      }
    };
    // the editor's shortcuts listen on the document (Backspace would delete the selection behind the
    // dialog): keys typed in the dialog stop at the body, after the dialog's own handlers saw them
    const keep = (event: KeyboardEvent) => {
      if (root?.contains(event.target as Node)) {
        event.stopPropagation();
      }
    };
    // on the window, before the editor's own shortcuts see the key
    window.addEventListener("keydown", onKey, { capture: true });
    document.body.addEventListener("keydown", keep);
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
      document.body.removeEventListener("keydown", keep);
      openDialogs.splice(openDialogs.lastIndexOf(root), 1);
      if (before?.isConnected) {
        before.focus();
      }
    };
  }, [dialog]);
};
