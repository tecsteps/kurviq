// A scene link (kurviq.com/<name>) names a scene of whoever opens it. When
// the tab's scenes have none of that name, the link may still mean a scene
// the person has elsewhere: in a Kurviq folder shared with them (a colleague
// sent the link of a scene in their shared folder), or, from a shared
// folder's tab, among their own scenes. Only if neither has it, it is a new
// scene.

export type LinkFolder = { folderId: string; role: "writer" | "reader"; scenes: { name: string }[] };

export type LinkTarget = { kind: "own" } | { kind: "folder"; folderId: string } | null;

/**
 * Where a name the tab's scenes don't have lives: `own` (the user's own
 * scenes, only asked from a shared folder's tab: currentFolder set), else
 * the first shared folder with a scene of that name (one the user may edit
 * first), never the folder the tab already shows.
 */
export const linkTargetOf = (
  name: string,
  folders: LinkFolder[],
  ownNames: string[],
  currentFolder: string | null,
): LinkTarget => {
  if (currentFolder && ownNames.includes(name)) {
    return { kind: "own" };
  }
  const holders = folders.filter(
    (folder) => folder.folderId !== currentFolder && folder.scenes.some((scene) => scene.name === name),
  );
  const best = holders.find((folder) => folder.role === "writer") ?? holders[0];
  return best ? { kind: "folder", folderId: best.folderId } : null;
};
