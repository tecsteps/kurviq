// The Drive client's small pure parts: the MD5 that names every scene version,
// the parts receiver of the agent link, the byline's byte limit and the slugs
// of links and short names.
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { BYLINE_MAX_BYTES, cleanByline, cutBytes } from "../src/online/driveNames";
import { createReceiver, sendMessage } from "../src/online/frames";
import { md5 } from "../src/online/md5";
import { slugify, toPubName } from "../src/online/pubName";

const bytes = (text: string) => new TextEncoder().encode(text);
const nodeMd5 = (data: Uint8Array) => createHash("md5").update(data).digest("hex");

describe("md5 (Drive's md5Checksum)", () => {
  it("matches the RFC 1321 test suite", () => {
    expect(md5(bytes(""))).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5(bytes("a"))).toBe("0cc175b9c0f1b6a831c399e269772661");
    expect(md5(bytes("abc"))).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(md5(bytes("message digest"))).toBe("f96b697d7cb7938d525a2f31aaf161d0");
    expect(md5(bytes("abcdefghijklmnopqrstuvwxyz"))).toBe("c3fcd3d76192e4007dfb496cca67e13b");
    expect(md5(bytes("12345678901234567890123456789012345678901234567890123456789012345678901234567890"))).toBe(
      "57edf4a22be3c955ac49da2e2107b67a",
    );
  });

  it("is right around the padding boundaries and for multi-byte text", () => {
    for (const length of [55, 56, 57, 63, 64, 65, 119, 120, 128]) {
      const data = new Uint8Array(length).map((_, i) => (i * 31 + 7) & 0xff);
      expect(md5(data)).toBe(nodeMd5(data));
    }
    const text = bytes("Größe: 東京 🎨 ".repeat(20));
    expect(md5(text)).toBe(nodeMd5(text));
  });
});

describe("the parts receiver (big messages on the agent link)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("completes a message whose parts arrive slowly but steadily (more than 2 minutes in all)", () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const message = { type: "state", text: "x".repeat(256 * 1024 * 3 + 10) };
    sendMessage({ send: (data) => sent.push(data) }, message);
    expect(sent).toHaveLength(4);
    const receive = createReceiver();
    let result = null;
    for (const part of sent) {
      result = receive(part);
      vi.advanceTimersByTime(100_000);
    }
    expect(result).toEqual(message);
  });

  it("drops a message that stopped arriving", () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    sendMessage({ send: (data) => sent.push(data) }, { text: "y".repeat(256 * 1024 + 1) });
    const receive = createReceiver();
    expect(receive(sent[0])).toBeNull();
    vi.advanceTimersByTime(121_000);
    // another message's part clears it; its own second part then starts over and never completes
    receive(JSON.stringify({ type: "part", id: "other", i: 0, total: 2, data: "{" }));
    expect(receive(sent[1])).toBeNull();
  });
});

describe("the byline (a Drive property: 124 bytes for key and value)", () => {
  it("cuts by UTF-8 bytes, never inside a character", () => {
    expect(BYLINE_MAX_BYTES).toBe(116);
    expect(cutBytes("abc", 2)).toBe("ab");
    expect(cutBytes("äöü", 5)).toBe("äö");
    expect(cutBytes("🎨🎨", 5)).toBe("🎨");
    const cjk = "東".repeat(60);
    expect(new TextEncoder().encode(cleanByline(cjk)).length).toBeLessThanOrEqual(116);
    expect(cleanByline(cjk)).toBe("東".repeat(38));
  });

  it("drops control characters and spaces around it", () => {
    expect(cleanByline("  Ada\u0000 Lovelace\n ")).toBe("Ada Lovelace");
    expect(cleanByline(42)).toBe("");
  });
});

describe("slugs of links and short names", () => {
  it("turns a name into letters, digits and single hyphens", () => {
    expect(toPubName("Öredev 2026!")).toBe("oredev-2026");
    expect(slugify("  Straße / Ørsted  ", 60)).toBe("strasse-orsted");
    expect(slugify("a".repeat(80), 60)).toHaveLength(60);
  });

  it("keeps a hyphen at the end while typing", () => {
    expect(slugify("my talk ", 40, { keepTrailingHyphen: true })).toBe("my-talk-");
    expect(slugify("my--talk", 40)).toBe("my-talk");
    expect(slugify("-start", 40)).toBe("start");
  });
});
