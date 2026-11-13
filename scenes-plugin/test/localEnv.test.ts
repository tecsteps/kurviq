// The one reader of .env / .env.local (scripts/env.mjs) all local tools share.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseEnv, readEnvFiles } from "../../scripts/env.mjs";

describe(".env reader", () => {
  it("reads settings, with quotes and spaces, and skips the rest", () => {
    expect(
      parseEnv("# comment\nA=1\n  B = two words  \nC='quoted'\nD=\"double\"\nnot a setting\nE=\n"),
    ).toEqual({ A: "1", B: "two words", C: "quoted", D: "double", E: "" });
  });

  it("drops values with a line or paragraph separator", () => {
    expect(parseEnv("A=x y\nB=ok")).toEqual({ B: "ok" });
  });

  it("lets .env.local win over .env", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "kurviq-env-"));
    try {
      writeFileSync(path.join(dir, ".env"), "A=from-env\nB=only-env\n");
      writeFileSync(path.join(dir, ".env.local"), "A=from-local\n");
      expect(readEnvFiles(dir)).toEqual({ A: "from-local", B: "only-env" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
