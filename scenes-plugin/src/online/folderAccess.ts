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
