// Copying text to the clipboard, one way for every copy button: copyText
// never throws (no clipboard on the page, or the browser refused: false), and
// useCopy gives a button its "Copied" moment.

import { useCallback, useEffect, useRef, useState } from "react";

/** the text into the clipboard: true when it worked */
export const copyText = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

export type CopyState = "idle" | "copied" | "failed";

/** how long a button shows "Copied" (or that it failed) */
export const COPIED_MS = 1500;

/** a copy button's state ("copied" / "failed" for a moment after a copy) and its copy; copy answers whether it worked */
export const useCopy = (ms = COPIED_MS) => {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback(
    async (text: string) => {
      const ok = await copyText(text);
      setState(ok ? "copied" : "failed");
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setState("idle"), ms);
      return ok;
    },
    [ms],
  );
  return [state, copy] as const;
};
