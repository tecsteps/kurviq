// The local scenes server's PDF printing (scenes-server/pdf.mjs): which pages
// it accepts, and that it runs Chrome and returns what Chrome wrote. Chrome is
// stood in for by a small shell script that writes the --print-to-pdf file.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { PDF_START, pdfHtmlProblem, printPdf } from "../../scenes-server/pdf.mjs";

const page = (body: string) => `${PDF_START}<title>Deck</title></head><body>${body}</body></html>`;

describe("pdfHtmlProblem", () => {
  it("accepts the app's export", () => {
    expect(pdfHtmlProblem(page("<div class=\"page\"><svg><metadata></metadata></svg></div>"))).toBeNull();
  });

  it("refuses a page without the CSP prefix", () => {
    expect(pdfHtmlProblem("<html><body>hi</body></html>")).toMatch(/Expected/);
    expect(pdfHtmlProblem(42)).toMatch(/Expected/);
  });

  it("refuses a page with a meta tag of its own (a refresh to a local file)", () => {
    expect(pdfHtmlProblem(page('<meta http-equiv="refresh" content="0;url=file:///etc/passwd">'))).toMatch(/meta/);
    expect(pdfHtmlProblem(page("<META\nhttp-equiv=refresh>"))).toMatch(/meta/);
  });
});

describe("printPdf", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kurviq-pdf-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("runs Chrome and returns the PDF it wrote", async () => {
    const chrome = path.join(dir, "fake-chrome.sh");
    writeFileSync(
      chrome,
      '#!/bin/sh\nfor arg in "$@"; do case "$arg" in --print-to-pdf=*) printf "%%PDF-fake" > "${arg#--print-to-pdf=}";; esac; done\n',
    );
    chmodSync(chrome, 0o755);
    const pdf = await printPdf(page("x"), chrome);
    expect(pdf.toString()).toBe("%PDF-fake");
  });

  it("answers 409 without Chrome", async () => {
    await expect(printPdf(page("x"), undefined)).rejects.toMatchObject({ status: 409 });
  });
});
