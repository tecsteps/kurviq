import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// The real controller method, without the browser-only editor (as presentationReload.test.ts does).
const source = ts.createSourceFile("controller.ts", readFileSync(new URL("../src/controller.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const controller = source.statements.find((statement) => ts.isClassDeclaration(statement) && statement.name?.text === "ScenesController") as ts.ClassDeclaration;
const methods = controller.members.filter((member) => member.name?.getText(source) === "openOrCreateInner").map((member) => member.getText(source)).join("\n");
const compiled = ts.transpileModule(`class Controller { ${methods} }; exports.Controller = Controller;`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} as Record<string, any> };
new Function("exports", compiled)(loaded.exports);

const fixture = (openError: unknown, notConnected = false) => {
  const instance = new loaded.exports.Controller();
  Object.assign(instance, {
    state: { sync: { notConnected } },
    exists: () => false,
    open: vi.fn(() => (openError ? Promise.reject(openError) : Promise.resolve())),
    create: vi.fn(() => Promise.resolve()),
  });
  return instance;
};

describe("a scene link opens the scene, or creates it", () => {
  it("not in Drive: elsewhere first, else a new scene", async () => {
    const instance = fixture(Object.assign(new Error("missing"), { status: 404 }));
    const elsewhere = vi.fn(() => Promise.resolve(null));
    expect(await instance.openOrCreateInner("Plan", elsewhere)).toBe("created");
    expect(elsewhere).toHaveBeenCalledWith("Plan");
  });

  it("no Drive to look in (signed out, or not known yet at the first navigation): a new scene, nothing else asked", async () => {
    const instance = fixture(Object.assign(new Error("Google Drive is not connected"), { status: 0, notConnected: true }));
    const elsewhere = vi.fn(() => Promise.resolve(null));
    expect(await instance.openOrCreateInner("Plan", elsewhere)).toBe("created");
    expect(elsewhere).not.toHaveBeenCalled();
    expect(instance.create).toHaveBeenCalledWith("Plan");
  });

  it("other errors stay errors (nothing is created over a scene that couldn't be read)", async () => {
    const instance = fixture(Object.assign(new Error("Kurviq server error (500)"), { status: 500 }));
    await expect(instance.openOrCreateInner("Plan")).rejects.toThrow(/500/);
    expect(instance.create).not.toHaveBeenCalled();
  });
});
