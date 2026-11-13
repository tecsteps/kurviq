import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real controller methods (as presentationReload.test.ts does): when is the editor gone?
const source = ts.createSourceFile("controller.ts", readFileSync(new URL("../src/controller.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const controller = source.statements.find((statement) => ts.isClassDeclaration(statement) && statement.name?.text === "ScenesController") as ts.ClassDeclaration;
const names = new Set(["holds", "release", "editorGone"]);
const members = controller.members.filter((member) => member.name && names.has(member.name.getText(source))).map((member) => member.getText(source)).join("\n");
const compiled = ts.transpileModule(`class Controller { ${members} }; exports.Controller = Controller;`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} as Record<string, any> };
new Function("exports", "window", compiled)(loaded.exports, globalThis);

const fixture = () => {
  const instance = new loaded.exports.Controller();
  const detach = vi.fn(() => {
    instance.api = null;
  });
  // attach as far as holding goes: one more hold, this API in use
  const attach = (api: object) => {
    instance.holds++;
    instance.api = api;
  };
  Object.assign(instance, { api: null, detach });
  return { instance, attach, detach };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the editor is gone only when nothing holds it any more", () => {
  it("unmounted for good: gone after a tick", () => {
    const { instance, attach, detach } = fixture();
    const api = {};
    attach(api);
    instance.release(api);
    vi.runAllTimers();
    expect(detach).toHaveBeenCalledTimes(1);
  });

  it("an effect run twice (development) or a new API object at start: not gone", () => {
    const { instance, attach, detach } = fixture();
    const first = {};
    attach(first);
    instance.release(first);
    attach(first); // StrictMode's second run
    vi.runAllTimers();
    expect(detach).not.toHaveBeenCalled();
    const next = {};
    instance.release(first);
    attach(next); // the editor's new API object
    vi.runAllTimers();
    expect(detach).not.toHaveBeenCalled();
    expect(instance.api).toBe(next);
  });

  it("a late release of an old API never detaches the one in use", () => {
    const { instance, attach, detach } = fixture();
    const old = {};
    const current = {};
    attach(current);
    instance.editorGone(old);
    expect(detach).not.toHaveBeenCalled();
  });
});
