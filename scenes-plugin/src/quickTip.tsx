import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, ReactNode } from "react";
import clsx from "clsx";

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
  const [at, setAt] = useState<{ x: number; y: number; above: boolean } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <span
      className={className}
      aria-label={label ? tip : undefined}
      role={label ? "img" : undefined}
      onMouseEnter={(event) => {
        // (around a positioned control, e.g. on the canvas, the wrapper has no size: the control's)
        const own = event.currentTarget.getBoundingClientRect();
        const rect = own.width ? own : (event.currentTarget.firstElementChild?.getBoundingClientRect() ?? own);
        const above = rect.bottom + 48 > window.innerHeight;
        timer.current = window.setTimeout(
          () => setAt({ x: rect.left + rect.width / 2, y: above ? rect.top - 8 : rect.bottom + 8, above }),
          120,
        );
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
            style={(() => {
              // kept on screen; the arrow still points at the icon
              const left = Math.min(Math.max(at.x, 140), window.innerWidth - 140);
              return { left, top: at.y, "--tip-arrow": `calc(50% + ${at.x - left}px)` } as CSSProperties;
            })()}
          >
            {tip}
          </div>,
          document.body,
        )}
    </span>
  );
};
