// A Drive scene's own key (AES-GCM, 256 bit), kept on its Drive file
// (appProperties.kurviqKey = "<keyId>.<fileId>.<base64 key>"): the tabs
// encrypt everything they send through the scene's relay with it
// (docs/relay/CONCEPT.md), so the relay forwards what it can't read. Only
// people Drive lets read the file get the key.
//
// Pure WebCrypto: runs in the browser, the Worker and node (tests).

export const KEY_PROPERTY = "kurviqKey";

/**
 * The mark of a file the retired live sync saved (appProperties.kurviqSync):
 * the drain of its old scene object removes it (online/worker/scene.ts).
 */
export const LIVE_MARKER = "do-1";

const IV_BYTES = 12;

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

/** a key's id: the first 12 characters of the base64url SHA-256 of its 32 bytes */
export const keyIdOf = async (keyBase64: string) => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", fromBase64(keyBase64)));
  return toBase64(digest).replaceAll("+", "-").replaceAll("/", "_").slice(0, 12);
};

export const keyProperty = (keyId: string, fileId: string, keyBase64: string) => `${keyId}.${fileId}.${keyBase64}`;

/** a new random key (base64 of 32 bytes) */
export const newKey = () => toBase64(crypto.getRandomValues(new Uint8Array(32)));

/**
 * The property's parts, or null (also when its key id is not the key's own);
 * `copy`: made for another file (a copy in Drive needs its own key)
 */
export const parseKeyProperty = async (value: string | null | undefined, fileId: string) => {
  const match = /^([A-Za-z0-9_-]{12})\.([A-Za-z0-9_-]{10,200})\.([A-Za-z0-9+/]{43}=)$/.exec(value ?? "");
  if (!match?.[3] || (await keyIdOf(match[3])) !== match[1]) {
    return null;
  }
  return { keyId: match[1], fileId: match[2], key: match[3], copy: match[2] !== fileId };
};

export type SceneKey = { key: CryptoKey; keyId: string; fileId: string };

/** the scene's key as the ticket hands it out (base64 of 32 bytes) */
export const importSceneKey = async (base64: string, keyId: string, fileId: string): Promise<SceneKey> => {
  const raw = fromBase64(base64);
  if (raw.length !== 32) {
    throw new Error("The scene's key is not a 256-bit key");
  }
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  return { key, keyId, fileId };
};

/** additional data: a payload is bound to its scene, its key and its kind (it can't be replayed as another) */
const aad = (scene: SceneKey, kind: string) => new TextEncoder().encode(`kurviq-relay:${scene.fileId}:${scene.keyId}:${kind}`);

/** any JSON value -> base64(IV + ciphertext) */
export const sealPayload = async (scene: SceneKey, kind: string, value: unknown) => {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(scene, kind) }, scene.key, new TextEncoder().encode(JSON.stringify(value))),
  );
  const out = new Uint8Array(IV_BYTES + cipher.length);
  out.set(iv);
  out.set(cipher, IV_BYTES);
  return toBase64(out);
};

/** base64(IV + ciphertext) -> the JSON value; throws if it was changed or belongs elsewhere */
export const openPayload = async (scene: SceneKey, kind: string, body: string): Promise<any> => {
  const bytes = fromBase64(body);
  if (bytes.length <= IV_BYTES) {
    throw new Error("Encrypted payload too short");
  }
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.subarray(0, IV_BYTES), additionalData: aad(scene, kind) },
    scene.key,
    bytes.subarray(IV_BYTES),
  );
  return JSON.parse(new TextDecoder().decode(plain));
};
