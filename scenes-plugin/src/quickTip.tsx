import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, ReactNode } from "react";
import clsx from "clsx";
import { TIP_DELAY, tipPlacement } from "./titleTips";
import type { TipPlacement } from "./titleTips";

/**
 * A tooltip that shows right away (the browser's own, from `title`, waits
 * about a second and can't be styled); on the page, so lists that scroll
 * don't cut it off
 */
export const QuickTip = ({
  tip,
  className,
  label = true,
  children,
}: {
  tip: string;
  className?: string;
  /** false: around a control that has its own name (a button), not an icon */
  label?: boolean;
  children: ReactNode;
}) => {
  const [at, setAt] = useState<TipPlacement | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <span // NOSONAR S6819: wrapper contains arbitrary icon children and mouse handlers, so it cannot be an img
      className={className}
      aria-label={label ? tip : undefined}
      role={label ? "img" : undefined}
      onMouseEnter={(event) => {
        // (around a positioned control, e.g. on the canvas, the wrapper has no size: the control's)
        const own = event.currentTarget.getBoundingClientRect();
        const rect = own.width ? own : (event.currentTarget.firstElementChild?.getBoundingClientRect() ?? own);
        timer.current = window.setTimeout(() => setAt(tipPlacement(rect)), TIP_DELAY);
      }}
      onMouseLeave={() => {
        window.clearTimeout(timer.current);
        setAt(null);
      }}
    >
      {children}
      {at &&
        createPortal(
          <div
            className={clsx("kurviq-tip", { "kurviq-tip--above": at.above })}
            role="tooltip"
            style={{ left: at.left, top: at.top, "--tip-arrow": at.arrow } as CSSProperties}
          >
            {tip}
          </div>,
          document.body,
        )}
    </span>
  );
};
