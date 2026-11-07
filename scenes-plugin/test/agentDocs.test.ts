import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { kurviqReference, kurviqSkill } from "../../online/worker/skill";

// What agents get: the server's instructions (every connection) and read_me
// (once per conversation). Each fact in one place, small, and every pointer lands.
const tokens = (text: string) => Math.round(text.length / 4);
const root = new URL("../../", import.meta.url);
const local = {
  skill: readFileSync(new URL("scenes-mcp/skill/kurviq-scenes/SKILL.md", root), "utf8"),
  reference: readFileSync(new URL("scenes-mcp/skill/kurviq-scenes/REFERENCE.md", root), "utf8"),
};
const online = { skill: kurviqSkill("https://kurviq.com"), reference: kurviqReference("https://kurviq.com/u/x") };
const tools = readFileSync(new URL("scenes-mcp/tools.mjs", root), "utf8");
const headings = (text: string) => [...text.matchAll(/^## (.+)$/gm)].map((match) => match[1]);

describe("agent instructions and read_me", () => {
  it("stay compact", () => {
    for (const docs of [local, online]) {
      expect(tokens(docs.skill)).toBeLessThan(3200);
      expect(tokens(docs.reference)).toBeLessThan(4800);
    }
  });

  it("keep the format in read_me and the workflow in the instructions, not both", () => {
    for (const docs of [local, online]) {
      for (const heading of ["Elements", "Editing (`edit_scene`)", "Formatted text (bold, lists, colors in one text)", "Slides (presentations)"]) {
        expect(headings(docs.reference)).toContain(heading);
        expect(headings(docs.skill)).not.toContain(heading);
      }
      expect(headings(docs.skill)).toContain("Golden rules");
      expect(docs.skill).toContain("read_me");
    }
  });

  it("online texts carry nothing of the local install", () => {
    const text = online.skill + online.reference;
    for (const local of ["export_pdf", "absolute file path", "/abs/path.json", "localhost:3101", "elementsFile", "draw.test", "must lie inside", "REFERENCE.md"]) {
      expect(text).not.toContain(local);
    }
    expect(online.reference).toContain("## Images from your machine");
    expect(online.reference).toContain("https://kurviq.com/u/x");
  });

  it("every read_me section a tool description names exists", () => {
    const named = [...tools.matchAll(/read_me: "([^"]+)"/g)].map((match) => match[1]);
    for (const name of new Set(named)) {
      expect(headings(online.reference).some((heading) => heading.startsWith(name))).toBe(true);
    }
  });
});
