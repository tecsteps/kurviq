// Fallback conversion of create_view-style elements to full Excalidraw
// elements, used when no browser tab is open to do it with real font metrics.

/** elements written in the short create_view format still need conversion */
export const needsConversion = (el) =>
  el.label !== undefined || el.version === undefined || el.markdown !== undefined;

/**
 * Markdown-like text as plain text (list markers kept): the formatting needs
 * the browser (an open app); without one the words still arrive
 */
const plainOfMarkdown = (markdown) => {
  let numbered = 0;
  return String(markdown)
    .split("\n")
    .map((line) => {
      if (!/^\s*\d+[.)] /.test(line)) {
        numbered = 0;
      }
      return line
        .replace(/^(\s*)#{1,3} /, "$1")
        .replace(/^(\s*)(?:[-*] )?\[([ xX])\] /, (_, indent, x) => `${indent}${x.trim() ? "☑" : "☐"} `)
        .replace(/^(\s*)[-*•] /, "$1• ")
        .replace(/^(\s*)\d+[.)] /, (_, indent) => `${indent}${++numbered}. `)
        .replace(/\{(?:\s*(?:color|highlight|size)=[^\s}]+)+\s*\}([\s\S]*?)\{\/\}/g, "$1")
        .replace(/\[([^\]]+)\]\([^)\s]+\)/g, "$1")
        .replace(/\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\*([^*\s][\s\S]*?)\*/g, (_, a, b, c, d) => a ?? b ?? c ?? d)
        .replace(/\\([*_~[\]{}\\])/g, "$1");
    })
    .join("\n");
};

const rand = () => Math.floor(Math.random() * 2 ** 31);

/**
 * Fallback conversion used when no browser tab is open (the browser converts
 * with real font metrics, see scenes-plugin/src/live.ts). Text sizes are
 * estimated; Excalidraw re-measures text when the scene is opened.
 */
export const convertInNode = (elements) => {
  const out = [];
  const byId = new Map();
  const base = (el) => ({
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: rand(),
    version: 1,
    versionNonce: rand(),
    isDeleted: false,
    boundElements: [],
    updated: Date.now(),
    link: null,
    locked: false,
    ...el,
  });
  const textProps = (text, fontSize) => {
    const lines = String(text).split("\n");
    return {
      text,
      originalText: text,
      fontSize,
      fontFamily: 5,
      lineHeight: 1.25,
      autoResize: true,
      width: Math.max(...lines.map((l) => l.length)) * fontSize * 0.55,
      height: lines.length * fontSize * 1.25,
    };
  };

  for (const raw of elements) {
    if (!needsConversion(raw)) {
      out.push(raw);
      byId.set(raw.id, raw);
      continue;
    }
    const { label: rawLabel, markdown, ...rest } = raw;
    if (typeof markdown === "string") {
      rest.text = plainOfMarkdown(markdown);
    }
    const label =
      typeof rawLabel?.markdown === "string" ? { ...rawLabel, text: plainOfMarkdown(rawLabel.markdown) } : rawLabel;
    const el = base(rest);
    if (el.type === "text") {
      Object.assign(el, {
        textAlign: "left",
        verticalAlign: "top",
        containerId: null,
        ...textProps(el.text ?? "", el.fontSize ?? 20),
        ...rest,
      });
      el.originalText ??= el.text;
    }
    if (el.type === "arrow" || el.type === "line") {
      el.points ??= [
        [0, 0],
        [el.width ?? 100, el.height ?? 0],
      ];
      el.lastCommittedPoint = null;
      el.startArrowhead ??= null;
      el.endArrowhead ??= el.type === "arrow" ? "arrow" : null;
      el.startBinding ??= null;
      el.endBinding ??= null;
    }
    out.push(el);
    byId.set(el.id, el);

    if (label?.text) {
      const fontSize = label.fontSize ?? 20;
      const text = textProps(label.text, fontSize);
      let cx = el.x + (el.width ?? 0) / 2;
      let cy = el.y + (el.height ?? 0) / 2;
      if (el.points) {
        const mid = el.points[Math.floor((el.points.length - 1) / 2)];
        const next = el.points[Math.ceil((el.points.length - 1) / 2)];
        cx = el.x + (mid[0] + next[0]) / 2;
        cy = el.y + (mid[1] + next[1]) / 2;
      }
      const textEl = base({
        type: "text",
        id: `${el.id}-label`,
        x: cx - text.width / 2,
        y: cy - text.height / 2,
        strokeColor: label.strokeColor ?? el.strokeColor,
        textAlign: label.textAlign ?? "center",
        verticalAlign: label.verticalAlign ?? "middle",
        containerId: el.id,
        ...text,
      });
      el.boundElements = [...(el.boundElements || []), { type: "text", id: textEl.id }];
      out.push(textEl);
      byId.set(textEl.id, textEl);
    }
  }
  // register arrows on the shapes they bind to
  for (const el of out) {
    for (const key of ["startBinding", "endBinding"]) {
      const binding = el[key];
      const target = binding?.elementId && byId.get(binding.elementId);
      if (!target) {
        continue;
      }
      el[key] = { fixedPoint: [0.5, 0.5], mode: "orbit", ...binding };
      if (!target.boundElements?.some((b) => b.id === el.id)) {
        target.boundElements = [...(target.boundElements || []), { type: "arrow", id: el.id }];
      }
    }
  }
  return out;
};
