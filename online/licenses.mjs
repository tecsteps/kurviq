// Third-party notices for what Kurviq ships: every package whose code ends up
// in a bundle (the app, the Worker) with its license text, Excalidraw itself,
// and the fonts. MIT and the SIL Open Font License require the notices to
// travel with the copies; the minified bundles lose the comments, so the
// notices are published next to them (kurviq.com/third-party-licenses.txt).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXCALIDRAW = path.join(ROOT, "excalidraw");
const EXCALIDRAW_MCP = path.join(ROOT, "excalidraw-mcp");
/** our own code (MIT, see LICENSE) */
const OWN = ["scenes-plugin", "scenes-mcp", "online", "scenes-server", "scripts"].map((dir) => path.join(ROOT, dir) + path.sep);

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i;

const readLicenseFiles = (dir) =>
  readdirSync(dir)
    .filter((file) => LICENSE_FILE.test(file))
    .sort()
    .map((file) => readFileSync(path.join(dir, file), "utf8").trim());

const packageOf = (file) => {
  let dir = path.dirname(file);
  while (dir.startsWith(ROOT) && dir !== ROOT) {
    const manifest = path.join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const data = JSON.parse(readFileSync(manifest, "utf8"));
        if (data.name && (data.version || dir.includes(`${path.sep}node_modules${path.sep}`))) {
          return { dir, data };
        }
      } catch {}
    }
    dir = path.dirname(dir);
  }
  return null;
};

const licenseOf = (data) => {
  if (typeof data.license === "string") {
    return data.license;
  }
  if (data.license?.type) {
    return data.license.type;
  }
  const licenses = Array.isArray(data.licenses) ? data.licenses.map((l) => l.type || l).join(" OR ") : "see package";
  return licenses;
};

const repoOf = (data) => {
  const repo = typeof data.repository === "string" ? data.repository : data.repository?.url;
  return repo ? repo.replace(/^git\+/, "").replace(/\.git$/, "") : data.homepage || "";
};

/** the header comment of a font's index.ts (it carries the font's license) */
const fontHeader = (font) => {
  const file = path.join(EXCALIDRAW, "packages/excalidraw/fonts", font, "index.ts");
  if (!existsSync(file)) {
    return null;
  }
  const match = readFileSync(file, "utf8").match(/\/\*([\s\S]*?)\*\//);
  return match && /licen[cs]e/i.test(match[1]) ? match[1].trim() : null;
};

const FONTS = [
  ["Excalifont", "SIL Open Font License 1.1", "Copyright (c) 2024 by Excalidraw (license text below)"],
  ["Virgil", "SIL Open Font License 1.1", "https://github.com/excalidraw/virgil"],
  ["Xiaolai SC", "SIL Open Font License 1.1", "Copyright (c) 2020 LXGW (details below)"],
  ["Comic Shanns", "MIT", "(copyright and license below)"],
  ["Cascadia Code", "SIL Open Font License 1.1", "Microsoft, https://github.com/microsoft/cascadia-code"],
  ["Liberation Sans", "SIL Open Font License 1.1", "https://github.com/liberationfonts/liberation-fonts"],
  ["Lilita One", "SIL Open Font License 1.1", "https://fonts.google.com/specimen/Lilita+One"],
  ["Nunito", "SIL Open Font License 1.1", "https://github.com/googlefonts/nunito"],
  ["Assistant", "SIL Open Font License 1.1", "https://github.com/hafontia/Assistant"],
];

const RULE = "-".repeat(78);

const addMcpPackages = (packages) => {
  const deps = JSON.parse(readFileSync(path.join(EXCALIDRAW_MCP, "package.json"), "utf8")).dependencies || {};
  for (const name of Object.keys(deps)) {
    const dir = path.join(EXCALIDRAW_MCP, "node_modules", name);
    if (existsSync(path.join(dir, "package.json")) && !packages.has(name)) {
      packages.set(name, { dir, data: JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) });
    }
  }
};

const noticePackages = (files) => {
  const packages = new Map();
  let usesExcalidraw = false;
  let usesExcalidrawMcp = false;
  for (const raw of files) {
    const file = path.resolve(raw.replace(/^\0/, "").split("?")[0]);
    if (!file.startsWith(ROOT) || OWN.some((own) => file.startsWith(own))) {
      continue;
    }
    if (file.startsWith(EXCALIDRAW_MCP + path.sep) && !file.includes(`${path.sep}node_modules${path.sep}`)) {
      usesExcalidrawMcp = true;
      continue;
    }
    if (file.startsWith(EXCALIDRAW + path.sep) && !file.includes(`${path.sep}node_modules${path.sep}`)) {
      usesExcalidraw = true;
      continue;
    }
    const pkg = packageOf(file);
    if (pkg && !packages.has(pkg.data.name)) {
      packages.set(pkg.data.name, pkg);
    }
  }
  // excalidraw-mcp's dist is a bundle of its own: its dependencies are in it
  if (usesExcalidrawMcp) {
    addMcpPackages(packages);
  }

  return { packages, usesExcalidraw, usesExcalidrawMcp };
};

/**
 * @param {object} options
 * @param {string} options.title what this file covers
 * @param {string[]} options.files absolute paths of the modules in the bundle
 * @param {boolean} [options.fonts] include the fonts
 */
export const thirdPartyNotices = ({ title, files, fonts = false }) => {
  const { packages, usesExcalidraw, usesExcalidrawMcp } = noticePackages(files);

  const sections = [];
  if (usesExcalidraw) {
    sections.push(
      `Excalidraw (MIT)\nhttps://github.com/excalidraw/excalidraw\nKurviq is built on Excalidraw (unofficial, not affiliated with Excalidraw).\n\n${readLicenseFiles(EXCALIDRAW).join("\n\n")}`,
    );
  }
  if (usesExcalidrawMcp) {
    sections.push(
      "excalidraw-mcp (MIT)\nhttps://github.com/excalidraw/excalidraw-mcp\nCopyright (c) Excalidraw contributors. Licensed under the MIT License (text below, see Excalidraw).",
    );
  }
  for (const { dir, data } of [...packages.values()].sort((a, b) => a.data.name.localeCompare(b.data.name))) {
    const texts = readLicenseFiles(dir);
    const version = data.version ? ` ${data.version}` : "";
    const notice = texts.length ? texts.join("\n\n") : `Licensed under ${licenseOf(data)} (no license file in the package).`;
    sections.push(
      `${data.name}${version} (${licenseOf(data)})\n${repoOf(data)}\n\n${notice}`.trim(),
    );
  }
  if (fonts) {
    const ofl = fontHeader("Excalifont")?.split(/\n(?=SIL OPEN FONT LICENSE)/i)[1];
    sections.push(
      [
        "Fonts",
        ...FONTS.map(([name, license, credit]) => `- ${name}: ${license}. ${credit}`),
        "",
        ...["ComicShanns", "Xiaolai"].map((font) => fontHeader(font)).filter(Boolean).map((header) => `${header}\n`),
        ofl ? `SIL OPEN FONT LICENSE\n${ofl}` : "SIL Open Font License 1.1: https://openfontlicense.org",
      ].join("\n"),
    );
  }
  return `${title}

Kurviq (https://kurviq.com, source: https://github.com/tecsteps/kurviq) is
MIT licensed, Copyright (c) 2026 Fabian Wesner. It contains the following
third-party software and fonts, each under its own license:

${sections.map((section) => `${RULE}\n${section}`).join("\n\n")}
`;
};
