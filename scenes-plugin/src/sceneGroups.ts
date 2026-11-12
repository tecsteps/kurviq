// Groups of the scene list that fold: this tab's scenes ("My scenes", open
// unless folded) and each shared folder (folded unless opened). The choice is
// remembered in this browser per group.

export const GROUPS_KEY = "kurviq-scene-groups";

/** the key of this tab's own group, and of a shared folder's */
export const ownGroup = (folderId: string | null) => (folderId ? `here:${folderId}` : "own");
export const folderGroup = (folderId: string) => `folder:${folderId}`;

export type GroupState = Record<string, boolean>;

export const readGroups = (raw: string | null): GroupState => {
  try {
    const value = JSON.parse(raw || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
  } catch {
    return {};
  }
};

/** open? this tab's group by default, shared folders not */
export const isOpen = (state: GroupState, key: string) => state[key] ?? !key.startsWith("folder:");

export const toggled = (state: GroupState, key: string): GroupState => ({ ...state, [key]: !isOpen(state, key) });
