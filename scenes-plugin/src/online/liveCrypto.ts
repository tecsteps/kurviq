// Live sync: what the scene's Durable Object stores is encrypted here, in the
// tab, with the scene's own key (kept on its Drive file, see
// docs/live-sync/CONCEPT.md "Encryption"). Each event is one AES-GCM message
// with its own random IV; scene, event and key are bound in as additional
// data, so a stored event can't be moved to another element or scene.
//
// Elements are split first (liveProtocol.ts): the readable part (ids,
// versions, references) stays in clear for the DO's checks, the rest is
// encrypted. Decrypting puts the readable part back on top, so the DO's
// re-stamped version is always the one in force.
//
// Pure WebCrypto: runs in the browser and in node (tests).

import { cleanComment, commentReadable, readableMatches } from "../../../scenes-mcp/sceneComments.mjs";
import { aadOf, contentOf, elementOf, readableOf } from "./liveProtocol";

import type { Base, EventKind, WireEvent } from "./liveProtocol";

const IV_BYTES = 12;

export type SceneKey = { key: CryptoKey; keyId: string; fileId: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** bytes -> base64 (in slices: a spread of megabytes overflows the call stack) */
export const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); // NOSONAR S7758: base64 converts bytes to code units, not Unicode code points
  }
  return btoa(binary);
};

export const fromBase64 = (text: string) => {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i); // NOSONAR S7758: base64 converts bytes to code units, not Unicode code points
  }
  return bytes;
};

/** the scene's key as the ticket hands it out (base64 of 32 bytes) */
export const importSceneKey = async (base64: string, keyId: string, fileId: string): Promise<SceneKey> => {
  const raw = fromBase64(base64);
  if (raw.length !== 32) {
    throw new Error("The scene's key is not a 256-bit key");
  }
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  return { key, keyId, fileId };
};

/** any JSON value -> base64(IV + ciphertext) */
export const encryptJson = async (scene: SceneKey, k: EventKind, eventId: string, value: unknown) => {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(aadOf(scene.fileId, k, eventId, scene.keyId)) },
      scene.key,
      encoder.encode(JSON.stringify(value)),
    ),
  );
  const out = new Uint8Array(IV_BYTES + cipher.length);
  out.set(iv);
  out.set(cipher, IV_BYTES);
  return toBase64(out);
};

/** base64(IV + ciphertext) -> the JSON value; throws if it was changed or belongs elsewhere */
export const decryptJson = async (scene: SceneKey, k: EventKind, eventId: string, c: string): Promise<any> => {
  const bytes = fromBase64(c);
  if (bytes.length <= IV_BYTES) {
    throw new Error("Encrypted event too short");
  }
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: bytes.subarray(0, IV_BYTES),
      additionalData: encoder.encode(aadOf(scene.fileId, k, eventId, scene.keyId)),
    },
    scene.key,
    bytes.subarray(IV_BYTES),
  );
  return JSON.parse(decoder.decode(plain));
};

/** one change as it goes over the wire: elements split into readable + encrypted, all else encrypted whole */
export const encodeEvent = async (
  scene: SceneKey,
  k: EventKind,
  id: string,
  value: any,
  base: Base | null,
  extra: Pick<WireEvent, "fontId"> = {},
): Promise<WireEvent> => {
  if (k === "el") {
    return { k, id, base, r: readableOf(value), c: await encryptJson(scene, k, id, contentOf(value)) };
  }
  if (k === "cmt") {
    return { k, id, base, cr: commentReadable(value), c: await encryptJson(scene, k, id, value) };
  }
  return { k, id, base, c: await encryptJson(scene, k, id, value), ...extra };
};

/**
 * An event as it came from the Durable Object -> the value (an element with
 * the DO's stamp). A deletion the DO made itself has no encrypted part: the
 * element is its previous content, deleted (null if the tab never had it).
 */
export const decodeEvent = async (scene: SceneKey, event: WireEvent, previous?: any): Promise<any> => {
  if (event.k === "el") {
    return decodeElement(scene, event, previous);
  }
  if (event.k === "cmt") {
    // a comment counts only as its readable part (checked by the server) describes it
    const comment = await decryptJson(scene, event.k, event.id, event.c);
    return comment?.id === event.id && readableMatches(comment, event.cr) ? cleanComment(comment) : null;
  }
  return decryptJson(scene, event.k, event.id, event.c);
};

/** an element event: readable part on top of the decrypted content (a DO deletion: the previous content, deleted) */
const decodeElement = async (scene: SceneKey, event: WireEvent, previous?: any) => {
  if (event.r?.id !== event.id) {
    throw new Error(`Element event ${event.id} without its readable part`);
  }
  let content;
  if (event.c === "") {
    content = previous ? contentOf(previous) : null;
  } else {
    content = await decryptJson(scene, event.k, event.id, event.c);
  }
  if (!content) {
    return null;
  }
  const el = elementOf(event.r, content);
  // the DO may have given the font another number (a clash): its readable copy is in force
  if (typeof event.r.fontFamily === "number" && typeof el.fontFamily === "number") {
    el.fontFamily = event.r.fontFamily;
  }
  return el;
};
