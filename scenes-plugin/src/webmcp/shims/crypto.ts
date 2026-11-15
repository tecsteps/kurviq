// node:crypto for scenes-mcp/media.mjs in the browser (../bridge.ts): only
// what it uses, createHash("sha1") → hex, synchronously (Web Crypto is
// async). The hash names an image file (Excalidraw's file id), it protects
// nothing.

const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));

const encoder = new TextEncoder();

const toBytes = (data: Uint8Array | string) => (typeof data === "string" ? encoder.encode(data) : data);

/** SHA-1 of the bytes (FIPS 180-4) */
export const sha1 = (bytes: Uint8Array): Uint8Array => {
  const bitLength = bytes.length * 8;
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 2 ** 32));
  view.setUint32(padded.length - 4, bitLength >>> 0);
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Uint32Array(80);
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(block + i * 4);
    }
    for (let i = 16; i < 80; i++) {
      w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }
    let [a, b, c, d, e] = h;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const t = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30) >>> 0;
      b = a;
      a = t;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  h.forEach((word, i) => outView.setUint32(i * 4, word));
  return out;
};

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export const createHash = (algorithm: string) => {
  if (algorithm.toLowerCase() !== "sha1") {
    throw new Error(`createHash("${algorithm}") is not available in the browser`);
  }
  const parts: Uint8Array[] = [];
  const hash = {
    update(data: Uint8Array | string) {
      parts.push(toBytes(data));
      return hash;
    },
    digest(encoding: "hex") {
      if (encoding !== "hex") {
        throw new Error(`digest("${encoding}") is not available in the browser`);
      }
      const all = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
      let offset = 0;
      for (const part of parts) {
        all.set(part, offset);
        offset += part.length;
      }
      return hex(sha1(all));
    },
  };
  return hash;
};
