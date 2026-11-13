// One tooltip look everywhere in Kurviq's own UI: a `title` on any of our
// controls (panels, the presentation's controls, the text toolbar …) shows as
// the same dark tooltip as QuickTip (.kurviq-tip in scenes.scss), right away,
// instead of the browser's own grey one a second later. Excalidraw's own
// controls keep theirs.

/** our UI: class names with our prefixes (in this document: the presenter window keeps the browser's tooltips) */
const OURS = ["scenes-", "slides-", "kq-", "rt-", "public-scene"]
  .map((prefix) => `[class^="${prefix}"], [class*=" ${prefix}"]`)
  .join(", ");

let tip: HTMLDivElement | null = null;
let owner: HTMLElement | null = null;
let timer = 0;

const hide = () => {
  window.clearTimeout(timer);
  tip?.remove();
  tip = null;
  owner = null;
};

/** how long the pointer rests on a control before its tooltip shows (ms) */
export const TIP_DELAY = 120;

export type TipPlacement = { left: number; top: number; above: boolean; arrow: string };

/**
 * Where a tooltip for a control at `rect` goes: below it, or above when it
 * would leave the window at the bottom; kept 140 px from the window's sides,
 * with the arrow still pointing at the control's middle. Shared by the title
 * tooltips here and QuickTip.
 */
export const tipPlacement = (
  rect: { left: number; width: number; top: number; bottom: number },
  windowSize?: { width: number; height: number },
): TipPlacement => {
  const view = windowSize ?? { width: window.innerWidth, height: window.innerHeight };
  const above = rect.bottom + 48 > view.height;
  const x = rect.left + rect.width / 2;
  const left = Math.min(Math.max(x, 140), view.width - 140);
  return { left, top: above ? rect.top - 8 : rect.bottom + 8, above, arrow: `calc(50% + ${x - left}px)` };
};

const show = (el: HTMLElement) => {
  const text = el.dataset.kqTitle;
  if (!text || !el.isConnected) {
    return;
  }
  const at = tipPlacement(el.getBoundingClientRect());
  tip = document.createElement("div");
  tip.className = `kurviq-tip${at.above ? " kurviq-tip--above" : ""}`;
  tip.setAttribute("role", "tooltip");
  tip.textContent = text;
  tip.style.left = `${at.left}px`;
  tip.style.top = `${at.top}px`;
  tip.style.setProperty("--tip-arrow", at.arrow);
  document.body.appendChild(tip);
};

let installed = false;

export const installTitleTips = () => {
  if (installed) {
    return;
  }
  installed = true;
  document.addEventListener(
    "pointerover",
    (event) => {
      const el = (event.target as HTMLElement | null)?.closest?.<HTMLElement>("[title], [data-kq-title]");
      if (!el || el === owner || !el.closest(OURS)) {
        return;
      }
      // take the title over (else the browser shows its own too); React may set it again
      if (el.hasAttribute("title")) {
        el.dataset.kqTitle = el.getAttribute("title") ?? "";
        el.removeAttribute("title");
        if (!el.textContent?.trim() && !el.hasAttribute("aria-label")) {
          el.setAttribute("aria-label", el.dataset.kqTitle);
        }
      }
      hide();
      owner = el;
      timer = window.setTimeout(() => show(el), TIP_DELAY);
    },
    true,
  );
  document.addEventListener(
    "pointerout",
    (event) => {
      if (owner && !owner.contains(event.relatedTarget as Node | null)) {
        hide();
      }
    },
    true,
  );
  document.addEventListener("pointerdown", hide, true);
  window.addEventListener("blur", hide);
};
