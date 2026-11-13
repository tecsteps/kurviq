// Who has a scene through its folder: a file in a shared Drive folder lists
// the folder's people among its own permissions (inherited). The share panel
// tells them apart from people added to the scene alone, and offers no
// "remove" for access the folder gives (Drive can't take it away on the file).

export type Grant = {
  type: "user" | "group" | "domain" | "anyone";
  role: string;
  emailAddress?: string;
  domain?: string;
};

/** how much a role allows (viewing < editing < owning) */
export const roleRank = (role: string) => {
  switch (role) {
    case "owner":
      return 3;
    case "writer":
    case "fileOrganizer":
    case "organizer":
      return 2;
    default:
      return 1;
  }
};

const sameGrantee = (a: Grant, b: Grant) => {
  if (a.type !== b.type) {
    return false;
  }
  switch (a.type) {
    case "anyone":
      return true;
    case "domain":
      return !!a.domain && a.domain.toLowerCase() === b.domain?.toLowerCase();
    default:
      return !!a.emailAddress && a.emailAddress.toLowerCase() === b.emailAddress?.toLowerCase();
  }
};

/**
 * A person's access to the scene compared with the folder's:
 * "direct" (added to this scene only), "folder" (all of it comes from the
 * folder), or "more" (the folder gives less, this scene more: folderRole).
 */
export type RowAccess = { kind: "direct" } | { kind: "folder" } | { kind: "more"; folderRole: string };

export const rowAccess = (grant: Grant, folder: Grant[]): RowAccess => {
  const fromFolder = folder.filter((entry) => sameGrantee(entry, grant));
  if (fromFolder.length === 0) {
    return { kind: "direct" };
  }
  let best = fromFolder[0];
  for (const entry of fromFolder) {
    if (roleRank(entry.role) > roleRank(best.role)) {
      best = entry;
    }
  }
  if (roleRank(best.role) >= roleRank(grant.role)) {
    return { kind: "folder" };
  }
  return { kind: "more", folderRole: best.role };
};

/** whom the folder is shared with, besides its owner (the note above the list) */
export const folderAudience = (folder: Grant[]) => {
  const others = folder.filter((entry) => entry.role !== "owner" && entry.type !== "anyone");
  return {
    count: others.length,
    editors: others.filter((entry) => roleRank(entry.role) >= 2).length,
    anyone: folder.some((entry) => entry.type === "anyone"),
  };
};

/** the note's text: "shared with 2 people" (domains count as one each) */
export const audienceText = ({ count, editors, anyone }: ReturnType<typeof folderAudience>) => {
  const people = count === 1 ? "1 person" : `${count} people`;
  const whom = [count > 0 ? people : null, anyone ? "anyone with its link" : null].filter(Boolean).join(" and ");
  if (!whom) {
    return null;
  }
  let what = "can open every scene in it";
  if (count > 0 && editors === count) {
    what = "can open and change every scene in it";
  }
  return { whom, what };
};

// -----------------------------------------------------------------------------
// the person a folder is shared with: what their Kurviq lists (nothing about
// the folder is kept on Kurviq's server; see drive.ts sharedFolders)
// -----------------------------------------------------------------------------

/** the owner's Kurviq notes its folder's number of scenes here (appProperties: private to Kurviq, no new version) */
export const FOLDER_COUNT_PROPERTY = "kurviqScenes";

/** the noted number of scenes (null: none noted) */
export const folderCountOf = (appProperties: Record<string, string> | undefined) => {
  const value = Number(appProperties?.[FOLDER_COUNT_PROPERTY]);
  return Number.isInteger(value) && value >= 0 ? value : null;
};

/** a folder this person picked: its noted scene count (null: not noted) */
export type PickedFolder = { id: string; name: string; owner: string; ownerEmail: string | null; canEdit: boolean; count: number | null };
/** a scene of someone else's that Kurviq may open for this person */
export type VisibleScene = {
  fileId: string;
  name: string;
  parents: string[];
  owner: string;
  ownerEmail: string | null;
  canEdit: boolean;
  modifiedTime: string | null;
};

export type FolderGroup = {
  folderId: string;
  name: string;
  owner: string;
  ownerEmail: string | null;
  role: "writer" | "reader";
  scenes: { name: string; fileId: string; modifiedTime: string | null }[];
  /** the folder itself was picked (else only some of its scenes were) */
  picked: boolean;
  /** scenes in it that need a pick before Kurviq can open them (0: none, or not known) */
  unseen: number;
};

const sceneEntry = (scene: VisibleScene) => ({ name: scene.name, fileId: scene.fileId, modifiedTime: scene.modifiedTime });
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

/**
 * The groups of the scene list for folders shared with this person: each
 * folder they picked, with the scenes Kurviq may open in it (all of them if
 * picking the folder grants its files, else those picked too) and how many
 * still need a pick (the owner's noted count minus those seen); then the
 * folders of scenes picked out of a folder that wasn't picked ("<owner>'s
 * folder"). Scenes shared one by one (`single`: Drive's "Shared with me")
 * stay out of the folder groups unless their folder was picked.
 */
export const groupSharedFolders = (folders: PickedFolder[], scenes: VisibleScene[], single: Set<string> = new Set()): FolderGroup[] => {
  const picked = new Map(folders.map((folder) => [folder.id, folder]));
  const groups = new Map<string, FolderGroup>();
  for (const folder of folders) {
    groups.set(folder.id, {
      folderId: folder.id,
      name: folder.name,
      owner: folder.owner,
      ownerEmail: folder.ownerEmail,
      role: folder.canEdit ? "writer" : "reader",
      scenes: [],
      picked: true,
      unseen: 0,
    });
  }
  for (const scene of scenes) {
    const parent = scene.parents.find((id) => picked.has(id)) ?? (single.has(scene.fileId) ? undefined : scene.parents[0]);
    if (!parent) {
      continue;
    }
    let group = groups.get(parent);
    if (!group) {
      group = { folderId: parent, name: `${scene.owner}'s folder`, owner: scene.owner, ownerEmail: scene.ownerEmail, role: "reader", scenes: [], picked: false, unseen: 0 };
      groups.set(parent, group);
    }
    group.scenes.push(sceneEntry(scene));
    // without the folder: they may edit in it if they may edit a scene of it
    if (!group.picked && scene.canEdit) {
      group.role = "writer";
    }
  }
  for (const group of groups.values()) {
    group.scenes.sort(byName);
    const count = picked.get(group.folderId)?.count ?? null;
    group.unseen = count === null ? 0 : Math.max(0, count - group.scenes.length);
  }
  return [...groups.values()].sort((a, b) => Number(b.picked) - Number(a.picked) || a.owner.localeCompare(b.owner) || a.name.localeCompare(b.name));
};

/** the folder group's notice: "3 new scenes in this folder" (null: nothing waits) */
export const unseenText = (unseen: number) => {
  if (unseen <= 0) {
    return null;
  }
  return unseen === 1 ? "1 new scene in this folder" : `${unseen} new scenes in this folder`;
};
