// Comments by Drive's commenters (people who may comment on a scene but not
// edit it). They can't write the scene's file, so an editor's Kurviq writes
// their comments for them, checked with the commenter rules (./mailboxRules.ts)
// and recorded as theirs. Nothing passes through Kurviq's servers' storage:
//  - an editor holds the pen: the comment goes through the relay
//    (../online/pen.ts sendCommenterOps) and the holder's tab applies it at
//    once (handleCommenterOps, registered with onCommenterOps);
//  - else Drive's own comments on the file are the mailbox: the commenter's
//    tab leaves a Drive comment carrying the Kurviq comment; the next editor's
//    Kurviq that has the scene open takes it in (when it opens the scene and
//    every minute after), saves, and deletes the Drive comment (refused ones
//    too, so nothing is tried again and again). Until then the commenter sees
//    their comment "waiting for an editor".

import { commentsOf, mergeComments } from "../../../scenes-mcp/sceneComments.mjs";
import { scenesController } from "../controller";
import { connection, createDriveComment, listDriveComments, listPermissions, removeDriveComment } from "../online/drive";
import { onCommenterOps, penState, sendCommenterOps } from "../online/pen";
import { checkCommenterOps, mailboxAuthor, mailboxText, readMailbox, stillWaiting } from "./mailboxRules";
import { commentStore } from "./store";

import type { SceneComment } from "../../../scenes-mcp/sceneComments.mjs";
import type { DriveComment } from "../online/drive";
import type { CommenterAuthor, CommenterOpsResult } from "../online/pen";
import type { CommentSlot } from "./store";

/** how often an editor's Kurviq looks into the open scene's mailbox */
const MAILBOX_CHECK_MS = 60_000;
/** after a scene opened: a moment for it to load before the first look */
const AFTER_OPEN_MS = 3_000;

// -----------------------------------------------------------------------------
// the editor's side
// -----------------------------------------------------------------------------

/** may this tab write comments into its open scene for others (it can save it, and no other tab holds the pen) */
const editorMayApply = () => {
  const state = scenesController.getState();
  const me = penState().me;
  return (
    !!scenesController.getApi() &&
    state.current !== null &&
    state.busy !== "loading" &&
    !state.sync.readOnly &&
    !scenesController.isLocalOnly(state.current) &&
    me !== "viewer" &&
    me !== "commenter"
  );
};

type Applied = CommenterOpsResult | "later";

/** a commenter's comments into the editor's open scene (saved as the scene saves) */
const applyAsEditor = (ops: unknown[], author: { name: string; key: string }): Applied => {
  if (!editorMayApply()) {
    return "later";
  }
  const checked = checkCommenterOps(commentStore.editorList(), ops, author);
  if ("refused" in checked) {
    return checked;
  }
  for (const comment of checked.comments) {
    if (!commentStore.change(comment, "editor")) {
      return "later";
    }
  }
  return "applied";
};

/** the pen holder's tab: a commenter's comments that came through the relay */
export const handleCommenterOps = (ops: unknown[], author: CommenterAuthor): Promise<CommenterOpsResult> => {
  const result = applyAsEditor(ops, author);
  return Promise.resolve(result === "later" ? { refused: "the editor's scene is not ready: try again in a moment" } : result);
};

let taking = false;

/** one Drive comment of the mailbox: applied, refused (both: it goes) or "later" (it stays) */
const takeOne = async (ops: SceneComment[], author: { displayName?: string; emailAddress?: string }, people: Awaited<ReturnType<typeof listPermissions>>) => {
  const who = await mailboxAuthor(author, people);
  const result: Applied = who ? applyAsEditor(ops, who) : { refused: "its author could not be told apart from others of the same name" };
  if (typeof result === "object") {
    console.info(`[comments] a commenter's comment from Google Drive was not taken in: ${result.refused}`);
  }
  return result;
};

/** the Drive comments of a file that carry Kurviq comments, not taken care of yet */
const mailOf = async (fileId: string) =>
  (await listDriveComments(fileId))
    .filter((comment) => !comment.resolved)
    .map((comment) => ({ comment, ops: readMailbox(comment.content) }))
    .filter((entry): entry is { comment: DriveComment; ops: SceneComment[] } => entry.ops !== null);

/** the mailbox's comments into the open scene, in order: those taken care of (applied or refused), and whether any was applied */
const takeAll = async (name: string, mail: Awaited<ReturnType<typeof mailOf>>, people: Awaited<ReturnType<typeof listPermissions>>) => {
  const taken: string[] = [];
  let applied = false;
  for (const { comment, ops } of mail) {
    // another scene opened meanwhile: the next look takes the rest
    if (scenesController.getState().current !== name) {
      break;
    }
    const result = await takeOne(ops, comment.author, people); // NOSONAR S9382: in order on purpose (each one checked against the comments before it)
    if (result === "later") {
      break;
    }
    applied ||= result === "applied";
    taken.push(comment.id);
  }
  return { taken, applied };
};

/** the comments are in the Drive file (saved now; with auto-sync off: once the user saves) */
const savedToDrive = async (name: string) => (await scenesController.flush(name)).status === "synced";

/**
 * The open scene's mailbox: Drive comments carrying Kurviq comments go into
 * the scene, which is saved, then they are deleted. Nothing happens while
 * this tab may not write the scene (another tab holds the pen, read only).
 */
export const takeMailbox = async () => {
  const name = scenesController.getState().current;
  const fileId = scenesController.fileIdOf(name);
  if (taking || !name || !fileId || !connection.isActive() || !editorMayApply()) {
    return;
  }
  taking = true;
  try {
    const mail = await mailOf(fileId);
    if (!mail.length) {
      return;
    }
    const { taken, applied } = await takeAll(name, mail, await listPermissions(fileId).catch(() => []));
    // the comments are in the file before their Drive comments go
    if (applied && !(await savedToDrive(name))) {
      return;
    }
    await Promise.all(taken.map((id) => removeDriveComment(fileId, id)));
  } catch (error) {
    console.warn("[comments] the scene's comments in Google Drive could not be taken in", error);
  } finally {
    taking = false;
  }
};

/** an editor's tab: takes the mailbox in when a scene opens and every minute; answers the relay. Returns the stop. */
export const startCommentMailbox = () => {
  const offRelay = onCommenterOps(handleCommenterOps);
  let current = scenesController.getState().current;
  let soon = 0;
  const look = () => {
    if (document.visibilityState === "visible") {
      void takeMailbox(); // takeMailbox catches its own errors
    }
  };
  const offScenes = scenesController.subscribe(() => {
    const next = scenesController.getState().current;
    if (next !== current) {
      current = next;
      clearTimeout(soon);
      soon = window.setTimeout(look, AFTER_OPEN_MS);
    }
  });
  soon = window.setTimeout(look, AFTER_OPEN_MS);
  const every = window.setInterval(look, MAILBOX_CHECK_MS);
  return () => {
    offRelay();
    offScenes();
    clearTimeout(soon);
    clearInterval(every);
  };
};

// -----------------------------------------------------------------------------
// the commenter's side
// -----------------------------------------------------------------------------

/** a commenter's change: to the pen holder, else into the file's Drive comments ("waiting") */
export const sendAsCommenter = async (fileId: string, comment: SceneComment): Promise<"sent" | "waiting"> => {
  // the relay is the one of the editor's open scene: only for that scene
  const relayed = scenesController.fileIdOf(scenesController.getState().current) === fileId;
  if (relayed && (await sendCommenterOps([comment])) === "sent") {
    return "sent";
  }
  await createDriveComment(fileId, mailboxText([comment]));
  return "waiting";
};

/**
 * The writer of a slot whose scene this person may comment on but not save:
 * the comment shows at once and goes out after; how it went shows on it
 * ("waiting for an editor") or as the comments' problem.
 */
export const commenterWriter = (fileId: string) => (comment: SceneComment) => {
  try {
    mailboxText([comment]);
  } catch (error: any) {
    commentStore.setProblem(error.message);
    return false;
  }
  commentStore.setProblem(null);
  sendAsCommenter(fileId, comment).then(
    (how) => commentStore.setPending([comment], how === "waiting"),
    (error) => commentStore.setProblem(`Your comment could not be sent: ${error?.message ?? error}`),
  );
  return true;
};

/** the editor's open scene, when this tab is only a commenter on it (the pen says so): where its comments go */
export const editorCommenterFile = () => (penState().me === "commenter" ? scenesController.fileIdOf(scenesController.getState().current) ?? null : null);

/**
 * A slot's comments from the scene's file, with this person's comments that
 * still wait in Drive's comments for an editor (marked "waiting")
 */
export const loadWithWaiting = async (fileId: string, inFile: unknown, slot: CommentSlot) => {
  const stored = commentsOf(inFile);
  commentStore.load(stored, slot);
  let waiting: SceneComment[] = [];
  try {
    const mine = (await listDriveComments(fileId)).filter((comment) => comment.author?.me && !comment.resolved);
    waiting = stillWaiting(mine.flatMap((comment) => readMailbox(comment.content) ?? []), stored);
  } catch {
    // Drive didn't answer: the file's comments alone
  }
  if (waiting.length) {
    commentStore.load(mergeComments(stored, waiting), slot);
  }
  commentStore.replacePending(waiting);
};
