// The rules of a commenter's comments (./mailbox.ts), without the browser:
// how a Kurviq comment travels in a Drive comment (the mailbox), how an
// editor's Kurviq checks a commenter's changes (commenterRefusal of
// scenes-mcp/sceneComments.mjs) and who wrote a Drive comment.

import { authorKey, cleanComment, commenterRefusal } from "../../../scenes-mcp/sceneComments.mjs";

import type { SceneComment } from "../../../scenes-mcp/sceneComments.mjs";

/** the mark before the JSON in a Drive comment that carries Kurviq comments */
export const MAILBOX_MARK = "[kurviq-comments:v1]";
/** what people see of it in Google Drive */
export const MAILBOX_INTRO =
  "A comment on this Kurviq scene, waiting for an editor: Kurviq takes it into the scene when an editor opens it (please leave it as it is).";
/** a mailbox comment's length at most (Drive's limit isn't documented: this stays well below what was seen to work) */
export const MAILBOX_MAX = 16_000;

/** the text of a Drive comment carrying these comments; throws when it would be too long */
export const mailboxText = (comments: SceneComment[]) => {
  const text = `${MAILBOX_INTRO}\n\n${MAILBOX_MARK}${JSON.stringify(comments)}`;
  if (text.length > MAILBOX_MAX) {
    throw new Error("This comment is too long to leave for an editor: shorten it");
  }
  return text;
};

/** the Kurviq comments a Drive comment carries (checked), or null when it carries none */
export const readMailbox = (content: string | undefined): SceneComment[] | null => {
  const at = content?.indexOf(MAILBOX_MARK) ?? -1;
  if (!content || at < 0) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(content.slice(at + MAILBOX_MARK.length));
  } catch {
    return null;
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    return null;
  }
  const comments = raw.map((entry) => cleanComment(entry));
  return comments.every((comment): comment is SceneComment => comment !== null) ? comments : null;
};

export type CheckedOps = { comments: SceneComment[] } | { refused: string };

/**
 * A commenter's changes, checked against the scene's comments: each one a
 * comment as the commenter sends it (new, or changed), allowed by
 * commenterRefusal for their key. All or nothing: the first refusal answers.
 * A new comment is recorded under the name the editor's side knows them by.
 */
export const checkCommenterOps = (current: SceneComment[], ops: unknown[], author: { name: string; key: string }): CheckedOps => {
  if (!Array.isArray(ops) || ops.length === 0) {
    return { refused: "no comments" };
  }
  const byId = new Map(current.map((comment) => [comment.id, comment]));
  const out: SceneComment[] = [];
  for (const op of ops) {
    const after = cleanComment(op);
    const before = after ? byId.get(after.id) ?? null : null;
    const refusal = commenterRefusal(before, after, author.key);
    if (refusal || !after) {
      return { refused: refusal ?? "not a comment" };
    }
    const recorded = before || !author.name ? after : { ...after, by: { ...after.by, name: author.name } };
    byId.set(recorded.id, recorded);
    out.push(recorded);
  }
  return { comments: out };
};

/** a person with access to the file, as Drive lists them to its editors */
export type Person = { type: string; emailAddress?: string; displayName?: string; deleted?: boolean };

/**
 * Who wrote a Drive comment, with the key their comments carry (authorKey of
 * their address). Drive names a comment's author but mostly leaves out the
 * address: then the one person with access of that name gives it. Null: not
 * known for sure (nobody of that name, or several).
 */
export const mailboxAuthor = async (
  author: { displayName?: string; emailAddress?: string } | undefined,
  people: Person[],
): Promise<{ name: string; email: string; key: string } | null> => {
  const name = author?.displayName?.trim() ?? "";
  let email = author?.emailAddress?.trim().toLowerCase() ?? "";
  if (!email) {
    const matches = name ? people.filter((person) => person.type === "user" && !person.deleted && !!person.emailAddress && person.displayName?.trim() === name) : [];
    if (matches.length !== 1) {
      return null;
    }
    email = matches[0].emailAddress!.toLowerCase();
  }
  return { name: name || email.split("@")[0], email, key: await authorKey(email) };
};

/** the commenter's comments from the mailbox that the scene's file doesn't have yet (in that version or a newer one) */
export const stillWaiting = (waiting: SceneComment[], inFile: SceneComment[]) => {
  const stored = new Map(inFile.map((comment) => [comment.id, comment.u]));
  return waiting.filter((comment) => (stored.get(comment.id) ?? -1) < comment.u);
};
