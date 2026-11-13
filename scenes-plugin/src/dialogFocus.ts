// Focus handling for Kurviq's own modal dialogs: focus goes into the dialog
// when it opens, Tab and Shift+Tab stay inside it, Escape closes it, and focus
// returns to where it was when it closes.

import { useEffect, type RefObject } from "react";

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

/** keyboard handling of a modal dialog (see the file's comment) */
export const useDialogFocus = (dialog: RefObject<HTMLElement | null>, onClose: () => void) => {
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const root = dialog.current;
    // only what can take focus (not hidden inputs, nothing in a closed part)
    const items = () => (root ? [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hidden && el.getClientRects().length > 0) : []);
    (root?.querySelector<HTMLElement>("[data-autofocus]") ?? items()[0])?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        event.preventDefault();
        onClose();
      } else if (event.key === "Tab") {
        const next = nextFocus(items(), document.activeElement, event.shiftKey);
        if (next) {
          event.preventDefault();
          next.focus();
        }
      }
    };
    // on the window, before the editor's own shortcuts see the key
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
      if (before?.isConnected) {
        before.focus();
      }
    };
  }, [dialog, onClose]);
};
