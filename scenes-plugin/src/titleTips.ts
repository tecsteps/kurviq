// One tooltip look everywhere in Kurviq's own UI: a `title` on any of our
// controls (panels, the presenter's controls, the text toolbar …) shows as
// the same dark tooltip as QuickTip (.kurviq-tip in scenes.scss), right away,
// instead of the browser's own grey one a second later. Excalidraw's own
// controls keep theirs.

/** our UI: class names with our prefixes */
const OURS = ["scenes-", "slides-", "kq-", "rt-", "public-scene", "pv"]
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

const show = (el: HTMLElement) => {
  const text = el.dataset.kqTitle;
  if (!text || !el.isConnected) {
    return;
  }
  const rect = el.getBoundingClientRect();
  const above = rect.bottom + 48 > window.innerHeight;
  const x = rect.left + rect.width / 2;
  // kept on screen; the arrow still points at the control
  const left = Math.min(Math.max(x, 140), window.innerWidth - 140);
  tip = el.ownerDocument.createElement("div");
  tip.className = `kurviq-tip${above ? " kurviq-tip--above" : ""}`;
  tip.setAttribute("role", "tooltip");
  tip.textContent = text;
  tip.style.left = `${left}px`;
  tip.style.top = `${above ? rect.top - 8 : rect.bottom + 8}px`;
  tip.style.setProperty("--tip-arrow", `calc(50% + ${x - left}px)`);
  el.ownerDocument.body.appendChild(tip);
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
      timer = window.setTimeout(() => show(el), 120);
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
