// The formatting toolbar above the text being edited.

// (from common, not the package index: this file is part of Excalidraw's own editor)
import { FONT_FAMILY } from "@excalidraw/common";

import type { RichEditorApi } from "./editor";
import { safeLink } from "./model";

import type { ParaKind } from "./model";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl+";
const SHIFT = isMac ? "⇧" : "Shift+";

const icon = (paths: string) =>
  `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const p = (...d: string[]) => d.map((path) => `<path d="${path}"/>`).join("");

const ICONS = {
  b: icon(p("M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8")),
  i: icon(p("M19 4h-9", "M14 20H5", "M15 4 9 20")),
  u: icon(p("M6 4v6a6 6 0 0 0 12 0V4", "M4 20h16")),
  s: icon(p("M16 4H9a3 3 0 0 0-2.83 4", "M14 12a4 4 0 0 1 0 8H6", "M4 12h16")),
  todo: icon(p("m3 17 2 2 4-4", "m3 7 2 2 4-4", "M13 6h8", "M13 12h8", "M13 18h8")),
  ol: icon(p("M10 12h11", "M10 18h11", "M10 6h11", "M4 10h2", "M4 6h1v4", "M6 18H4c0-1 2-2 2-3s-1-1.5-2-1")),
  ul: icon(p("M3 12h.01", "M3 18h.01", "M3 6h.01", "M8 12h13", "M8 18h13", "M8 6h13")),
  link: icon(p("M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71", "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71")),
  color: icon(p("m6 16 6-12 6 12", "M8 12h8")),
  highlight: icon(p("m9 11-6 6v3h9l3-3", "m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4")),
  lineHeight: icon(p("M11 6h10", "M11 12h10", "M11 18h10", "m3 8 3-3 3 3", "m3 16 3 3 3-3", "M6 5v14")),
  clear: icon(p("M4 7V4h16v3", "M5 20h6", "M13 4 8 20", "m15 15 5 5", "m20 15-5 5")),
  chevron: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`,
};

const TEXT_COLORS = ["#1e1e1e", "#e03131", "#2f9e44", "#1971c2", "#f08c00", "#9c36b5", "#0c8599", "#868e96", "#ffffff"];
const HIGHLIGHTS = ["#ffec99", "#ffc9c9", "#b2f2bb", "#a5d8ff", "#d0bfff", "#ffd8a8", "#e9ecef"];
const LINE_HEIGHTS: Array<[string, number]> = [["Single", 1], ["1.15", 1.15], ["1.25 (default)", 1.25], ["1.5", 1.5], ["Double", 2]];
const SIZES = [10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 96];

/** Excalidraw's fonts as its font picker lists them, then the fonts added in Kurviq (registered in FONT_FAMILY, see ../fonts.ts) */
const BUILT_IN_FONTS = ["Excalifont", "Nunito", "Lilita One", "Comic Shanns", "Virgil", "Helvetica", "Cascadia"];
const KNOWN = new Set([...BUILT_IN_FONTS, "Liberation Sans", "Assistant"]);
const fontList = (): Array<[string, number]> => {
  const table = FONT_FAMILY as Record<string, number>;
  const added = Object.keys(table)
    .filter((name) => !KNOWN.has(name) && table[name] > 100)
    .sort((a, b) => a.localeCompare(b));
  return [...BUILT_IN_FONTS, ...added].filter((name) => table[name] !== undefined).map((name): [string, number] => [name, table[name]]);
};
const fontName = (id: number) =>
  fontList().find(([, value]) => value === id)?.[0] ??
  Object.entries(FONT_FAMILY as Record<string, number>).find(([, value]) => value === id)?.[0] ??
  "Font";

export const createToolbar = (
  api: RichEditorApi,
  app: any,
  elementId: string,
  getViewportCoords: (x: number, y: number) => [number, number],
) => {
  const ownerDocument = api.root.ownerDocument;
  let bar: HTMLDivElement | null = null;
  let popover: HTMLDivElement | null = null;
  let frame = 0;
  let lastHighlight = HIGHLIGHTS[0];
  const buttons = new Map<string, HTMLButtonElement>();

  const keepFocus = (el: HTMLElement) => {
    // the editor keeps the focus (and its selection) while you click here
    el.addEventListener("mousedown", (event) => {
      if (!(event.target as HTMLElement).closest("input")) {
        event.preventDefault();
      }
    });
    el.addEventListener("pointerdown", (event) => event.stopPropagation());
  };

  const button = (key: string, title: string, html: string, onClick: (button: HTMLButtonElement) => void) => {
    const el = ownerDocument.createElement("button");
    el.type = "button";
    el.className = "rt-toolbar__button";
    el.title = title;
    el.setAttribute("aria-label", title);
    el.innerHTML = html;
    el.addEventListener("click", () => onClick(el));
    buttons.set(key, el);
    return el;
  };

  const closePopover = () => {
    const hadFocus = !!popover?.contains(ownerDocument.activeElement);
    popover?.remove();
    if (hadFocus) {
      api.restoreFocus();
    }
    popover = null;
    bar?.querySelectorAll(".rt-toolbar__button--open").forEach((el) => el.classList.remove("rt-toolbar__button--open"));
  };

  const openPopover = (anchor: HTMLElement, build: (el: HTMLDivElement) => void, focusable = false) => {
    const wasOpen = anchor.classList.contains("rt-toolbar__button--open");
    closePopover();
    if (wasOpen || !bar) {
      return;
    }
    anchor.classList.add("rt-toolbar__button--open");
    popover = ownerDocument.createElement("div");
    // `properties-content`: Excalidraw's editor doesn't submit when this
    // takes the focus (a field to type in)
    popover.className = `rt-toolbar__popover${focusable ? " properties-content" : ""}`;
    keepFocus(popover);
    build(popover);
    bar.appendChild(popover);
    const barRect = bar.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    popover.style.left = `${Math.max(0, Math.min(anchorRect.left - barRect.left, barRect.width - popover.offsetWidth))}px`;
  };

  const swatches = (colors: string[], current: string | undefined, onPick: (color: string | undefined) => void, noneLabel: string) => (el: HTMLDivElement) => {
    const grid = ownerDocument.createElement("div");
    grid.className = "rt-toolbar__swatches";
    const none = ownerDocument.createElement("button");
    none.type = "button";
    none.className = `rt-toolbar__swatch rt-toolbar__swatch--none${current ? "" : " rt-toolbar__swatch--active"}`;
    none.title = noneLabel;
    none.addEventListener("click", () => {
      onPick(undefined);
      closePopover();
    });
    grid.appendChild(none);
    for (const color of colors) {
      const swatch = ownerDocument.createElement("button");
      swatch.type = "button";
      swatch.className = `rt-toolbar__swatch${current?.toLowerCase() === color ? " rt-toolbar__swatch--active" : ""}`;
      swatch.style.setProperty("--swatch", color);
      swatch.title = color;
      swatch.addEventListener("click", () => {
        onPick(color);
        closePopover();
      });
      grid.appendChild(swatch);
    }
    el.appendChild(grid);
  };

  const openLink = () => {
    const anchor = buttons.get("link");
    if (!anchor) {
      return;
    }
    api.saveSelection();
    const { marks, collapsed } = api.state();
    openPopover(
      anchor,
      (el) => {
        const form = ownerDocument.createElement("form");
        form.className = "rt-toolbar__link";
        // "example.com" is fine too (it becomes https://example.com)
        form.noValidate = true;
        const input = ownerDocument.createElement("input");
        input.type = "url";
        input.placeholder = collapsed && !marks.a ? "Paste a link to insert" : "Paste a link";
        input.value = marks.a || "";
        input.spellcheck = false;
        const apply = ownerDocument.createElement("button");
        apply.type = "submit";
        apply.textContent = "Apply";
        form.append(input, apply);
        if (marks.a) {
          const remove = ownerDocument.createElement("button");
          remove.type = "button";
          remove.textContent = "Remove";
          remove.addEventListener("click", () => {
            closePopover();
            api.restoreFocus();
            api.setLink(undefined);
          });
          form.append(remove);
        }
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          let url = input.value.trim();
          if (url && !/^[a-z][a-z0-9+.-]*:/i.test(url)) {
            url = /^[^\s@]+@[^\s@]+$/.test(url) ? `mailto:${url}` : `https://${url}`;
          }
          closePopover();
          api.restoreFocus();
          // only web and mail links (javascript: and the like are dropped)
          api.setLink(safeLink(url) ?? undefined);
        });
        input.addEventListener("keydown", (event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            closePopover();
            api.restoreFocus();
          }
        });
        el.appendChild(form);
        api.suspendBlur();
        setTimeout(() => input.focus(), 0);
      },
      true,
    );
  };

  const toggleHighlight = () => {
    api.setMark("h", api.state().marks.h ? undefined : lastHighlight);
  };

  const build = () => {
    const el = ownerDocument.createElement("div");
    el.className = "rt-toolbar";
    el.setAttribute("role", "toolbar");
    el.setAttribute("aria-label", "Text formatting");
    keepFocus(el);

    const size = button("size", `Text size (${MOD}${SHIFT}. / ${MOD}${SHIFT},)`, "", (anchor) =>
      openPopover(anchor, (pop) => {
        const { size: current, base } = api.state();
        const list = ownerDocument.createElement("div");
        list.className = "rt-toolbar__sizes";
        const sizes = [...new Set([...SIZES, Math.round(base)])].sort((a, b) => a - b);
        for (const value of sizes) {
          const item = ownerDocument.createElement("button");
          item.type = "button";
          item.className = `rt-toolbar__size${value === current ? " rt-toolbar__size--active" : ""}`;
          item.textContent = value === Math.round(base) ? `${value} (text)` : String(value);
          item.addEventListener("click", () => {
            api.setMark("z", value / base);
            closePopover();
          });
          list.appendChild(item);
        }
        pop.appendChild(list);
      }),
    );
    size.classList.add("rt-toolbar__button--size");

    // the font (of the whole text): its name, a list to pick another
    const fontControl = api.font;
    const font = fontControl
      ? button("font", "Font (the whole text)", "", (anchor) =>
          openPopover(anchor, (pop) => {
            const current = fontControl.get();
            const list = ownerDocument.createElement("div");
            list.className = "rt-toolbar__sizes rt-toolbar__fonts";
            for (const [name, id] of fontList()) {
              const item = ownerDocument.createElement("button");
              item.type = "button";
              item.className = `rt-toolbar__size${id === current ? " rt-toolbar__size--active" : ""}`;
              item.textContent = name;
              item.style.fontFamily = `"${name}", sans-serif`;
              item.addEventListener("click", () => {
                fontControl.set(id);
                closePopover();
                update();
              });
              list.appendChild(item);
            }
            pop.appendChild(list);
          }),
        )
      : null;
    font?.classList.add("rt-toolbar__button--size", "rt-toolbar__button--font");

    const sep = () => {
      const s = ownerDocument.createElement("span");
      s.className = "rt-toolbar__sep";
      return s;
    };

    el.append(
      ...(font ? [font] : []),
      size,
      sep(),
      button("b", `Bold (${MOD}B)`, ICONS.b, () => api.toggleMark("b")),
      button("i", `Italic (${MOD}I)`, ICONS.i, () => api.toggleMark("i")),
      button("u", `Underline (${MOD}U)`, ICONS.u, () => api.toggleMark("u")),
      button("s", `Strikethrough (${MOD}${SHIFT}X)`, ICONS.s, () => api.toggleMark("s")),
      sep(),
      button("todo", `Checklist (${MOD}${SHIFT}9)`, ICONS.todo, () => api.toggleList("todo")),
      button("ol", `Numbered list (${MOD}${SHIFT}7)`, ICONS.ol, () => api.toggleList("ol")),
      button("ul", `Bulleted list (${MOD}${SHIFT}8)`, ICONS.ul, () => api.toggleList("ul")),
      button("lineHeight", "Line spacing", ICONS.lineHeight, (anchor) =>
        openPopover(anchor, (pop) => {
          const current = api.state().lineHeight;
          const list = ownerDocument.createElement("div");
          list.className = "rt-toolbar__sizes";
          for (const [label, value] of LINE_HEIGHTS) {
            const item = ownerDocument.createElement("button");
            item.type = "button";
            item.className = `rt-toolbar__size${Math.abs(value - current) < 0.001 ? " rt-toolbar__size--active" : ""}`;
            item.textContent = label;
            item.addEventListener("click", () => {
              api.setLineHeight(value);
              closePopover();
            });
            list.appendChild(item);
          }
          pop.appendChild(list);
        }),
      ),
      sep(),
      button("link", `Link (${MOD}K)`, ICONS.link, openLink),
      button("color", "Text color", `${ICONS.color}<span class="rt-toolbar__bar"></span>`, (anchor) =>
        openPopover(anchor, swatches(TEXT_COLORS, api.state().marks.c, (color) => api.setMark("c", color), "Default color")),
      ),
      button("highlight", `Highlight (${MOD}${SHIFT}H)`, `${ICONS.highlight}<span class="rt-toolbar__bar"></span>`, (anchor) =>
        openPopover(
          anchor,
          swatches(HIGHLIGHTS, api.state().marks.h, (color) => {
            if (color) {
              lastHighlight = color;
            }
            api.setMark("h", color);
          }, "No highlight"),
        ),
      ),
      button("clear", `Clear formatting (${MOD}\\)`, ICONS.clear, () => api.clearFormatting()),
    );
    return el;
  };

  const position = () => {
    if (!bar) {
      return;
    }
    const container = bar.offsetParent as HTMLElement | null;
    const containerRect = (container ?? ownerDocument.body).getBoundingClientRect();
    const element = app.scene.getElement(elementId);
    const box = (element?.containerId && app.scene.getElement(element.containerId)) || element;
    let top: number;
    let bottom: number;
    let center: number;
    if (box) {
      const [x1, y1] = getViewportCoords(box.x, box.y);
      const [x2, y2] = getViewportCoords(box.x + box.width, box.y + box.height);
      const offsetLeft = app.state.offsetLeft || 0;
      const offsetTop = app.state.offsetTop || 0;
      top = Math.min(y1, y2) + offsetTop;
      bottom = Math.max(y1, y2) + offsetTop;
      center = (x1 + x2) / 2 + offsetLeft;
    } else {
      const rect = api.root.getBoundingClientRect();
      top = rect.top;
      bottom = rect.bottom;
      center = rect.left + rect.width / 2;
    }
    const width = bar.offsetWidth;
    const height = bar.offsetHeight;
    const left = Math.max(8, Math.min(center - width / 2 - containerRect.left, containerRect.width - width - 8));
    let y = top - containerRect.top - height - 12;
    if (y < 8) {
      y = Math.min(bottom - containerRect.top + 12, containerRect.height - height - 8);
    }
    bar.style.transform = `translate(${Math.round(left)}px, ${Math.round(y)}px)`;
  };

  const loop = () => {
    if (!api.root.isConnected) {
      destroy();
      return;
    }
    position();
    frame = requestAnimationFrame(loop);
  };

  const update = () => {
    if (!bar) {
      return;
    }
    const { marks, kinds, size: px } = api.state();
    for (const key of ["b", "i", "u", "s"] as const) {
      buttons.get(key)?.classList.toggle("rt-toolbar__button--active", !!marks[key]);
    }
    for (const kind of ["todo", "ol", "ul"] as ParaKind[]) {
      buttons.get(kind)?.classList.toggle("rt-toolbar__button--active", kinds.size === 1 && kinds.has(kind));
    }
    buttons.get("link")?.classList.toggle("rt-toolbar__button--active", !!marks.a);
    buttons.get("color")?.style.setProperty("--rt-bar", marks.c || "currentColor");
    buttons.get("highlight")?.style.setProperty("--rt-bar", marks.h || "transparent");
    const size = buttons.get("size");
    if (size) {
      size.innerHTML = `<span>${px ?? "–"}</span>${ICONS.chevron}`;
    }
    const font = buttons.get("font");
    if (font && api.font) {
      font.innerHTML = `<span>${fontName(api.font.get())}</span>${ICONS.chevron}`;
    }
  };

  const mount = () => {
    if (bar) {
      return;
    }
    const container = (api.root.closest(".excalidraw") as HTMLElement | null) ?? ownerDocument.body;
    bar = build();
    container.appendChild(bar);
    update();
    loop();
  };

  const destroy = () => {
    cancelAnimationFrame(frame);
    closePopover();
    bar?.remove();
    bar = null;
  };

  return { mount, update, destroy, openLink, toggleHighlight };
};
