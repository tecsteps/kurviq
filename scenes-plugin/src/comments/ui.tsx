// Comments on the canvas: pins (the people of a thread as small avatars)
// next to the element a thread is about, a popover with the thread (reply,
// resolve, copy a link, edit or remove), a "Comments" button at the top right
// with the list of threads, and a placing mode for a new comment (click an
// element or a free spot). Who may do what is Google Drive's: editors
// everything, Drive's commenters their own comments and resolving, viewers
// read. Pins never show in presentations, exports or the public viewer.
// Data: ../../../scenes-mcp/sceneComments.mjs, the open scene's list: ./store.ts.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { sceneCoordsToViewportCoords, viewportCoordsToSceneCoords } from "@excalidraw/excalidraw";
import clsx from "clsx";

import { authorKey, changeStamp, commentId, pinFor, pinPosition, threadsOf, withoutDone } from "../../../scenes-mcp/sceneComments.mjs";
import { scenesController } from "../controller";
import { deck } from "../deck";
import { createStore } from "../externalStore";
import { liveSync } from "../online/liveSync";
import { connection, listPermissions } from "../online/drive";
import { usePresenter } from "../present";
import { commentStore } from "./store";

import type { CommentPin, CommentThread, SceneComment } from "../../../scenes-mcp/sceneComments.mjs";

import "./comments.scss";

// -----------------------------------------------------------------------------
// the UI's own state: placing a new comment, the open thread, the list
// -----------------------------------------------------------------------------

type UiState = {
  /** placing a new comment (the next click on the canvas) */
  placing: boolean;
  /** the thread whose popover is open */
  open: string | null;
  /** a new thread being written: where it goes */
  draft: CommentPin | null;
  /** resolved threads show as pins too */
  showResolved: boolean;
  /** the list of threads (top right) is open */
  list: boolean;
};

const uiStore = createStore<UiState>({ placing: false, open: null, draft: null, showResolved: false, list: false });
const setUi = (patch: Partial<UiState>) => uiStore.set({ ...uiStore.get(), ...patch });
const useUi = uiStore.use;

const useComments = () => useSyncExternalStore(commentStore.subscribe, commentStore.list);

/** a scene link that opens a thread: the page's own address with #comment=<thread> */
const threadLink = (id: string) => `${window.location.origin}${window.location.pathname}#comment=${encodeURIComponent(id)}`;

const linkedThread = () => {
  const match = /(?:^|[#&])comment=([\w-]+)/.exec(window.location.hash);
  return match ? match[1] : null;
};

// -----------------------------------------------------------------------------
// who is writing: name and key of the signed-in person (or "You" without sign-in)
// -----------------------------------------------------------------------------

type Me = { name: string; key: string; email: string | null };

const useMe = (): Me | null => {
  const user = useSyncExternalStore(connection.subscribe, () => connection.getState().user);
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    let alive = true;
    const email = user?.email ?? null;
    authorKey(email ?? "local")
      .then((key) => {
        if (alive) {
          setMe({ name: user?.name || email?.split("@")[0] || "You", key, email });
        }
      })
      .catch((error) => console.error("[comments] no author key", error));
    return () => {
      alive = false;
    };
  }, [user?.email, user?.name]);
  return me;
};

/** the shared viewer is on screen (comments there are the viewer's: see store.ts) */
const useViewer = () => useSyncExternalStore(commentStore.subscribe, () => commentStore.slot() === "viewer");

/** what this person may do with the comments on screen (Google Drive decides: see the controller and live sync) */
const usePermissions = () => {
  const state = useSyncExternalStore(scenesController.subscribe, scenesController.getState);
  const viewer = useViewer();
  const live = useSyncExternalStore(liveSync.subscribe, () => (viewer ? liveSync.viewer() : scenesController.liveCurrent()));
  if (viewer) {
    // the viewer: only Drive's commenters may write (live); nobody removes others' comments there
    return { canComment: !!live?.commentsAllowed(), canModerate: false };
  }
  const canComment = scenesController.canComment();
  // editors (not Drive's commenters) may also remove others' comments
  const canModerate = canComment && !live?.commentOnly && (!state.sync.readOnly || scenesController.isLocalOnly(state.current));
  return { canComment, canModerate };
};

/** the canvas on screen: the editor's, or the viewer's while it shows a scene (it borrows the deck) */
const canvasApi = () => deck.getApi() ?? scenesController.getApi();

// -----------------------------------------------------------------------------
// small pieces
// -----------------------------------------------------------------------------

const COLORS = ["#7048e8", "#1971c2", "#0c8599", "#2f9e44", "#e8590c", "#c2255c", "#5f3dc4", "#364fc7"];
const colorOf = (key: string) => COLORS[Number.parseInt(key.slice(0, 4), 16) % COLORS.length];
const initialOf = (name: string) => (name.trim()[0] ?? "?").toUpperCase();

const Avatar = ({ name, keyId, agent }: { name: string; keyId: string; agent?: boolean }) => (
  <span className="kq-cm-avatar" style={{ background: colorOf(keyId) }} title={agent ? `${name} (agent)` : name} aria-hidden>
    {initialOf(name)}
  </span>
);

const ago = (at: number) => {
  const seconds = Math.max(0, (Date.now() - at) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return days === 1 ? "a day ago" : `${days} days ago`;
  return new Date(at).toLocaleDateString();
};

const MENTION_RE = /@[\p{L}\p{N}][\p{L}\p{M}\p{N}._'-]*/gu;

/** text with @mentions highlighted */
const CommentText = ({ text }: { text: string }) => {
  // pieces with their place in the text (a stable key: the text doesn't change under them)
  const parts: Array<{ at: number; text: string; mention: boolean }> = [];
  let last = 0;
  for (const match of text.matchAll(MENTION_RE)) {
    const at = match.index ?? 0;
    parts.push({ at: last, text: text.slice(last, at), mention: false }, { at, text: match[0], mention: true });
    last = at + match[0].length;
  }
  parts.push({ at: last, text: text.slice(last), mention: false });
  return (
    <p className="kq-cm-text">
      {parts.map((part) =>
        part.mention ? (
          <span key={`m${part.at}`} className="kq-cm-mention">
            {part.text}
          </span>
        ) : (
          <span key={`t${part.at}`}>{part.text}</span>
        ),
      )}
    </p>
  );
};

const ICON = {
  prev: <path d="m12.5 4-6 6 6 6" />,
  next: <path d="m7.5 4 6 6-6 6" />,
  resolve: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="m7 10 2 2 4-4" />
    </>
  ),
  reopen: <path d="M4 10a6 6 0 1 0 2-4.5M4 4v3h3" />,
  link: (
    <>
      <path d="M8.5 11.5a3 3 0 0 0 4.2 0l2.5-2.5a3 3 0 0 0-4.2-4.2l-.8.8" />
      <path d="M11.5 8.5a3 3 0 0 0-4.2 0L4.8 11a3 3 0 0 0 4.2 4.2l.8-.8" />
    </>
  ),
  trash: <path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10" />,
  close: <path d="m5 5 10 10M15 5 5 15" />,
  more: (
    <>
      <circle cx="10" cy="4.5" r="1.2" fill="currentColor" />
      <circle cx="10" cy="10" r="1.2" fill="currentColor" />
      <circle cx="10" cy="15.5" r="1.2" fill="currentColor" />
    </>
  ),
  send: <path d="M10 16V4M5 9l5-5 5 5" />,
  comment: <path d="M4 4h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H9l-4 3v-3H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />,
};

const Icon = ({ name }: { name: keyof typeof ICON }) => (
  <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {ICON[name]}
  </svg>
);

/** where a menu opens: under its button, right-aligned with it (fixed: the page's coordinates) */
const menuSpot = (button: HTMLElement) => {
  const rect = button.getBoundingClientRect();
  return { right: Math.round(window.innerWidth - rect.right), top: Math.round(rect.bottom + 4) };
};

const IconButton = ({
  icon,
  label,
  onClick,
  disabled,
  active,
}: {
  icon: keyof typeof ICON;
  label: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  active?: boolean;
}) => (
  <button type="button" className={clsx("kq-cm-icon", { "kq-cm-icon--active": active })} title={label} aria-label={label} onClick={onClick} disabled={disabled}>
    <Icon name={icon} />
  </button>
);

// -----------------------------------------------------------------------------
// writing: a text box with @mentions (the people the scene is shared with, and its authors)
// -----------------------------------------------------------------------------

const usePeople = (comments: SceneComment[], viewer: boolean) => {
  const state = useSyncExternalStore(scenesController.subscribe, scenesController.getState);
  // the shared viewer shows another scene than the editor's: only the thread's authors there
  const fileId = viewer ? null : state.list.find((item) => item.name === state.current)?.fileId ?? null;
  const [shared, setShared] = useState<string[]>([]);
  useEffect(() => {
    setShared([]);
    if (!fileId) {
      return;
    }
    let alive = true;
    listPermissions(fileId)
      .then((permissions) => {
        if (alive) {
          setShared(permissions.map((p) => p.displayName || p.emailAddress?.split("@")[0] || "").filter(Boolean) as string[]);
        }
      })
      .catch(() => {}); // a commenter or viewer may not see who else has access
    return () => {
      alive = false;
    };
  }, [fileId]);
  return useMemo(() => [...new Set([...shared, ...comments.filter((c) => !c.gone).map((c) => c.by.name)])].sort((a, b) => a.localeCompare(b)), [shared, comments]);
};

const Composer = ({
  placeholder,
  initial = "",
  submitLabel,
  people,
  onSubmit,
  onCancel,
  autoFocus,
}: {
  placeholder: string;
  initial?: string;
  submitLabel: string;
  people: string[];
  onSubmit: (text: string) => boolean;
  onCancel?: () => void;
  autoFocus?: boolean;
}) => {
  const [text, setText] = useState(initial);
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    // focused when it opens, the caret after the text (editing goes on where it ends)
    const box = area.current;
    if (autoFocus && box) {
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    }
  }, [autoFocus]);
  const suggestions = mention ? people.filter((name) => name.toLowerCase().includes(mention.query.toLowerCase())).slice(0, 6) : [];
  const findMention = (value: string, caret: number) => {
    const match = /(?:^|\s)@([\p{L}\p{N}._'-]*)$/u.exec(value.slice(0, caret));
    setMention(match ? { query: match[1], start: caret - match[1].length - 1 } : null);
  };
  const pick = (name: string) => {
    if (!mention) return;
    const caret = mention.start + 1 + mention.query.length;
    const next = `${text.slice(0, mention.start)}@${name.replaceAll(/\s+/g, "")} ${text.slice(caret)}`;
    setText(next);
    setMention(null);
    setTimeout(() => area.current?.focus(), 0);
  };
  const submit = () => {
    if (text.trim() && onSubmit(text.trim())) {
      setText("");
      setMention(null);
    }
  };
  return (
    <div className="kq-cm-composer">
      <textarea
        ref={area}
        value={text}
        placeholder={placeholder}
        rows={Math.min(6, Math.max(1, text.split("\n").length))}
        onChange={(event) => {
          setText(event.target.value);
          findMention(event.target.value, event.target.selectionStart ?? event.target.value.length);
        }}
        onKeyDown={(event) => {
          event.stopPropagation(); // Excalidraw's shortcuts stay out
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (mention && suggestions.length) {
              pick(suggestions[0]);
            } else {
              submit();
            }
          }
          if (event.key === "Escape") {
            event.preventDefault();
            if (mention) setMention(null);
            else onCancel?.();
          }
        }}
      />
      <button type="button" className="kq-cm-send" aria-label={submitLabel} title={submitLabel} disabled={!text.trim()} onClick={submit}>
        <Icon name="send" />
      </button>
      {suggestions.length > 0 && (
        <ul className="kq-cm-mentions" aria-label="People">
          {suggestions.map((name) => (
            <li key={name}>
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => pick(name)}>
                @{name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

// -----------------------------------------------------------------------------
// changes: through the store (live sync or the scene's own save)
// -----------------------------------------------------------------------------

const save = (comment: SceneComment, setError: (error: string | null) => void) => {
  const ok = commentStore.change(comment);
  setError(ok ? null : "Comments can't be saved in this scene now (it is read only here, or still loading).");
  return ok;
};

const now = () => Date.now();

/** a change's `u`: after the version it changes, even if this device's clock is behind (see changeStamp) */
const stamp = (comment: SceneComment) => changeStamp(comment, now());

// -----------------------------------------------------------------------------
// one comment in a thread
// -----------------------------------------------------------------------------

const CommentItem = ({
  comment,
  me,
  canModerate,
  people,
  isFirst,
  onError,
}: {
  comment: SceneComment;
  me: Me | null;
  canModerate: boolean;
  people: string[];
  isFirst: boolean;
  onError: (error: string | null) => void;
}) => {
  // the menu opens next to its button, over the list (which scrolls and would cut it off)
  const [menu, setMenu] = useState<{ right: number; top: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const mine = !!me && comment.by.key === me.key;
  if (comment.gone) {
    return <li className="kq-cm-item kq-cm-item--gone">{isFirst ? "The first comment was deleted." : "Deleted."}</li>;
  }
  return (
    <li className="kq-cm-item">
      <div className="kq-cm-head">
        <Avatar name={comment.by.name} keyId={comment.by.key} agent={comment.by.agent} />
        <strong>{comment.by.name}</strong>
        {comment.by.agent && <span className="kq-cm-badge">agent</span>}
        <span className="kq-cm-time" title={new Date(comment.at).toLocaleString()}>
          · {ago(comment.at)}
          {comment.edited ? " (edited)" : ""}
        </span>
        <span className="kq-cm-spacer" />
        <div className="kq-cm-menu-wrap">
          <IconButton icon="more" label="More" onClick={(event) => setMenu(menu ? null : menuSpot(event.currentTarget))} active={!!menu} />
          {menu && (
            <div className="kq-cm-menu" style={menu} onMouseLeave={() => setMenu(null)}>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText(threadLink(comment.thread)).catch(() => {});
                  setMenu(null);
                }}
              >
                <Icon name="link" /> Copy link
              </button>
              {mine && (
                <button
                  type="button"
                  onClick={() => {
                    setEditing(true);
                    setMenu(null);
                  }}
                >
                  <Icon name="comment" /> Edit
                </button>
              )}
              {(mine || canModerate) && (
                <button
                  type="button"
                  className="kq-cm-danger"
                  onClick={() => {
                    save({ ...comment, gone: true, text: "", u: stamp(comment) }, onError);
                    setMenu(null);
                  }}
                >
                  <Icon name="trash" /> Remove
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      {editing ? (
        <Composer
          placeholder="Edit your comment"
          initial={comment.text}
          submitLabel="Save"
          people={people}
          autoFocus
          onCancel={() => setEditing(false)}
          onSubmit={(text) => {
            const ok = save({ ...comment, text, edited: now(), u: stamp(comment) }, onError);
            if (ok) setEditing(false);
            return ok;
          }}
        />
      ) : (
        <CommentText text={comment.text} />
      )}
    </li>
  );
};

// -----------------------------------------------------------------------------
// the popover: a thread, or a new one
// -----------------------------------------------------------------------------

const Popover = ({ at, children, onClose }: { at: { x: number; y: number }; children: React.ReactNode; onClose: () => void }) => {
  const box = useRef<HTMLDialogElement>(null);
  const [place, setPlace] = useState({ left: at.x + 18, top: at.y - 12 });
  useEffect(() => {
    const width = box.current?.offsetWidth ?? 340;
    const height = box.current?.offsetHeight ?? 300;
    const left = at.x + 18 + width > window.innerWidth - 8 ? Math.max(8, at.x - 18 - width) : at.x + 18;
    const top = Math.min(Math.max(8, at.y - 12), Math.max(8, window.innerHeight - height - 8));
    setPlace({ left, top });
  }, [at.x, at.y]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (!box.current?.contains(target) && !target.closest?.(".kq-cm-pin")) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [onClose]);
  return (
    <dialog open ref={box} className="kq-cm-popover" style={place} aria-label="Comment">
      {children}
    </dialog>
  );
};

const ThreadView = ({
  thread,
  threads,
  me,
  canComment,
  canModerate,
  people,
}: {
  thread: CommentThread;
  threads: CommentThread[];
  me: Me | null;
  canComment: boolean;
  canModerate: boolean;
  people: string[];
}) => {
  const [error, setError] = useState<string | null>(null);
  const index = threads.findIndex((entry) => entry.id === thread.id);
  const go = (step: number) => {
    const next = threads[(index + step + threads.length) % threads.length];
    if (next) {
      setUi({ open: next.id });
      focusThread(next);
    }
  };
  const all = [thread.root, ...thread.replies];
  const mineRoot = !!me && thread.root.by.key === me.key;
  const resolve = () => {
    const u = stamp(thread.root);
    save(thread.resolved ? { ...withoutDone(thread.root), u } : { ...thread.root, done: { name: me?.name ?? "Someone", at: now() }, u }, setError);
  };
  const removeThread = () => {
    // closed only when everything was removed: else the popover stays and shows why
    let ok = true;
    for (const comment of all.filter((entry) => !entry.gone)) {
      ok = save({ ...comment, gone: true, text: "", u: stamp(comment) }, setError) && ok;
    }
    if (ok) {
      setUi({ open: null });
    }
  };
  return (
    <>
      <div className="kq-cm-bar">
        <IconButton icon="prev" label="Previous thread" onClick={() => go(-1)} disabled={threads.length < 2} />
        <IconButton icon="next" label="Next thread" onClick={() => go(1)} disabled={threads.length < 2} />
        <span className="kq-cm-spacer" />
        {canComment && <IconButton icon={thread.resolved ? "reopen" : "resolve"} label={thread.resolved ? "Reopen" : "Resolve"} onClick={resolve} active={thread.resolved} />}
        <IconButton icon="link" label="Copy link to this thread" onClick={() => navigator.clipboard?.writeText(threadLink(thread.id)).catch(() => {})} />
        {(canModerate || (mineRoot && !thread.replies.length)) && <IconButton icon="trash" label="Delete thread" onClick={removeThread} />}
        <IconButton icon="close" label="Close" onClick={() => setUi({ open: null })} />
      </div>
      {thread.resolved && thread.root.done && (
        <p className="kq-cm-resolved">
          Resolved by {thread.root.done.name} · {ago(thread.root.done.at)}
        </p>
      )}
      <ul className="kq-cm-list">
        {all.map((comment, position) => (
          <CommentItem key={comment.id} comment={comment} me={me} canModerate={canModerate} people={people} isFirst={position === 0} onError={setError} />
        ))}
      </ul>
      {error && <p className="kq-cm-error">{error}</p>}
      {canComment && me ? (
        <div className="kq-cm-reply">
          <Avatar name={me.name} keyId={me.key} />
          <Composer
            placeholder="Reply, @mention someone…"
            submitLabel="Reply"
            people={people}
            onCancel={() => setUi({ open: null })}
            onSubmit={(text) => {
              const id = commentId();
              const at = now();
              return save({ id, thread: thread.id, by: { name: me.name, key: me.key }, text, at, u: at }, setError);
            }}
          />
        </div>
      ) : (
        <p className="kq-cm-note">You can read the comments here, not add any.</p>
      )}
    </>
  );
};

const DraftView = ({ pin, me, people }: { pin: CommentPin; me: Me; people: string[] }) => {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <div className="kq-cm-bar">
        <strong className="kq-cm-title">New comment</strong>
        <span className="kq-cm-spacer" />
        <IconButton icon="close" label="Cancel" onClick={() => setUi({ draft: null })} />
      </div>
      <div className="kq-cm-reply">
        <Avatar name={me.name} keyId={me.key} />
        <Composer
          placeholder="Add a comment, @mention someone…"
          submitLabel="Comment"
          people={people}
          autoFocus
          onCancel={() => setUi({ draft: null })}
          onSubmit={(text) => {
            const id = commentId();
            const at = now();
            const ok = save({ id, thread: id, by: { name: me.name, key: me.key }, text, at, u: at, pin }, setError);
            if (ok) {
              setUi({ draft: null, open: id });
            }
            return ok;
          }}
        />
      </div>
      {error && <p className="kq-cm-error">{error}</p>}
    </>
  );
};

// -----------------------------------------------------------------------------
// the canvas: pins, the open popover, placing
// -----------------------------------------------------------------------------

/** the scene under a viewport point: the topmost element there (frames last), or none */
const elementAt = (point: { x: number; y: number }) => {
  const api = canvasApi();
  if (!api) return null;
  const hits = api
    .getSceneElements()
    .filter((el: any) => !el.isDeleted && !el.locked && point.x >= el.x && point.x <= el.x + el.width && point.y >= el.y && point.y <= el.y + el.height);
  const top = [...hits].reverse();
  return (top.find((el: any) => el.type !== "frame" && el.type !== "magicframe") ?? top[0] ?? null) as any;
};

/** zoom / scroll so a thread's pin is in view, if it isn't */
const focusThread = (thread: CommentThread) => {
  const api = canvasApi();
  if (!api) return;
  const appState = api.getAppState();
  const elements = new Map(api.getSceneElementsIncludingDeleted().map((el: any) => [el.id, el]));
  const at = pinPosition(thread.root.pin!, elements);
  const view = sceneCoordsToViewportCoords({ sceneX: at.x, sceneY: at.y }, appState);
  if (view.x < 40 || view.y < 80 || view.x > window.innerWidth - 400 || view.y > window.innerHeight - 80) {
    api.updateScene({
      appState: {
        scrollX: appState.width / 2 / appState.zoom.value - at.x - 160 / appState.zoom.value,
        scrollY: appState.height / 2 / appState.zoom.value - at.y,
      },
    });
  }
};

type PinSpot = { id: string; x: number; y: number };

/** where each thread's pin is on screen, kept up to date (the canvas moves, elements move) */
const usePinSpots = (threads: CommentThread[], draft: CommentPin | null) => {
  const [spots, setSpots] = useState<PinSpot[]>([]);
  useEffect(() => {
    if (!threads.length && !draft) {
      setSpots([]);
      return; // nothing to follow: no loop (the layer is always mounted)
    }
    let frame = 0;
    let last = "";
    const loop = () => {
      const api = canvasApi();
      const next: PinSpot[] = [];
      if (api) {
        const appState = api.getAppState();
        // Excalidraw's own map: nothing is built per frame
        const elements = api.getSceneElementsMapIncludingDeleted();
        const place = (id: string, pin: CommentPin) => {
          const at = pinPosition(pin, elements);
          const view = sceneCoordsToViewportCoords({ sceneX: at.x, sceneY: at.y }, appState);
          next.push({ id, x: Math.round(view.x), y: Math.round(view.y) });
        };
        threads.forEach((thread) => place(thread.id, thread.root.pin!));
        if (draft) place("draft", draft);
      }
      const key = JSON.stringify(next);
      if (key !== last) {
        last = key;
        setSpots(next);
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [threads, draft]);
  return spots;
};

const Pin = ({ thread, spot, open }: { thread: CommentThread; spot: PinSpot; open: boolean }) => {
  const authors = [...new Map([thread.root, ...thread.replies].filter((c) => !c.gone).map((c) => [c.by.key, c.by])).values()];
  const count = 1 + thread.replies.length;
  return (
    <button
      type="button"
      className={clsx("kq-cm-pin", { "kq-cm-pin--open": open, "kq-cm-pin--resolved": thread.resolved })}
      style={{ left: spot.x, top: spot.y }}
      title={`${count} comment${count === 1 ? "" : "s"}${thread.resolved ? " (resolved)" : ""}`}
      aria-label={`Comment thread by ${authors.map((a) => a.name).join(", ")}`}
      onClick={() => setUi({ open: open ? null : thread.id, draft: null, placing: false })}
    >
      {authors.slice(0, 3).map((author) => (
        <Avatar key={author.key} name={author.name} keyId={author.key} agent={author.agent} />
      ))}
      {authors.length > 3 && <span className="kq-cm-more">+{authors.length - 3}</span>}
    </button>
  );
};

/** placing a new comment: the next click on the canvas puts it there (on the element under it, if any) */
const PlacingLayer = () => (
  <div
    className="kq-cm-placing"
    onPointerDown={(event) => {
      event.preventDefault();
      event.stopPropagation();
      const api = canvasApi();
      if (!api) return;
      const point = viewportCoordsToSceneCoords({ clientX: event.clientX, clientY: event.clientY }, api.getAppState());
      const element = elementAt(point);
      const pin: CommentPin = element
        ? { x: point.x, y: point.y, el: element.id, dx: point.x - element.x, dy: point.y - element.y }
        : pinFor(null, point.x, point.y);
      setUi({ placing: false, draft: pin, open: null });
    }}
  >
    <div className="kq-cm-placing__hint">Click where your comment goes · Esc to cancel</div>
  </div>
);

export const CommentsLayer = () => {
  const state = useUi();
  const comments = useComments();
  const me = useMe();
  const { canComment, canModerate } = usePermissions();
  const presenter = usePresenter();
  const viewer = useViewer();
  const signedIn = useSyncExternalStore(connection.subscribe, connection.isActive);
  const allThreads = useMemo(() => threadsOf(comments), [comments]);
  const shown = useMemo(() => allThreads.filter((thread) => !thread.resolved || state.showResolved || thread.id === state.open), [allThreads, state.showResolved, state.open]);
  const spots = usePinSpots(shown, state.draft);
  const people = usePeople(comments, viewer);
  const current = useSyncExternalStore(scenesController.subscribe, () => scenesController.getState().current);

  // another scene: nothing of the last one stays open
  useEffect(() => {
    setUi({ open: null, draft: null, placing: false });
  }, [current]);

  // a link to a thread (#comment=…): open it once the scene's comments are there
  useEffect(() => {
    const wanted = linkedThread();
    const thread = wanted ? allThreads.find((entry) => entry.id === wanted) : null;
    if (thread) {
      setUi({ open: thread.id, showResolved: state.showResolved || thread.resolved });
      focusThread(thread);
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  }, [allThreads]);

  useEffect(() => {
    if (!state.placing) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setUi({ placing: false });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.placing]);

  // not in presentations; in the shared viewer only for people signed in (comments carry names)
  if (presenter.active || (viewer && !signedIn)) {
    return null;
  }
  const spotOf = (id: string) => spots.find((spot) => spot.id === id);
  const openThread = state.open ? allThreads.find((thread) => thread.id === state.open) : null;
  const openSpot = openThread ? spotOf(openThread.id) : null;
  const draftSpot = state.draft ? spotOf("draft") : null;
  return createPortal(
    <div className={clsx("kq-cm-layer", { "kq-cm-layer--viewer": viewer })}>
      {shown.map((thread) => {
        const spot = spotOf(thread.id);
        return spot ? <Pin key={thread.id} thread={thread} spot={spot} open={thread.id === state.open} /> : null;
      })}
      {draftSpot && <span className="kq-cm-pin kq-cm-pin--draft" style={{ left: draftSpot.x, top: draftSpot.y }} aria-hidden />}
      {openThread && openSpot && (
        <Popover at={openSpot} onClose={() => setUi({ open: null })}>
          <ThreadView thread={openThread} threads={shown} me={me} canComment={canComment} canModerate={canModerate} people={people} />
        </Popover>
      )}
      {state.draft && draftSpot && me && (
        <Popover at={draftSpot} onClose={() => setUi({ draft: null })}>
          <DraftView pin={state.draft} me={me} people={people} />
        </Popover>
      )}
      {state.placing && <PlacingLayer />}
    </div>,
    document.body,
  );
};

// -----------------------------------------------------------------------------
// the top right: "Comments" with the number of open threads, and their list
// -----------------------------------------------------------------------------

export const CommentsButton = () => {
  const state = useUi();
  const comments = useComments();
  const { canComment } = usePermissions();
  const threads = useMemo(() => threadsOf(comments), [comments]);
  const open = threads.filter((thread) => !thread.resolved);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!state.list) return;
    const onDown = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setUi({ list: false });
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [state.list]);
  const listed = state.showResolved ? threads : open;
  return (
    <div className="kq-cm-top" ref={wrap}>
      <button
        type="button"
        className={clsx("scenes-pill kq-cm-button", { "scenes-pill--open": state.list })}
        title="Comments: notes on the scene that are not drawn"
        aria-expanded={state.list}
        onClick={() => setUi({ list: !state.list })}
      >
        <Icon name="comment" />
        Comments
        {open.length > 0 && <span className="kq-cm-count">{open.length}</span>}
      </button>
      {state.list && (
        <dialog open className="kq-cm-panel" aria-label="Comments">
          <div className="kq-cm-panel__head">
            {canComment ? (
              <button type="button" className="scenes-btn scenes-btn--primary" onClick={() => setUi({ list: false, placing: true, open: null, draft: null })}>
                New comment
              </button>
            ) : (
              <span className="kq-cm-note">You can read the comments here, not add any.</span>
            )}
            <label className="kq-cm-switch">
              <input type="checkbox" checked={state.showResolved} onChange={(event) => setUi({ showResolved: event.target.checked })} />
              <span>Show resolved</span>
            </label>
          </div>
          {listed.length ? (
            <ul className="kq-cm-threads">
              {[...listed].reverse().map((thread) => (
                <li key={thread.id}>
                  <button
                    type="button"
                    className={clsx("kq-cm-thread", { "kq-cm-thread--resolved": thread.resolved })}
                    onClick={() => {
                      setUi({ list: false, open: thread.id, draft: null });
                      focusThread(thread);
                    }}
                  >
                    <Avatar name={thread.root.by.name} keyId={thread.root.by.key} agent={thread.root.by.agent} />
                    <span className="kq-cm-thread__body">
                      <span className="kq-cm-thread__meta">
                        <strong>{thread.root.by.name}</strong> · {ago(thread.last)}
                        {thread.replies.length > 0 && ` · ${thread.replies.length} ${thread.replies.length === 1 ? "reply" : "replies"}`}
                        {thread.resolved && " · resolved"}
                      </span>
                      <span className="kq-cm-thread__text">{thread.root.gone ? "(deleted)" : thread.root.text}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="kq-cm-empty">{threads.length ? "No open comments." : "No comments yet."}</p>
          )}
        </dialog>
      )}
    </div>
  );
};
