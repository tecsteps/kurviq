import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FOLLOW_FRAMES, followEditor } from "../src/editorFollow";

let frames: (() => void)[] = [];
const runFrames = (n: number) => {
  for (let i = 0; i < n; i++) {
    const due = frames;
    frames = [];
    due.forEach((run) => run());
  }
};

beforeEach(() => {
  frames = [];
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (run: () => void) => {
    frames.push(run);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    frames = [];
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const editor = () => {
  const listeners = new Set<() => void>();
  const subscribe = (callback: () => void) => {
    listeners.add(callback);
    return () => listeners.delete(callback);
  };
  return { api: { onChange: subscribe, onScrollChange: subscribe }, change: () => listeners.forEach((run) => run()), listeners };
};

describe("following the canvas without a loop", () => {
  it("runs a few frames at the start and after each change, none while nothing happens", () => {
    const { api, change } = editor();
    const step = vi.fn();
    followEditor(() => api, step);
    runFrames(20);
    expect(step).toHaveBeenCalledTimes(FOLLOW_FRAMES);
    expect(frames).toHaveLength(0);
    change();
    change(); // two changes in one frame: one burst
    runFrames(20);
    expect(step).toHaveBeenCalledTimes(2 * FOLLOW_FRAMES);
  });

  it("waits for the editor, and stops for good", () => {
    let api: ReturnType<typeof editor>["api"] | null = null;
    const followed = editor();
    const step = vi.fn();
    const stop = followEditor(() => api, step);
    runFrames(5);
    expect(step).not.toHaveBeenCalled();
    api = followed.api;
    vi.advanceTimersByTime(300);
    runFrames(20);
    expect(step).toHaveBeenCalledTimes(FOLLOW_FRAMES);
    stop();
    expect(followed.listeners.size).toBe(0);
    followed.change();
    runFrames(20);
    expect(step).toHaveBeenCalledTimes(FOLLOW_FRAMES);
  });
});
