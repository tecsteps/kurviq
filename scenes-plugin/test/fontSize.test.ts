import { expect, it } from "vitest";
import { parseFontSize } from "../src/fontSize";
it.each([["27", 27], ["27.5", 27.5], ["0", 1], ["1001", 1000], ["", null], ["garbage", null], ["Infinity", null]])("parses %s", (value, expected) => {
  expect(parseFontSize(String(value))).toBe(expected);
});
