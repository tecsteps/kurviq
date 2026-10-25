// The text editor, with formatting: Excalidraw's own editor (textWysiwyg)
// keeps positioning, sizing and submitting it, but types into this
// contenteditable instead of a textarea. It acts like one where the editor
// expects a textarea (`value` is the plain text, selection offsets into it),
// and keeps the formatting in the element's `customData.rich`.
//
// Shortcuts: ⌘B bold, ⌘I italic, ⌘U underline, ⌘⇧X strikethrough,
// ⌘⇧7 numbered list, ⌘⇧8 bullets, ⌘⇧9 checklist, ⌘K link,
// ⌘⇧H highlight, ⌘\ clear formatting, ⌘⇧. / ⌘⇧, size of the selection,
// Tab / ⇧Tab indent, ⌘Z / ⌘⇧Z undo / redo.

import "./richText.scss";

import { parseDom } from "./dom";
import { docToHtml } from "./layout";
import {
  MAX_DEPTH,
  commonMarks,
  comparePos,
  deleteRange,
  docFromPlain,
  formatRange,
  insertDoc,
  insertText,
  isPlainDoc,
  markRangeAt,
  markValues,
  marksAt,
  markersOf,
  paraText,
  plainOf,
  plainToPos,
  posToPlain,
  richDocOf,
  safeLink,
  setParagraphs,
  sliceDoc,
  splitParagraph,
} from "./model";
import { createToolbar } from "./toolbar";

import type { Marks, ParaKind, Pos, RichDoc } from "./model";

const RICH_MIME = "application/x-excalidraw-rich-text";
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

type Snapshot = { doc: RichDoc; from: number; to: number };

export type RichEditorApi = {
  state: () => {
    marks: Marks;
    kinds: Set<ParaKind | undefined>;
    collapsed: boolean;
    base: number;
    /** the size of the selection, in px (null: mixed) */
    size: number | null;
    /** the text's line height (a factor of the font size) */
    lineHeight: number;
  };
  setLink: (url: string | undefined) => void;
  toggleMark: (key: "b" | "i" | "u" | "s") => void;
  setMark: (key: "c" | "h" | "a" | "z", value: string | number | undefined) => void;
  clearFormatting: () => void;
  toggleList: (kind: ParaKind) => void;
  stepSize: (direction: 1 | -1) => void;
  setLineHeight: (value: number) => void;
  /** the text's font (one per element); null: no font choice here (speaker notes) */
  font: { get: () => number; set: (fontFamily: number) => void } | null;
  saveSelection: () => void;
  /** a popover field takes the focus: the editor stays open meanwhile */
  suspendBlur: () => void;
  restoreFocus: () => void;
  root: HTMLElement;
};

export const SIZE_STEPS = [8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 96];

export const createRichEditable = (
  ownerDocument: Document,
  element: any,
  app: any,
  getViewportCoords: (x: number, y: number) => [number, number],
  { fonts = true }: { fonts?: boolean } = {},
) => {
  const ownerWindow = ownerDocument.defaultView ?? window;
  const root = ownerDocument.createElement("div") as HTMLDivElement & Record<string, any>;
  root.contentEditable = "true";
  root.spellcheck = true;
  root.classList.add("rt-editor");
  root.setAttribute("role", "textbox");
  root.setAttribute("aria-multiline", "true");

  let toolbar: ReturnType<typeof createToolbar> | null = null;
  let doc: RichDoc = richDocOf(element) ?? docFromPlain(element.originalText ?? "");
  const isDark = () => app.state.theme === "dark";
  const render = () => {
    root.innerHTML = docToHtml(doc, isDark());
  };
  render();

  const latest = () => app.scene.getElement(element.id) ?? element;
  const baseSize = () => latest().fontSize as number;

  // ---------------------------------------------------------------------------
  // positions <-> DOM

  const paraElOf = (node: Node | null): HTMLElement | null => {
    while (node && node.parentNode !== root) {
      node = node.parentNode;
    }
    return node && node.nodeType === 1 ? (node as HTMLElement) : null;
  };

  const domToPos = (node: Node, offset: number): Pos => {
    if (node === root) {
      if (offset >= root.children.length) {
        const p = doc.p.length - 1;
        return { p, o: paraText(doc.p[p]).length };
      }
      return { p: Math.max(0, offset), o: 0 };
    }
    const para = paraElOf(node);
    if (!para) {
      return { p: 0, o: 0 };
    }
    const p = Math.min(Array.prototype.indexOf.call(root.children, para), doc.p.length - 1);
    const range = ownerDocument.createRange();
    range.setStart(para, 0);
    range.setEnd(node, offset);
    const o = range.toString().replace(/​/g, "").length;
    return { p: Math.max(0, p), o: Math.min(o, paraText(doc.p[Math.max(0, p)]).length) };
  };

  const posToDom = (pos: Pos): [Node, number] => {
    const para = root.children[pos.p] as HTMLElement | undefined;
    if (!para) {
      return [root, root.childNodes.length];
    }
    const walker = ownerDocument.createTreeWalker(para, NodeFilter.SHOW_TEXT);
    let at = 0;
    let last: Text | null = null;
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      if (pos.o <= at + node.data.length) {
        return [node, pos.o - at];
      }
      at += node.data.length;
      last = node;
    }
    return last ? [last, last.data.length] : [para, 0];
  };

  let lastSelection: { from: Pos; to: Pos; backward: boolean } = (() => {
    const p = doc.p.length - 1;
    const end = { p, o: paraText(doc.p[p]).length };
    return { from: end, to: end, backward: false };
  })();

  const readSelection = () => {
    const selection = ownerDocument.getSelection();
    if (selection?.rangeCount && root.contains(selection.anchorNode) && root.contains(selection.focusNode)) {
      const anchor = domToPos(selection.anchorNode!, selection.anchorOffset);
      const focus = domToPos(selection.focusNode!, selection.focusOffset);
      const backward = comparePos(focus, anchor) < 0;
      lastSelection = backward ? { from: focus, to: anchor, backward } : { from: anchor, to: focus, backward };
    }
    return lastSelection;
  };

  const setSelection = (from: Pos, to: Pos = from, backward = false) => {
    lastSelection = { from, to, backward };
    const selection = ownerDocument.getSelection();
    if (!selection || !root.isConnected) {
      return;
    }
    const [aNode, aOffset] = posToDom(backward ? to : from);
    const [fNode, fOffset] = posToDom(backward ? from : to);
    try {
      selection.setBaseAndExtent(aNode, aOffset, fNode, fOffset);
    } catch {}
  };

  const plainSelection = () => {
    const { from, to, backward } = readSelection();
    const markers = markersOf(doc);
    return { from: posToPlain(doc, from, markers), to: posToPlain(doc, to, markers), backward };
  };

  // ---------------------------------------------------------------------------
  // changes

  /** the formatting typed text gets, after e.g. ⌘B with nothing selected */
  let pending: { marks: Marks; at: Pos } | null = null;
  let emitting = false;
  let composing = false;
  const undoStack: Snapshot[] = [];
  const redoStack: Snapshot[] = [];
  let lastTyping = 0;
  let beforeInput: Snapshot | null = null;

  const snapshot = (): Snapshot => {
    const { from, to } = plainSelection();
    return { doc, from, to };
  };

  const pushUndo = (snap: Snapshot, typing = false) => {
    const now = Date.now();
    if (typing && now - lastTyping < 1000 && undoStack.length) {
      lastTyping = now;
      return;
    }
    lastTyping = typing ? now : 0;
    undoStack.push(snap);
    if (undoStack.length > 200) {
      undoStack.shift();
    }
    redoStack.length = 0;
  };

  /** writes the formatting to the element (none: when there's none) */
  const commit = () => {
    const el = app.scene.getElement(element.id);
    if (!el) {
      return;
    }
    const rich = isPlainDoc(doc) ? undefined : doc;
    if (JSON.stringify(el.customData?.rich) === JSON.stringify(rich)) {
      return;
    }
    const { rich: _old, ...rest } = el.customData || {};
    app.scene.mutateElement(el, { customData: rich ? { ...rest, rich } : rest }, { informMutation: false, isDragging: false });
  };

  /** tells Excalidraw's editor the text changed (it re-measures, grows the shape …) */
  const emit = () => {
    commit();
    emitting = true;
    try {
      root.dispatchEvent(new Event("input"));
    } finally {
      emitting = false;
    }
    toolbar?.update();
  };

  const apply = (next: RichDoc, from: Pos, to: Pos = from) => {
    pushUndo(snapshot());
    doc = next;
    render();
    setSelection(from, to);
    emit();
  };

  /** the browser typed into the DOM: read it back, keep the DOM tidy */
  /**
   * Puts the DOM back into the shape the doc renders to (after the browser
   * typed text outside a span, merged paragraphs …). Later than the input
   * event: the browser places the caret after its edit only after that.
   */
  let tidyTimer = 0;
  const tidy = () => {
    tidyTimer = 0;
    if (composing || !root.isConnected || root.innerHTML === docToHtml(doc, isDark())) {
      return;
    }
    const { from, to, backward } = readSelection();
    const clamp = (pos: Pos): Pos => {
      const p = Math.min(pos.p, doc.p.length - 1);
      return { p, o: Math.min(pos.o, paraText(doc.p[p]).length) };
    };
    render();
    setSelection(clamp(from), clamp(to), backward);
  };

  /** the browser typed into the DOM: read it back */
  const sync = () => {
    const parsed = parseDom(root, { external: false });
    if (JSON.stringify(parsed) !== JSON.stringify(doc)) {
      if (beforeInput) {
        pushUndo(beforeInput, true);
      }
      doc = parsed;
    }
    beforeInput = null;
    if (!tidyTimer) {
      tidyTimer = ownerWindow.setTimeout(tidy);
    }
    commit();
  };

  const restore = (snap: Snapshot) => {
    doc = snap.doc;
    render();
    const markers = markersOf(doc);
    setSelection(plainToPos(doc, snap.from, markers), plainToPos(doc, snap.to, markers));
    emit();
  };

  const undo = () => {
    const snap = undoStack.pop();
    if (snap) {
      redoStack.push(snapshot());
      lastTyping = 0;
      restore(snap);
    }
  };

  const redo = () => {
    const snap = redoStack.pop();
    if (snap) {
      undoStack.push(snapshot());
      lastTyping = 0;
      restore(snap);
    }
  };

  // ---------------------------------------------------------------------------
  // commands

  const toggleMark = (key: "b" | "i" | "u" | "s") => {
    const { from, to } = readSelection();
    if (!comparePos(from, to)) {
      const marks = pending?.marks ?? marksAt(doc, from);
      pending = { marks: { ...marks, [key]: marks[key] ? undefined : true }, at: from };
      toolbar?.update();
      return;
    }
    const on = !commonMarks(doc, from, to)[key];
    apply(formatRange(doc, from, to, (marks) => ({ ...marks, [key]: on ? true : undefined })), from, to);
  };

  const setMark = (key: "c" | "h" | "a" | "z", value: string | number | undefined) => {
    const { from, to } = readSelection();
    if (!comparePos(from, to)) {
      if (key === "a") {
        return;
      }
      const marks = pending?.marks ?? marksAt(doc, from);
      pending = { marks: { ...marks, [key]: value }, at: from };
      toolbar?.update();
      return;
    }
    apply(formatRange(doc, from, to, (marks) => ({ ...marks, [key]: value })), from, to);
  };

  const clearFormatting = () => {
    const { from, to } = readSelection();
    if (!comparePos(from, to)) {
      pending = { marks: {}, at: from };
      toolbar?.update();
      return;
    }
    apply(formatRange(doc, from, to, (marks) => (marks.a ? { a: marks.a } : {})), from, to);
  };

  const setLink = (url: string | undefined) => {
    let { from, to } = readSelection();
    if (!comparePos(from, to)) {
      // in a link: all of it; elsewhere, the address as its own text
      const range = markRangeAt(doc, from, "a");
      if (range) {
        ({ from, to } = range);
      } else {
        if (url) {
          const result = insertText(doc, from, url, { ...marksAt(doc, from), a: url });
          apply(result.doc, result.end);
        }
        return;
      }
    }
    apply(formatRange(doc, from, to, (marks) => ({ ...marks, a: url })), from, to);
  };

  const toggleList = (kind: ParaKind) => {
    const { from, to } = readSelection();
    const all = doc.p.slice(from.p, to.p + 1).every((para) => para.k === kind);
    apply(
      setParagraphs(doc, from.p, to.p, (para) => {
        if (all) {
          const { k: _k, d: _d, x: _x, ...rest } = para;
          return rest;
        }
        return { ...para, k: kind, x: kind === "todo" ? para.x : undefined };
      }),
      from,
      to,
    );
  };

  const indent = (delta: 1 | -1) => {
    const { from, to } = readSelection();
    const paras = doc.p.slice(from.p, to.p + 1);
    if (paras.every((para) => para.k)) {
      apply(
        setParagraphs(doc, from.p, to.p, (para) => ({
          ...para,
          d: Math.max(0, Math.min(MAX_DEPTH, (para.d || 0) + delta)),
        })),
        from,
        to,
      );
      return;
    }
    // plain paragraphs: 4 spaces at their start
    let next = doc;
    let shiftFrom = 0;
    let shiftTo = 0;
    for (let p = from.p; p <= to.p; p++) {
      if (delta > 0) {
        next = insertText(next, { p, o: 0 }, "    ", marksAt(next, { p, o: 0 })).doc;
        if (p === from.p) shiftFrom = 4;
        if (p === to.p) shiftTo = 4;
      } else {
        const spaces = paraText(next.p[p]).match(/^ {0,4}/)![0].length;
        next = deleteRange(next, { p, o: 0 }, { p, o: spaces });
        if (p === from.p) shiftFrom = -Math.min(spaces, from.o);
        if (p === to.p) shiftTo = -Math.min(spaces, to.o);
      }
    }
    apply(next, { p: from.p, o: from.o + shiftFrom }, { p: to.p, o: to.o + shiftTo });
  };

  const stepSize = (direction: 1 | -1) => {
    const { from, to } = readSelection();
    const base = baseSize();
    const current = Math.round(base * (commonMarks(doc, from, to).z || (comparePos(from, to) ? 0 : 1) || 1));
    const next =
      direction > 0
        ? SIZE_STEPS.find((size) => size > current) ?? current
        : [...SIZE_STEPS].reverse().find((size) => size < current) ?? current;
    if (comparePos(from, to)) {
      // each piece one step from its own size
      apply(
        formatRange(doc, from, to, (marks) => {
          const own = Math.round(base * (marks.z || 1));
          const size =
            direction > 0
              ? SIZE_STEPS.find((s) => s > own) ?? own
              : [...SIZE_STEPS].reverse().find((s) => s < own) ?? own;
          return { ...marks, z: size / base };
        }),
        from,
        to,
      );
    } else {
      setMark("z", next / base);
    }
  };

  const toggleChecked = (p: number) => {
    const { from, to } = readSelection();
    apply(
      setParagraphs(doc, p, p, (para) => ({ ...para, x: para.x ? undefined : true })),
      from,
      to,
    );
  };

  const insert = (piece: RichDoc | string) => {
    const { from, to } = readSelection();
    const base = deleteRange(doc, from, to);
    const result =
      typeof piece === "string"
        ? insertText(base, from, piece, pending?.marks ?? marksAt(doc, from))
        : insertDoc(base, from, piece);
    pending = null;
    apply(result.doc, result.end);
  };

  // ---------------------------------------------------------------------------
  // events

  const mod = (event: KeyboardEvent) => (isMac ? event.metaKey : event.ctrlKey);

  root.addEventListener("keydown", (event) => {
    if (event.isComposing) {
      return;
    }
    let handled = true;
    const code = event.code;
    const key = event.key.toLowerCase();
    if (mod(event) && !event.altKey) {
      if (!event.shiftKey && key === "b") toggleMark("b");
      else if (!event.shiftKey && key === "i") toggleMark("i");
      else if (!event.shiftKey && key === "u") toggleMark("u");
      else if (event.shiftKey && (key === "x" || key === "s")) toggleMark("s");
      else if (event.shiftKey && code === "Digit7") toggleList("ol");
      else if (event.shiftKey && code === "Digit8") toggleList("ul");
      else if (event.shiftKey && code === "Digit9") toggleList("todo");
      else if (!event.shiftKey && key === "k") toolbar?.openLink();
      else if (event.shiftKey && key === "h") toolbar?.toggleHighlight();
      else if (code === "Backslash") clearFormatting();
      else if (!event.shiftKey && key === "z") undo();
      else if ((event.shiftKey && key === "z") || (!isMac && key === "y")) redo();
      else if (event.shiftKey && (code === "Period" || code === "Comma") && comparePos(readSelection().from, readSelection().to)) {
        // the selection's size (with nothing selected, the whole text's: Excalidraw's)
        stepSize(code === "Period" ? 1 : -1);
      } else handled = false;
    } else if (event.key === "Tab" && !event.altKey && !mod(event)) {
      indent(event.shiftKey ? -1 : 1);
    } else if (event.key === "Backspace" && !mod(event) && !event.altKey) {
      const { from, to } = readSelection();
      const para = doc.p[from.p];
      if (!comparePos(from, to) && from.o === 0 && para.k) {
        // at a list item's start: it stops being one
        const { k: _k, d: _d, x: _x, ...rest } = para;
        apply(setParagraphs(doc, from.p, from.p, () => rest), from);
      } else {
        handled = false;
      }
    } else {
      handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  });

  root.addEventListener("beforeinput", (event: InputEvent) => {
    const type = event.inputType;
    if (type === "insertParagraph" || type === "insertLineBreak") {
      event.preventDefault();
      const { from, to } = readSelection();
      const carried = pending?.marks ?? marksAt(doc, from);
      const result = splitParagraph(deleteRange(doc, from, to), from);
      apply(result.doc, result.end);
      const { a: _link, ...marks } = carried;
      pending = Object.keys(marks).length ? { marks, at: result.end } : null;
      return;
    }
    if (type === "insertText" && pending && event.data) {
      event.preventDefault();
      insert(event.data);
      return;
    }
    if (type === "insertFromPaste" || type === "insertFromDrop" || type === "insertFromYank") {
      // handled by the paste listener (drops: not taken)
      event.preventDefault();
      return;
    }
    if (type === "historyUndo" || type === "historyRedo") {
      event.preventDefault();
      type === "historyUndo" ? undo() : redo();
      return;
    }
    const formats: Record<string, () => void> = {
      formatBold: () => toggleMark("b"),
      formatItalic: () => toggleMark("i"),
      formatUnderline: () => toggleMark("u"),
      formatStrikeThrough: () => toggleMark("s"),
    };
    if (formats[type]) {
      event.preventDefault();
      formats[type]();
      return;
    }
    beforeInput = beforeInput ?? snapshot();
  });

  root.addEventListener("input", (event) => {
    if (emitting) {
      return;
    }
    if (composing || (event as InputEvent).isComposing) {
      // Excalidraw's editor must not see this: it re-measures on the text
      event.stopImmediatePropagation();
      return;
    }
    pending = null;
    sync();
  });

  root.addEventListener("compositionstart", () => {
    composing = true;
  });
  root.addEventListener("compositionend", () => {
    composing = false;
    // the input event that follows (or not, in some browsers)
    ownerWindow.setTimeout(() => {
      if (!composing) {
        sync();
        emit();
      }
    });
  });

  const copySelection = (event: ClipboardEvent, cut: boolean) => {
    // not Excalidraw's: it would copy the selected elements
    event.stopPropagation();
    const { from, to } = readSelection();
    if (!comparePos(from, to) || !event.clipboardData) {
      return;
    }
    event.preventDefault();
    const piece = sliceDoc(doc, from, to);
    event.clipboardData.setData("text/plain", piece.p.map(paraText).join("\n"));
    event.clipboardData.setData("text/html", `<div>${docToHtml(piece)}</div>`);
    event.clipboardData.setData(RICH_MIME, JSON.stringify(piece));
    if (cut) {
      apply(deleteRange(doc, from, to), from);
    }
  };
  root.addEventListener("copy", (event) => copySelection(event, false));
  root.addEventListener("cut", (event) => copySelection(event, true));

  root.addEventListener(
    "paste",
    (event) => {
      // instead of Excalidraw's editor (it would paste into a textarea)
      event.preventDefault();
      event.stopImmediatePropagation();
      const data = event.clipboardData;
      if (!data) {
        return;
      }
      const rich = data.getData(RICH_MIME);
      if (rich) {
        try {
          insert(JSON.parse(rich));
          return;
        } catch {}
      }
      const text = data.getData("text/plain");
      // Excalidraw elements: their texts
      if (/^\s*\{\s*"type"\s*:\s*"excalidraw\/clipboard"/.test(text)) {
        try {
          const texts = (JSON.parse(text).elements || [])
            .filter((el: any) => el.type === "text" && !el.isDeleted)
            .map((el: any) => el.originalText ?? el.text);
          if (texts.length) {
            insert(texts.join("\n"));
          }
        } catch {}
        return;
      }
      const html = data.getData("text/html");
      if (html) {
        try {
          const parsed = new DOMParser().parseFromString(html, "text/html");
          const piece = parseDom(parsed.body, { external: true });
          if (piece.p.some((para) => para.r.length)) {
            insert(piece);
            return;
          }
        } catch {}
      }
      if (text) {
        insert(text.replace(/\r\n?/g, "\n").replace(/\t/g, "    "));
      }
    },
    true,
  );

  root.addEventListener("pointerdown", (event) => {
    const target = event.target as HTMLElement;
    // ⌘-click opens a link
    const link = target.closest?.("[data-a]") as HTMLElement | null;
    if (link && mod(event as any)) {
      event.preventDefault();
      const href = safeLink(link.dataset.a);
      if (href) {
        ownerWindow.open(href, "_blank", "noopener,noreferrer");
      }
      return;
    }
    // a click on a checkbox ticks it
    const para = target.closest?.(".rt-p[data-k=todo]") as HTMLElement | null;
    if (para && para.parentNode === root) {
      const rect = para.getBoundingClientRect();
      const zoom = app.state.zoom?.value ?? 1;
      const indentPx = parseFloat(getComputedStyle(para).paddingLeft || "0") * zoom;
      if (event.clientX < rect.left + indentPx) {
        event.preventDefault();
        toggleChecked(Array.prototype.indexOf.call(root.children, para));
      }
    }
  });

  // ---------------------------------------------------------------------------
  // what Excalidraw's editor expects of a textarea

  let selectAllOnFocus = false;
  let initialised = false;
  let blurHandler: ((event: FocusEvent) => any) | null = null;
  const onblurDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "onblur")!;

  const caretFromPoint = (clientX: number, clientY: number): Pos | null => {
    const anyDoc = ownerDocument as any;
    let node: Node | null = null;
    let offset = 0;
    if (anyDoc.caretPositionFromPoint) {
      const position = anyDoc.caretPositionFromPoint(clientX, clientY);
      node = position?.offsetNode ?? null;
      offset = position?.offset ?? 0;
    } else if (anyDoc.caretRangeFromPoint) {
      const range = anyDoc.caretRangeFromPoint(clientX, clientY);
      node = range?.startContainer ?? null;
      offset = range?.startOffset ?? 0;
    }
    return node && root.contains(node) ? domToPos(node, offset) : null;
  };

  const setPlain = (value: string) => {
    const old = plainOf(doc);
    if (value === old) {
      return;
    }
    // the smallest change from the text there to this one, formatting kept
    let start = 0;
    while (start < old.length && start < value.length && old[start] === value[start]) start++;
    let end = 0;
    while (
      end < old.length - start &&
      end < value.length - start &&
      old[old.length - 1 - end] === value[value.length - 1 - end]
    ) end++;
    const markers = markersOf(doc);
    const from = plainToPos(doc, start, markers);
    const to = plainToPos(doc, old.length - end, markers);
    const inserted = value.slice(start, value.length - end);
    const marks = marksAt(doc, from);
    pushUndo(snapshot());
    doc = insertText(deleteRange(doc, from, to), from, inserted, marks).doc;
    render();
    commit();
  };

  Object.defineProperties(root, {
    value: { get: () => plainOf(doc), set: setPlain, configurable: true },
    selectionStart: {
      get: () => plainSelection().from,
      set: (value: number) => root.setSelectionRange(value, Math.max(value, plainSelection().to)),
      configurable: true,
    },
    selectionEnd: {
      get: () => plainSelection().to,
      set: (value: number) => root.setSelectionRange(Math.min(value, plainSelection().from), value),
      configurable: true,
    },
    selectionDirection: { get: () => (readSelection().backward ? "backward" : "forward"), configurable: true },
    setSelectionRange: {
      value: (start: number, end: number) => {
        const point = root.__initialPoint as [number, number] | null;
        root.__initialPoint = null;
        if (point) {
          const pos = caretFromPoint(point[0] + (app.state.offsetLeft || 0), point[1] + (app.state.offsetTop || 0));
          if (pos) {
            setSelection(pos);
            return;
          }
        }
        const markers = markersOf(doc);
        setSelection(plainToPos(doc, start, markers), plainToPos(doc, end, markers));
      },
      configurable: true,
    },
    select: {
      value: () => {
        if (root.isConnected && ownerDocument.activeElement === root) {
          const p = doc.p.length - 1;
          setSelection({ p: 0, o: 0 }, { p, o: paraText(doc.p[p]).length });
        } else {
          selectAllOnFocus = true;
        }
      },
      configurable: true,
    },
    onblur: {
      get: () => onblurDescriptor.get!.call(root),
      set: (handler: any) => {
        if (handler) {
          blurHandler = handler;
        }
        onblurDescriptor.set!.call(root, handler);
      },
      configurable: true,
    },
  });

  root.addEventListener("focus", () => {
    if (initialised) {
      return;
    }
    initialised = true;
    if (selectAllOnFocus && !root.__initialPoint) {
      root.select();
    } else {
      setSelection(lastSelection.from, lastSelection.to);
    }
    toolbar?.mount();
  });

  ownerDocument.addEventListener("selectionchange", function onSelection() {
    if (!root.isConnected) {
      if (initialised) {
        ownerDocument.removeEventListener("selectionchange", onSelection);
        toolbar?.destroy();
      }
      return;
    }
    const selection = ownerDocument.getSelection();
    if (!selection || !root.contains(selection.anchorNode)) {
      return;
    }
    const { from } = readSelection();
    if (pending && comparePos(pending.at, from)) {
      pending = null;
    }
    toolbar?.update();
  });

  // ---------------------------------------------------------------------------

  const api: RichEditorApi = {
    root,
    state: () => {
      const { from, to } = lastSelection;
      const collapsed = !comparePos(from, to);
      const base = baseSize();
      const sizes = pending ? new Set([pending.marks.z]) : markValues(doc, from, to, "z");
      return {
        size: sizes.size === 1 ? Math.round(base * (([...sizes][0] as number | undefined) || 1)) : null,
        marks: pending?.marks ?? commonMarks(doc, from, to),
        kinds: new Set(doc.p.slice(from.p, to.p + 1).map((para) => para.k)),
        collapsed,
        base,
        lineHeight: latest().lineHeight,
      };
    },
    toggleMark,
    setMark,
    clearFormatting,
    toggleList,
    setLink,
    stepSize,
    setLineHeight: (value: number) => {
      const el = app.scene.getElement(element.id);
      if (!el || el.lineHeight === value) {
        return;
      }
      // the whole text (Excalidraw keeps one line height per element); measured again
      app.scene.mutateElement(el, { lineHeight: value });
      root.style.lineHeight = String(value);
      emit();
    },
    font: fonts
      ? {
          get: () => latest().fontFamily as number,
          set: (fontFamily: number) => {
            const el = app.scene.getElement(element.id);
            if (!el || el.fontFamily === fontFamily) {
              return;
            }
            // the whole text (Excalidraw keeps one font per element); measured again
            app.scene.mutateElement(el, { fontFamily });
            emit();
          },
        }
      : null,
    saveSelection: () => {
      readSelection();
    },
    suspendBlur: () => {
      onblurDescriptor.set!.call(root, null);
    },
    restoreFocus: () => {
      root.focus({ preventScroll: true });
      setSelection(lastSelection.from, lastSelection.to, lastSelection.backward);
      // a popover took the focus and with it Excalidraw's submit on blur
      if (blurHandler && !onblurDescriptor.get!.call(root)) {
        onblurDescriptor.set!.call(root, blurHandler);
      }
    },
  };

  toolbar = createToolbar(api, app, element.id, getViewportCoords);
  root.__richEditor = api;
  return root;
};
