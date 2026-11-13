import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

// Small decisions from browser-only modules (fonts.ts, notes.tsx, richText/layout.ts): the
// production functions, compiled on their own without the editor around them.
const require = createRequire(import.meta.url);
const ts = require("../../excalidraw/node_modules/typescript");

const extract = (file: string, name: string) => {
  const source = ts.createSourceFile(file, readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const declaration = source.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement: any) => [...statement.declarationList.declarations])
    .find((item: any) => item.name.getText(source) === name);
  if (!declaration?.initializer) throw new Error(`${name} not found in ${file}`);
  const compiled = ts.transpileModule(`exports.fn = ${declaration.initializer.getText(source)};`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded: Record<string, any> = {};
  new Function("exports", compiled)(loaded);
  return loaded.fn;
};

const registration = extract("fonts.ts", "registration");
const incomingNotes = extract("notes.tsx", "incomingNotes");
const growFragment = extract("richText/layout.ts", "growFragment");

const font = (family: string, data = "data:font/woff2;base64,AA==") => ({ family, id: 7116, faces: [{ data }], source: "file" });

describe("registering a font whose number is taken", () => {
  it("lets the new font win when another font has its number (two names, one hash)", () => {
    expect(registration(undefined, font("Font 48"), false)).toBe("new");
    expect(registration(font("Font 35"), font("Font 48"), false)).toBe("replace");
  });
  it("keeps the same font, and replaces its data only for live sync", () => {
    expect(registration(font("Geist"), font("geist"), false)).toBe("keep");
    expect(registration(font("Geist"), font("Geist", "data:font/woff2;base64,AB=="), false)).toBe("keep");
    expect(registration(font("Geist"), font("Geist", "data:font/woff2;base64,AB=="), true)).toBe("replace");
  });
});

describe("notes changed elsewhere while the notes popover is open", () => {
  it("are shown when nothing typed is unsaved, and wait for the user's choice when something is", () => {
    expect(incomingNotes({ saved: "old", dirty: false, hold: false }, "old")).toBe("same");
    expect(incomingNotes({ saved: "old", dirty: false, hold: false }, "new")).toBe("take");
    expect(incomingNotes({ saved: "old", dirty: true, hold: false }, "new")).toBe("conflict");
  });
});

describe("a formatted text's pieces as drawn", () => {
  const grow = (chars: Array<[number, number, boolean?]>) => {
    const fragment = { x: chars[0][0], width: 0 };
    const ends = new Map<object, number>();
    for (const [left, right, space] of chars) growFragment(fragment, ends, left, right, !!space);
    return fragment;
  };
  it("spans left to right text from its first character to its last visible one", () => {
    expect(grow([[0, 10], [10, 20], [20, 25, true]])).toEqual({ x: 0, width: 20 });
  });
  it("spans right to left text (each character left of the one before) from its leftmost character", () => {
    expect(grow([[90, 100], [80, 90], [70, 80]])).toEqual({ x: 70, width: 30 });
  });
});
