import { describe, expect, it } from "vitest";

import { decodeEvent, decryptJson, encodeEvent, encryptJson, fromBase64, importSceneKey, toBase64 } from "../src/online/liveCrypto";
import { aadOf, readableOf } from "../src/online/liveProtocol";

const keyBase64 = () => toBase64(crypto.getRandomValues(new Uint8Array(32)));

describe("scene key encryption", () => {
  it("round trip of any value, with the event bound in", async () => {
    const key = await importSceneKey(keyBase64(), "kid", "file1");
    const c = await encryptJson(key, "el", "el1", { text: "hello", n: [1, 2] });
    expect(fromBase64(c).length).toBeGreaterThan(12);
    expect(await decryptJson(key, "el", "el1", c)).toEqual({ text: "hello", n: [1, 2] });
    // moved to another element, scene or key id: refused
    await expect(decryptJson(key, "el", "el2", c)).rejects.toThrow();
    await expect(decryptJson(key, "file", "el1", c)).rejects.toThrow(); // another kind of event
    await expect(decryptJson({ ...key, fileId: "file2" }, "el", "el1", c)).rejects.toThrow();
    await expect(decryptJson({ ...key, keyId: "other" }, "el", "el1", c)).rejects.toThrow();
    expect(aadOf("f", "el", "e", "k")).toBe("f:el:e:k");
  });

  it("each event its own IV", async () => {
    const key = await importSceneKey(keyBase64(), "kid", "file1");
    const [a, b] = [await encryptJson(key, "set", "x", 1), await encryptJson(key, "set", "x", 1)];
    expect(a).not.toBe(b);
  });

  it("elements: readable part in clear, the rest encrypted; the DO's stamp wins on decode", async () => {
    const key = await importSceneKey(keyBase64(), "kid", "file1");
    const element = {
      id: "r1",
      type: "rectangle",
      version: 3,
      versionNonce: 77,
      isDeleted: false,
      index: "a0",
      x: 10,
      strokeColor: "#f00",
      boundElements: [{ id: "t1", type: "text" }],
      frameId: null,
      groupIds: ["g1"],
    };
    const event = await encodeEvent(key, "el", element.id, element, { v: 2, n: 5 });
    expect(event.r).toEqual(readableOf(element));
    expect(event.c).not.toContain("#f00");
    // the DO re-stamps and repairs the index: the readable part changes, the cipher stays
    const restamped = { ...event, r: { ...event.r!, version: 4, versionNonce: 99, index: "a1" } };
    const decoded = await decodeEvent(key, restamped);
    expect(decoded).toMatchObject({ ...element, version: 4, versionNonce: 99, index: "a1" });
    // a deletion the DO made itself: no cipher, the previous content deleted
    const deletion = { ...restamped, c: "", r: { ...restamped.r, isDeleted: true, version: 5 } };
    expect(await decodeEvent(key, deletion, decoded)).toMatchObject({ x: 10, isDeleted: true, version: 5 });
    expect(await decodeEvent(key, deletion)).toBeNull();
  });

  it("refuses a key that is not 256 bits", async () => {
    await expect(importSceneKey(toBase64(new Uint8Array(16)), "k", "f")).rejects.toThrow();
  });

  it("base64 of large data (no call stack overflow)", () => {
    const big = crypto.getRandomValues(new Uint8Array(65536)).map((byte, i) => (byte + i) % 256);
    const doubled = new Uint8Array(big.length * 20);
    for (let i = 0; i < 20; i++) {
      doubled.set(big, i * big.length);
    }
    expect(fromBase64(toBase64(doubled))).toEqual(doubled);
  });
});

describe("font ids the DO changed", () => {
  it("the readable fontFamily is in force", async () => {
    const key = await importSceneKey(keyBase64(), "kid", "file1");
    const text = { id: "t", type: "text", version: 1, versionNonce: 1, isDeleted: false, index: "a0", fontFamily: 2001, text: "x" };
    const event = await encodeEvent(key, "el", "t", text, null);
    const remapped = { ...event, r: { ...event.r!, fontFamily: 2002 } };
    expect((await decodeEvent(key, remapped)).fontFamily).toBe(2002);
  });
});
