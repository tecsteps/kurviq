// The controller's one queue (src/opQueue.ts): one operation at a time, opening a scene first.
import { describe, expect, it } from "vitest";

import { OpQueue } from "../src/opQueue";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the operation queue", () => {
  it("runs one operation at a time, in order", async () => {
    const queue = new OpQueue();
    const log: string[] = [];
    let release!: () => void;
    const first = queue.run(async () => {
      log.push("1 start");
      await new Promise<void>((resolve) => (release = resolve));
      log.push("1 end");
      return 1;
    });
    const second = queue.run(async () => {
      log.push("2");
      return 2;
    });
    await tick();
    expect(log).toEqual(["1 start"]);
    release();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(log).toEqual(["1 start", "1 end", "2"]);
  });

  it("a priority operation goes after the running one, before the waiting ones (and after earlier priority ones)", async () => {
    const queue = new OpQueue();
    const log: string[] = [];
    let release!: () => void;
    const running = queue.run(() => new Promise<void>((resolve) => (release = resolve)).then(() => void log.push("running")));
    const waiting = queue.run(async () => void log.push("sync step"));
    const open1 = queue.run(async () => void log.push("open 1"), { priority: true });
    const open2 = queue.run(async () => void log.push("open 2"), { priority: true });
    release();
    await Promise.all([running, waiting, open1, open2]);
    expect(log).toEqual(["running", "open 1", "open 2", "sync step"]);
  });

  it("a failing operation (thrown or rejected) doesn't stop the next one", async () => {
    const queue = new OpQueue();
    const thrown = queue.run(() => {
      throw new Error("sync throw");
    });
    const rejected = queue.run(() => Promise.reject(new Error("rejected")));
    const next = queue.run(async () => "ran");
    await expect(thrown).rejects.toThrow("sync throw");
    await expect(rejected).rejects.toThrow("rejected");
    expect(await next).toBe("ran");
  });
});
