import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../src/scenes.scss", import.meta.url), "utf8");
const darkAt = css.indexOf("&.theme--dark .scenes-status");
const themes = {
  light: css.slice(css.indexOf(".scenes-status {"), darkAt),
  dark: css.slice(darkAt, css.indexOf(".scenes-pill__offline", darkAt)),
};
const luminance = (hex: string) => {
  const linear = [1, 3, 5].map((at) => {
    const channel = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
};

describe.each(Object.entries(themes))("%s status badges", (_theme, rules) => {
  it.each(["ok", "warn", "info", "danger"])("keeps %s text at least 4.5:1 against its actual background", (tone) => {
    const declarations = new RegExp(`&--${tone} \\{([^}]+)\\}`).exec(rules)![1];
    const foreground = /color: (#[0-9a-f]{6});/.exec(declarations)![1];
    const background = /background: (#[0-9a-f]{6});/.exec(declarations)![1];
    const [dark, light] = [luminance(foreground), luminance(background)].sort((a, b) => a - b);
    expect((light + 0.05) / (dark + 0.05)).toBeGreaterThanOrEqual(4.5);
  });
});
