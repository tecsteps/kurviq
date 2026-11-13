import { describe, expect, it } from "vitest";

import { nextFocus } from "../src/dialogFocus";

const items = ["a", "b", "c"].map((id) => ({ id }) as unknown as HTMLElement);
const [first, middle, last] = items;

describe("Tab stays inside a dialog", () => {
  it("wraps from the last to the first and back", () => {
    expect(nextFocus(items, last, false)).toBe(first);
    expect(nextFocus(items, first, true)).toBe(last);
  });
  it("inside, the browser moves on its own", () => {
    expect(nextFocus(items, middle, false)).toBeNull();
    expect(nextFocus(items, middle, true)).toBeNull();
  });
  it("focus outside the dialog comes back in", () => {
    const outside = { id: "x" } as unknown as HTMLElement;
    expect(nextFocus(items, outside, false)).toBe(first);
    expect(nextFocus(items, outside, true)).toBe(last);
    expect(nextFocus([], outside, false)).toBeNull();
  });
});
