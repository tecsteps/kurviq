// PDF printing for the local scenes server: slides arrive as one HTML page of
// SVGs (real text, embedded fonts, made by scenes-plugin/src/pdfExport.ts)
// and are printed by headless Chrome, so the PDF keeps text as text.
// A module of its own so the unit tests can run it without starting a server.
import { execFile } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** what the printed page may do: nothing but show its inline content */
const PDF_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'">`;
/** how the app's export starts: the policy is in force before any content (not merely somewhere in the text) */
export const PDF_START = `<!doctype html>\n<html><head><meta charset="utf-8">\n${PDF_CSP}\n`;

/**
 * Why the page can't be printed, or null. Besides the CSP prefix, the page
 * may contain no other <meta> tag than the two of the prefix: the CSP stops
 * scripts and requests, but not a `<meta http-equiv="refresh">` to another
 * file:// address, which would print (and return) a local file.
 */
export const pdfHtmlProblem = (html) => {
  if (typeof html !== "string" || !html.startsWith(PDF_START)) {
    return "Expected { html }";
  }
  if ((html.match(/<meta[\s/>]/gi) ?? []).length !== 2) {
    return "The page may not contain <meta> tags of its own";
  }
  return null;
};

/** an error with the HTTP status the server answers with */
export const httpError = (status, message) => Object.assign(new Error(message), { status });

/** print the page with Chrome (`chrome`: its executable) and return the PDF's bytes */
export const printPdf = async (html, chrome) => {
  if (!chrome) {
    throw httpError(409, "No Chrome found to print the PDF (set CHROME_PATH)");
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kurviq-pdf-"));
  try {
    const page = path.join(dir, "slides.html");
    const out = path.join(dir, "slides.pdf");
    await fs.writeFile(page, html);
    await new Promise((resolve, reject) => {
      execFile(
        chrome,
        [
          "--headless=new",
          `--user-data-dir=${path.join(dir, "profile")}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-gpu",
          "--no-pdf-header-footer",
          // the page is only printed: no scripts, no network (on top of its CSP)
          "--blink-settings=scriptEnabled=false",
          "--host-resolver-rules=MAP * ~NOTFOUND",
          "--virtual-time-budget=15000",
          `--print-to-pdf=${out}`,
          `file://${page}`,
        ],
        { timeout: 120000 },
        // Chrome may exit with an error after it wrote the file (e.g. a crash on shutdown)
        (error) => (error && !existsSync(out) ? reject(error) : resolve()),
      );
    });
    return await fs.readFile(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
