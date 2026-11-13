// The rules of a database scene's real time (./live.ts), without the editor:
// which elements of the canvas the database doesn't have yet, which of the
// database's win over the canvas's, and which comments changed. The same
// element changed in two places: the higher version wins, the same version:
// the lower nonce (Excalidraw's own rule, as in its collaboration), so every
// tab and the database (./schema.sql kurviq_newer_element) agree.

export type Versioned = { id: string; version: number; versionNonce: number; isDeleted?: boolean };

/** the version of an element a side has: "version:nonce" */
export const stamp = (element: Pick<Versioned, "version" | "versionNonce">) => `${element.version}:${element.versionNonce}`;

/** whether `incoming` replaces `current` (none: it does) */
export const isNewer = (incoming: Pick<Versioned, "version" | "versionNonce">, current: Pick<Versioned, "version" | "versionNonce"> | undefined) =>
  !current || incoming.version > current.version || (incoming.version === current.version && incoming.versionNonce < current.versionNonce);

const parseStamp = (value: string) => {
  const at = value.indexOf(":");
  return { version: Number(value.slice(0, at)), versionNonce: Number(value.slice(at + 1)) };
};

/**
 * The canvas's elements the database doesn't have (in this version): new
 * ones and newer ones. `known`: id → the stamp the database has.
 */
export const localChanges = <T extends Versioned>(elements: readonly T[], known: ReadonlyMap<string, string>) =>
  elements.filter((element) => {
    const there = known.get(element.id);
    return there === undefined ? !element.isDeleted : there !== stamp(element) && isNewer(element, parseStamp(there));
  });

/**
 * Elements the database has that are gone from the canvas altogether (a
 * whole scene put on it, e.g. by an agent's edit, has no deleted ones): they
 * are deleted there, as a newer version.
 */
export const vanished = (elements: readonly Versioned[], known: ReadonlyMap<string, string>, deletedThere: ReadonlySet<string>) => {
  const here = new Set(elements.map((element) => element.id));
  return [...known.keys()].filter((id) => !here.has(id) && !deletedThere.has(id));
};

/** a deleted version of an element (for one that vanished from the canvas) */
export const deletedVersion = (data: Record<string, any>): Record<string, any> => ({
  ...data,
  isDeleted: true,
  version: (Number(data.version) || 1) + 1,
  versionNonce: crypto.getRandomValues(new Uint32Array(1))[0] >>> 1,
  updated: Date.now(),
});

/** the database's elements that win over the canvas's (newer, or not on the canvas) */
export const remoteWinners = <T extends Versioned>(remote: readonly T[], canvas: ReadonlyMap<string, Versioned>) =>
  remote.filter((element) => isNewer(element, canvas.get(element.id)));

/** comments changed here since the database had them: `known` id → its u there */
export const changedComments = <T extends { id: string; u: number }>(comments: readonly T[], known: ReadonlyMap<string, number>) =>
  comments.filter((comment) => (known.get(comment.id) ?? -1) < comment.u);

/** the scene settings that travel with the scene (background, grid, presentation, fonts) as one key */
export const settingsKey = (appState: Record<string, any>, fonts: unknown) =>
  JSON.stringify([
    appState.viewBackgroundColor ?? null,
    appState.gridSize ?? null,
    appState.gridStep ?? null,
    appState.gridModeEnabled ?? null,
    appState.kurviqPresentation ?? null,
    appState.kurviqPresentationAt ?? null,
    fonts ?? null,
  ]);

/** a person's color on the canvas, from their address (the same in every tab) */
export const colorOf = (seed: string) => {
  let hash = 0;
  for (const char of seed) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360;
  }
  return `hsl(${hash}, 70%, 45%)`;
};

type Role = "owner" | "editor" | "commenter" | "viewer";

export const canEdit = (role: Role | null) => role === "owner" || role === "editor";

/** what the controller shows for a role on the open scene (null: may edit) */
export const accessOf = (role: Role | null, publicScene: boolean) => {
  if (canEdit(role)) {
    return null;
  }
  if (role === "commenter") {
    return { readOnly: "You can comment on this scene, not change it", comment: true };
  }
  if (role === "viewer" || publicScene) {
    return { readOnly: "You can view this scene, not change it", comment: false };
  }
  return { readOnly: "You have no access to this scene (any more)", comment: false };
};
