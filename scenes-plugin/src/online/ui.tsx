// Kurviq's own UI: Sign in with Google (scenes go to the folder "Kurviq" in
// the user's Google Drive), sharing a scene (Drive's permissions), the "MCP"
// button with the agent link and prompt (online), and the footer (built on
// Excalidraw, llms.txt).

import { MainMenu, WelcomeScreen } from "@excalidraw/excalidraw";
import { ExternalLinkIcon, GithubIcon } from "@excalidraw/excalidraw/components/icons";
import clsx from "clsx";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";

import { scenesController } from "../controller";
import { PlaceSvg } from "../icons";
import { QuickTip } from "../quickTip";

import {
  CONNECTING_KEY,
  FOLDER_NAME,
  addPerson,
  changeRole,
  checkConnection,
  connectGoogle,
  connection,
  disconnectGoogle,
  enterSpace,
  linkAccessOf,
  listPermissions,
  removeAccess,
  setLinkAccess,
  shareLink,
  sharedFileId,
} from "./drive";
import { pairing } from "./pairing";

import { TEXT_MAX, TITLE_MAX, cleanFeedback } from "../../../scenes-mcp/feedback.mjs";
import type { SceneListItem } from "../controller";
import type { LinkAccess, Permission } from "./drive";

import lilitaLatin from "@excalidraw/excalidraw/fonts/Lilita/Lilita-Regular-i7dPIFZ9Zz-WBtRtedDbYEF8RXi4EwQ.woff2";

import { deck, isDeck } from "../deck";
import { appVersion, reloadApp } from "./version";
import { openPublicScene } from "../router";

import "./online.scss";

const useConnection = () => useSyncExternalStore(connection.subscribe, connection.getState);
const usePairingKey = () => useSyncExternalStore(pairing.subscribe, pairing.getKey);

export const GoogleIcon = (
  <svg viewBox="0 0 48 48" width="16" height="16" aria-hidden>
    <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.3-.4-3.5z" />
    <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
    <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
    <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.2-.1-2.3-.4-3.5z" />
  </svg>
);

export const DriveIcon = (
  <svg viewBox="0 0 87.3 78" width="18" height="16" aria-hidden>
    <path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da" />
    <path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z" fill="#00ac47" />
    <path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" fill="#ea4335" />
    <path d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d" />
    <path d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc" />
    <path d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00" />
  </svg>
);

// -----------------------------------------------------------------------------
// start: is this browser signed in? (and the answer of a Google redirect)
// -----------------------------------------------------------------------------

let notice: string | null = null;
let started = false;
/** the answer of a Google redirect, read before anything can rewrite the URL */
const googleAnswer = new URLSearchParams(window.location.search).get("google");

/** the Google account this browser's scenes were synced with last (switching accounts resyncs everything) */
const ACCOUNT_KEY = "kurviq-drive-account";

// after signing in: a short dialog (sync is on / Drive access missing)
type Setup = null | { step: "done"; published: number } | { step: "nodrive" };

let setup: Setup = null;
const setupListeners = new Set<() => void>();
const setSetup = (next: Setup) => {
  setup = next;
  setupListeners.forEach((listener) => listener());
};
const useSetup = () =>
  useSyncExternalStore(
    (listener) => {
      setupListeners.add(listener);
      return () => {
        setupListeners.delete(listener);
      };
    },
    () => setup,
  );

const localOnlyScenes = () =>
  scenesController
    .getState()
    .list.filter((item) => item.name !== null && item.localOnly)
    .map((item) => item.name!);

/** signed in just now: new scenes sync, and the scenes kept in this browser go to Drive; returns how many */
const activateSync = async () => {
  scenesController.setNewScenesLocalOnly(false);
  let published = 0;
  for (const name of localOnlyScenes()) {
    await scenesController.setLocalOnly(name, false).then(
      () => published++,
      () => {},
    );
  }
  scenesController.syncNow({ refresh: true });
  return published;
};

/** back to the user's own scenes, from a shared scene's space */
export const leaveSharedScene = async () => {
  await scenesController.leaveForReload();
  enterSpace(null);
};

export const startDrive = () => {
  if (started) {
    return;
  }
  started = true;
  // keep the scenes even under storage pressure (Safari, full disks)
  navigator.storage?.persist?.().catch(() => {});

  const answer = googleAnswer;
  if (answer) {
    notice =
      answer === "connected"
        ? null
        : answer === "cancelled"
        ? "Sign-in cancelled."
        : answer === "nodrive"
        ? null
        : "Sign-in failed — please try again.";
    const params = new URLSearchParams(window.location.search);
    params.delete("google");
    const query = params.toString();
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  }

  // never signed in with Google here: the scenes' sync state is GitHub's, not Drive's
  let knownAccount: string | null = "";
  try {
    knownAccount = localStorage.getItem(ACCOUNT_KEY);
  } catch {}
  if (knownAccount === null && !sharedFileId) {
    scenesController.forgetGitHubState().catch((error) => console.error("[scenes] forgetting GitHub's sync state", error));
  }

  // only the tab that went to Google acts on its answer (a link with ?google=connected does nothing)
  let asked = false;
  try {
    asked = Date.now() - Number(sessionStorage.getItem(CONNECTING_KEY) || 0) < 30 * 60_000;
    sessionStorage.removeItem(CONNECTING_KEY);
  } catch {}
  let afterSignIn = asked ? answer : null;
  let last = "";
  connection.subscribe(() => {
    const { user, drive } = connection.getState();
    if (user === undefined) {
      return;
    }
    if (user && drive && !sharedFileId) {
      let previous: string | null = null;
      try {
        previous = localStorage.getItem(ACCOUNT_KEY);
        localStorage.setItem(ACCOUNT_KEY, user.email);
      } catch {}
      if (previous !== user.email) {
        // what this browser knew about the remote side was another Drive's
        // (another account), or GitHub's (the first sign-in in this browser:
        // scenes without local changes take Drive's copy of them)
        scenesController.resetRemoteState({ keepDirty: previous === null });
      }
    }
    if (afterSignIn) {
      const what = afterSignIn;
      afterSignIn = null;
      if (user && !drive) {
        setSetup({ step: "nodrive" });
      } else if (user && what === "connected" && !sharedFileId && !/^\/s\//.test(window.location.pathname)) {
        activateSync().then((published) => setSetup({ step: "done", published }));
      }
    }
    const key = JSON.stringify([user?.email ?? null, drive]);
    if (key !== last) {
      last = key;
      scenesController.syncNow({ refresh: true });
    }
  });
  checkConnection();
};

// -----------------------------------------------------------------------------
// sidebar: Google Drive
// -----------------------------------------------------------------------------

const folderUrl = () => {
  const email = connection.getState().user?.email ?? "";
  let id: string | null = null;
  try {
    id = localStorage.getItem(`kurviq-drive-folder:${email}`);
  } catch {}
  return id ? `https://drive.google.com/drive/folders/${id}` : "https://drive.google.com/drive/my-drive";
};

const SignInButton = ({ label = "Sign in with Google" }: { label?: string }) => (
  <button type="button" className="scenes-btn kq-google-btn" onClick={() => connectGoogle()}>
    <span className="kq-icon">{GoogleIcon}</span> {label}
  </button>
);

/** in the scene dropdown: offer Google while not signed in */
export const ConnectDriveOffer = () => {
  const { user } = useConnection();
  if (user !== null) {
    return null;
  }
  return (
    <div className="kq-switcher-github">
      <span className="kq-muted">Scenes are saved in this browser only.</span>
      <SignInButton />
    </div>
  );
};

const LinkedInIcon = (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden fill="currentColor">
    <path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.86 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.07 2.07 0 1 1 0-4.13 2.07 2.07 0 0 1 0 4.13zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0z" />
  </svg>
);

/** the welcome screen's text (injected by ../../vite.config.mts instead of upstream's) */
// the wordmark's font: Lilita One, which Excalidraw ships for the canvas
try {
  document.fonts.add(new FontFace("Kurviq Wordmark", `url(${lilitaLatin})`, { display: "block" }));
} catch {}

/** Kurviq's wordmark like Excalidraw's: the icon stands in for the "K" */
export const KurviqLogo = () => (
  <span className="kq-logo" role="img" aria-label="Kurviq">
    <svg className="kq-logo__icon" viewBox="0 0 64 64" aria-hidden>
      <rect width="64" height="64" rx="14" fill="#6965db" />
      <path d="M20 15c-1 11-1 23 0 34" fill="none" stroke="#fff" strokeWidth="5.5" strokeLinecap="round" />
      <path
        d="M45 15C34 22 27 28 21.5 32.5 31 37 39 42 46 49.5"
        fill="none"
        stroke="#e0dfff"
        strokeWidth="5.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
    <span className="kq-logo__text" aria-hidden>
      URVIQ
    </span>
  </span>
);

/** on the welcome screen (injected by ../../vite.config.mts), instead of upstream's storage warning */
export const WelcomeHeading = () => {
  const { user, drive } = useConnection();
  return (
    <div className="kq-welcome">
      <p>
        Kurviq is an extension of the excellent{" "}
        <a href="https://excalidraw.com" target="_blank" rel="noopener noreferrer">
          Excalidraw
        </a>{" "}
        that adds{" "}
        <a
          className="kq-welcome__features"
          href="/features"
          onClick={(event) => {
            event.preventDefault();
            openPublicScene("features");
          }}
        >
          what I always wanted
        </a>
        .
      </p>
      <p className="kq-welcome__storage">
        {user && drive
          ? "Your drawings are saved in this browser and in your Google Drive."
          : "Your drawings are saved in this browser. Sign in with Google to keep them safe in your Google Drive."}
      </p>
      <a
        className="kq-welcome__signature"
        href="https://www.linkedin.com/in/fabian-wesner/"
        target="_blank"
        rel="noopener noreferrer"
        title="Fabian Wesner on LinkedIn"
      >
        – Fabian {LinkedInIcon}
      </a>
    </div>
  );
};

/** on the welcome screen (injected by ../../vite.config.mts), while not signed in */
export const WelcomeConnectDrive = () => {
  const { user } = useConnection();
  if (user !== null) {
    return null;
  }
  return (
    <WelcomeScreen.Center.MenuItem onSelect={() => connectGoogle()} icon={GoogleIcon} shortcut={null}>
      Sign in with Google to sync
    </WelcomeScreen.Center.MenuItem>
  );
};

const confirmSignOut = () => {
  if (
    window.confirm(
      "Sign out of Google in this browser? Your scenes stay here; changes are synced again once you sign in.",
    )
  ) {
    disconnectGoogle();
  }
};

/** top of the Scenes sidebar: the Google Drive connection of this browser */
export const DrivePanel = () => {
  const { user, drive, error, needsAccess } = useConnection();
  const { remote } = useSyncExternalStore(scenesController.subscribe, scenesController.getState);

  if (user === undefined) {
    return <section className="kq-card kq-muted">Checking Google sign-in…</section>;
  }
  if (!user) {
    return (
      <section className="kq-card">
        {notice && <div className="kq-notice">{notice}</div>}
        <div className="kq-card__title">Your scenes are saved in this browser</div>
        <div className="kq-muted">
          No account needed. Sign in with Google to keep them in your Google Drive: on all your devices, shared with
          whom you choose, and with your coding agents.
        </div>
        {error && <div className="scenes-error">{error}</div>}
        <div className="scenes-row">
          <SignInButton />
        </div>
        <span className="kq-muted kq-left">
          They go to the folder <strong>{FOLDER_NAME}</strong> in your Drive. Kurviq only sees the files it creates.
        </span>
      </section>
    );
  }
  if (!drive) {
    return (
      <section className="kq-card">
        <div className="kq-card__title">Signed in as {user.email}, without Google Drive</div>
        <div className="kq-muted">
          Kurviq needs your permission to keep its own files in your Drive (it sees nothing else there). Sign in once
          more and tick the Google Drive box.
        </div>
        <div className="scenes-row">
          <button type="button" className="scenes-btn scenes-btn--primary" onClick={() => connectGoogle({ consent: true })}>
            Allow Google Drive
          </button>
        </div>
        <button type="button" className="scenes-link kq-left" onClick={() => disconnectGoogle()}>
          Sign out
        </button>
      </section>
    );
  }
  if (sharedFileId) {
    return (
      <section className="kq-card">
        <div className="kq-card__title">A scene shared with you</div>
        <div className="kq-muted">
          {needsAccess
            ? "Kurviq may not open it yet: open its link again and allow it."
            : `"${remote?.[0]?.name ?? "It"}" is a file in someone's Google Drive: your changes are saved to it, for everyone it is shared with.`}
        </div>
        <div className="scenes-row">
          <button type="button" className="scenes-btn scenes-btn--primary" onClick={() => leaveSharedScene()}>
            Back to my scenes
          </button>
        </div>
        <span className="kq-muted kq-left">as {user.email}</span>
      </section>
    );
  }
  return (
    <section className="kq-card kq-card--repo">
      <a className="scenes-repo" href={folderUrl()} target="_blank" rel="noopener noreferrer" title="Open the folder in Google Drive">
        <span className="scenes-repo__logo">{DriveIcon}</span>
        <span className="scenes-repo__text">
          <span className="scenes-repo__caption">Synced with Google Drive</span>
          <span className="scenes-repo__name">{FOLDER_NAME}</span>
        </span>
        <span className="scenes-repo__external">{ExternalLinkIcon}</span>
      </a>
      <div className="kq-repo-actions">
        <span className="kq-muted">as {user.email}</span>
        <button type="button" className="scenes-link scenes-link--danger" onClick={confirmSignOut}>
          Sign out
        </button>
      </div>
    </section>
  );
};

// -----------------------------------------------------------------------------
// sharing: Drive's permissions of a scene's file, and its links
// -----------------------------------------------------------------------------

/** kurviq.com/s/<fileId>/<name> (?present: starts presenting) */
const sceneLink = (fileId: string, name: string, { present = false } = {}) =>
  `${shareLink(fileId, name)}${present ? "?present" : ""}`;

/** a link button that copies and says so; `tip` says who can open the link (null: nothing to share yet) */
const CopyLink = ({
  link,
  label,
  tip,
  icon,
  className = "scenes-link",
}: {
  link: string | null;
  label: string;
  tip: string;
  icon?: ReactNode;
  className?: string;
}) => {
  const [copied, setCopied] = useState(false);
  return (
    <QuickTip tip={tip} label={false}>
      <button
        type="button"
        className={className}
        // not `disabled`: a disabled button gets no hover, so no tooltip saying why
        aria-disabled={!link || undefined}
        onClick={() =>
          link &&
          navigator.clipboard.writeText(link).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {icon}
        {copied ? "Copied ✓" : label}
      </button>
    </QuickTip>
  );
};

/** why a scene can't be shared (yet), or null */
const notShareable = (item: SceneListItem | undefined, what: string) => {
  const { user, drive } = connection.getState();
  if (!user || !drive) {
    return `Nothing to share yet: this ${what} is only in this browser. Sign in with Google to save it to your Drive, then share it.`;
  }
  if (!item || item.name === null || item.localOnly) {
    return `Nothing to share: this ${what} is local only (only in this browser). Turn sync on for it to share it.`;
  }
  return null;
};

const LINK_ICON = (
  <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden>
    <path
      d="M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-.9.9m1.3 3.9a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 0 0 4.2 4.2l.9-.9"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
  </svg>
);

// the share dialog: one at a time, for a scene by name
let sharing: string | null = null;
const sharingListeners = new Set<() => void>();
export const openShareDialog = (name: string) => {
  sharing = name;
  sharingListeners.forEach((listener) => listener());
};
const closeShareDialog = () => openShareDialog(null as unknown as string);
const useSharing = () =>
  useSyncExternalStore(
    (listener) => {
      sharingListeners.add(listener);
      return () => {
        sharingListeners.delete(listener);
      };
    },
    () => sharing,
  );

const ROLE_LABEL: Record<string, string> = { reader: "Can view", commenter: "Can view", writer: "Can edit", owner: "Owner" };

const LINK_LABEL: Record<LinkAccess, string> = {
  restricted: "Only people added here",
  reader: "Anyone with the link can view",
  writer: "Anyone with the link can edit",
};

const LINK_HINT: Record<LinkAccess, string> = {
  restricted: "The link only works for the people above, signed in with Google.",
  reader: "Anyone who has the link can view and present it, no account needed.",
  writer: "Anyone who has the link can view it; with a Google account they can also change it.",
};

const ShareDialog = ({ name }: { name: string }) => {
  const [fileId, setFileId] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<Permission[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"reader" | "writer">("writer");
  const me = connection.getState().user?.email?.toLowerCase();
  const presentation = isDeck(useSyncExternalStore(deck.subscribe, deck.getState));

  const reload = async (id: string) => setPermissions(await listPermissions(id));

  useEffect(() => {
    scenesController
      .fileForSharing(name)
      .then(async (id) => {
        setFileId(id);
        await reload(id);
      })
      .catch((err) => setError(err.message));
  }, [name]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && closeShareDialog();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const run = async (what: () => Promise<unknown>) => {
    if (!fileId) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await what();
      await reload(fileId);
      scenesController.syncNow({ refresh: true });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const people = (permissions ?? []).filter((permission) => permission.type !== "anyone");
  const access = permissions ? linkAccessOf(permissions) : "restricted";
  const link = fileId ? sceneLink(fileId, name) : null;
  const add = () => {
    const address = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      setError("Please enter an email address");
      return;
    }
    run(async () => {
      await addPerson(
        fileId!,
        address,
        role,
        `I shared "${name}" with you on Kurviq. Open it here: ${link}`,
      );
      setEmail("");
    });
  };

  return (
    <div className="kq-overlay" onClick={(event) => event.target === event.currentTarget && closeShareDialog()}>
      <div className="kq-dialog kq-dialog--narrow kq-share" role="dialog" aria-modal="true" aria-labelledby="kq-share-title">
        <div className="kq-dialog__head">
          <h2 id="kq-share-title">Share "{name}"</h2>
          <button type="button" className="kq-close" aria-label="Close" onClick={closeShareDialog}>
            ×
          </button>
        </div>
        {!permissions && !error && <p className="kq-muted">Saving it to Google Drive and asking who has access…</p>}
        {permissions && (
          <>
            <div className="kq-share__add">
              <input
                type="email"
                placeholder="Add people by email"
                value={email}
                disabled={busy}
                onChange={(event) => setEmail(event.target.value)}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Enter") {
                    add();
                  }
                }}
              />
              <select value={role} disabled={busy} onChange={(event) => setRole(event.target.value as "reader" | "writer")}>
                <option value="writer">Can edit</option>
                <option value="reader">Can view</option>
              </select>
              <button type="button" className="scenes-btn scenes-btn--primary" disabled={busy || !email.trim()} onClick={add}>
                Share
              </button>
            </div>
            <p className="kq-muted">
              Google emails them a link. People without a Google account create one for their address (no Gmail needed).
            </p>
            <ul className="kq-share__people">
              {people.map((person) => {
                const isMe = person.emailAddress?.toLowerCase() === me;
                return (
                  <li key={person.id}>
                    <span className="kq-share__avatar" aria-hidden="true">
                      {(person.displayName || person.emailAddress || "?").charAt(0).toUpperCase()}
                    </span>
                    <span className="kq-share__who">
                      <span className="kq-share__name">
                        {person.displayName || person.emailAddress}
                        {isMe && " (you)"}
                      </span>
                      {person.displayName && person.emailAddress && <span className="kq-muted">{person.emailAddress}</span>}
                    </span>
                    {person.role === "owner" || isMe ? (
                      <span className="kq-muted kq-share__role">{ROLE_LABEL[person.role] ?? person.role}</span>
                    ) : (
                      <select
                        value={person.role === "writer" ? "writer" : "reader"}
                        disabled={busy}
                        onChange={(event) =>
                          event.target.value === "remove"
                            ? run(() => removeAccess(fileId!, person.id))
                            : run(() => changeRole(fileId!, person.id, event.target.value as "reader" | "writer"))
                        }
                      >
                        <option value="writer">Can edit</option>
                        <option value="reader">Can view</option>
                        <option value="remove">Remove access</option>
                      </select>
                    )}
                  </li>
                );
              })}
            </ul>
            <label className="kq-field">
              <span>General access</span>
              <select
                value={access}
                disabled={busy}
                onChange={(event) => run(() => setLinkAccess(fileId!, event.target.value as LinkAccess))}
              >
                {(Object.keys(LINK_LABEL) as LinkAccess[]).map((value) => (
                  <option key={value} value={value}>
                    {LINK_LABEL[value]}
                  </option>
                ))}
              </select>
            </label>
            <p className="kq-muted">{LINK_HINT[access]}</p>
            <div className="scenes-row">
              <CopyLink className="scenes-btn" link={link} label="Copy link" icon={LINK_ICON} tip="Copies the link to this scene" />
              {presentation && (
                <CopyLink
                  className="scenes-btn"
                  link={fileId ? sceneLink(fileId, name, { present: true }) : null}
                  label="Copy presentation link"
                  tip="Copies a link that starts presenting this scene"
                />
              )}
              <a
                className="scenes-link"
                href={`https://drive.google.com/file/d/${fileId}/view`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open in Drive
              </a>
            </div>
          </>
        )}
        {error && <p className="scenes-error">{error}</p>}
      </div>
    </div>
  );
};

/** the Slides sidebar's Share tab: who can open the links, the links, Share… */
export const SlidesShare = () => {
  const { current, list } = useSyncExternalStore(scenesController.subscribe, scenesController.getState);
  useConnection();
  const item = list.find((entry) => entry.name === current);
  const why = notShareable(item, "presentation");
  const fileId = item?.fileId ?? null;
  const name = item?.name ?? null;
  return (
    <section className="slides-details">
      {why ? (
        <p className="slides-hint">{why}</p>
      ) : (
        <>
          <span className={clsx("slides-badge", item!.public ? "slides-badge--public" : "slides-badge--private")}>
            <PlaceSvg kind={item!.public ? "public" : "private"} />
            {item!.public ? "Anyone with the link" : "Private"}
          </span>
          <p className="slides-hint">
            {item!.public
              ? "Anyone with the link can watch it, no sign-in needed."
              : "Only people you share it with can open the link, signed in with Google."}
          </p>
        </>
      )}
      <div className="slides-row">
        <button
          type="button"
          className="slides-btn slides-btn--primary"
          aria-disabled={!!why || undefined}
          onClick={() => !why && name && openShareDialog(name)}
        >
          Share…
        </button>
        <CopyLink
          className="slides-btn"
          link={!why && fileId && name ? sceneLink(fileId, name, { present: true }) : null}
          label="Copy presentation link"
          icon={LINK_ICON}
          tip={why ?? (fileId ? "Copies a link that starts presenting (who can open it: Share…)" : "Saving to Drive first: try again in a moment")}
        />
      </div>
    </section>
  );
};

/** in the current scene's actions: Share… and the link */
export const SceneSharing = ({ item, disabled }: { item: SceneListItem; disabled?: boolean }) => {
  useConnection();
  if (item.name === null || notShareable(item, "scene")) {
    return null;
  }
  const name = item.name;
  return (
    <>
      <QuickTip tip="Who can open this scene: people by email, or anyone with the link" label={false}>
        <button type="button" className="scenes-link" disabled={disabled} onClick={() => openShareDialog(name)}>
          Share…
        </button>
      </QuickTip>
      <CopyLink
        link={item.fileId ? sceneLink(item.fileId, name) : null}
        label="Copy link"
        tip={item.fileId ? `Copies the link to this scene (${item.public ? "anyone with it can view it" : "only people you share it with can open it"})` : "Not in Google Drive yet: you can copy its link once it has synced"}
      />
    </>
  );
};

/** Kurviq was updated while this tab was open: the agent's commands wait for a reload */
export const UpdateBanner = () => {
  const outdated = useSyncExternalStore(appVersion.subscribe, appVersion.isOutdated);
  return outdated ? (
    <div className="kq-update" role="status">
      <span>Kurviq was updated. Reload to continue with your agent (your work is saved).</span>
      <button type="button" className="scenes-btn scenes-btn--primary" onClick={() => reloadApp()}>
        Reload
      </button>
    </div>
  ) : null;
};

/** a scene that may only be viewed: the editor shows it, nothing can be changed */
export const ReadOnlyGuard = () => {
  const { sync, checking } = useSyncExternalStore(scenesController.subscribe, scenesController.getState);
  const current = useSyncExternalStore(scenesController.subscribe, () => scenesController.getState().current);
  const readOnly = sync.readOnly && !(current && scenesController.isLocalOnly(current)) ? sync.readOnly : null;
  useEffect(() => {
    const api = scenesController.getApi();
    if (readOnly && api && !api.getAppState().viewModeEnabled) {
      api.updateScene({ appState: { viewModeEnabled: true } });
    }
  }, [readOnly, checking, current]);
  return readOnly ? (
    <div className="kq-readonly" role="status">
      Read only: {readOnly}
    </div>
  ) : null;
};

/** after signing in (rendered next to the editor, see index.tsx), and the share dialog */
export const DriveDialogs = () => {
  const current = useSetup();
  const shareName = useSharing();
  const close = () => setSetup(null);

  useEffect(() => {
    if (!current) {
      return;
    }
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current]);

  if (shareName) {
    return <ShareDialog key={shareName} name={shareName} />;
  }
  if (!current) {
    return null;
  }
  const body =
    current.step === "nodrive" ? (
      <>
        <h2 id="kq-setup-title">Allow Google Drive</h2>
        <p>
          You're signed in, but Kurviq may not keep your scenes in your Google Drive yet: the Drive box wasn't ticked.
        </p>
        <p className="kq-muted">
          Kurviq only sees the files it creates there (a folder <strong>{FOLDER_NAME}</strong>), nothing else in your
          Drive.
        </p>
        <div className="scenes-row">
          <button type="button" className="scenes-btn scenes-btn--primary" onClick={() => connectGoogle({ consent: true })}>
            Allow Google Drive
          </button>
          <button type="button" className="scenes-btn" onClick={close}>
            Later
          </button>
        </div>
      </>
    ) : (
      <>
        <h2 id="kq-setup-title">Synced with Google Drive ✓</h2>
        <p>
          Your scenes are kept in the folder{" "}
          <a href={folderUrl()} target="_blank" rel="noopener noreferrer">
            {FOLDER_NAME}
          </a>{" "}
          of your Google Drive now.
        </p>
        <p className="kq-muted">
          {[
            current.published
              ? `${current.published} scene${current.published === 1 ? "" : "s"} from this browser ${current.published === 1 ? "goes" : "go"} there now.`
              : "",
            "Every change is saved there a few seconds after you stop drawing. Share a scene with Share… in the scene list.",
          ]
            .filter(Boolean)
            .join(" ")}
        </p>
        <div className="scenes-row">
          <button type="button" className="scenes-btn scenes-btn--primary" onClick={close}>
            Start drawing
          </button>
        </div>
      </>
    );
  return (
    <div className="kq-overlay">
      <div className="kq-dialog kq-dialog--narrow" role="dialog" aria-modal="true" aria-labelledby="kq-setup-title">
        {body}
      </div>
    </div>
  );
};

// -----------------------------------------------------------------------------
// MCP: the agent link of this browser
// -----------------------------------------------------------------------------

const agentPrompt = (url: string) => `Connect to my Kurviq whiteboard as a remote MCP server (Streamable HTTP, sign-in with OAuth):

${url}

- Claude Code (all projects): claude mcp add --scope user --transport http kurviq ${url} (then /mcp → kurviq → Authenticate)
- Codex: add to ~/.codex/config.toml: [mcp_servers.kurviq] url = "${url}", then run: codex mcp login kurviq
- Claude Desktop / claude.ai: Settings → Connectors → Add custom connector → this URL
- Other clients: add a remote MCP server with this URL

On first use my browser opens a Kurviq page where I allow you. Then read ${window.location.origin}/llms.txt to learn how to work with my drawings. The tools work while my Kurviq tab is open.`;

const CopyButton = ({ text, label }: { text: string; label: string }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="scenes-btn scenes-btn--primary"
      onClick={() =>
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
    >
      {copied ? "Copied ✓" : label}
    </button>
  );
};

const McpDialog = ({ onClose }: { onClose: () => void }) => {
  // the approval page reads this browser's key: made here if there is none yet
  usePairingKey() ?? pairing.ensureKey();
  const url = pairing.mcpUrl();
  const prompt = agentPrompt(url);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="kq-overlay" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="kq-dialog" role="dialog" aria-modal="true" aria-labelledby="kq-mcp-title">
        <div className="kq-dialog__head">
          <h2 id="kq-mcp-title">Let an AI agent draw with you</h2>
          <button type="button" className="kq-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <p className="kq-muted">
          Give this prompt to your agent (Claude Code, Codex, Cursor, Claude…). On first use, the agent opens a Kurviq
          page in your browser where you allow it. Then it can read, draw and edit your scenes while a Kurviq tab is
          open in <strong>this browser</strong>, and its edits are merged with yours.
        </p>
        <textarea className="kq-prompt" readOnly value={prompt} rows={9} onFocus={(event) => event.target.select()} />
        <div className="scenes-row">
          <CopyButton text={prompt} label="Copy prompt" />
          <CopyButton text={url} label="Copy MCP address only" />
        </div>
        <p className="kq-muted kq-small">
          The address holds no secret: an agent only gets in after you allowed it here, in this browser. Cut every agent
          off:{" "}
          <button
            type="button"
            className="scenes-link"
            onClick={() =>
              window.confirm("Sign out every agent? Each one asks you to allow it again on its next use.") && pairing.reset()
            }
          >
            Sign out all agents
          </button>{" "}
          ·{" "}
          <button
            type="button"
            className="scenes-link scenes-link--danger"
            onClick={() => {
              if (window.confirm("Turn agent access off in this browser? Every agent is signed out.")) {
                pairing.remove();
                onClose();
              }
            }}
          >
            Turn agent access off
          </button>
        </p>
        <p className="kq-muted kq-small">
          How agents work with Kurviq:{" "}
          <a href="/llms.txt" target="_blank" rel="noopener">
            llms.txt
          </a>
        </p>
      </div>
    </div>
  );
};

/** top left, next to "Slides" */
export const McpButton = () => {
  const [open, setOpen] = useState(false);
  const key = usePairingKey();
  return (
    <>
      <QuickTip tip={key ? "Connect an AI agent (MCP). Agent access is on in this browser." : "Connect an AI agent (MCP)"} label={false}>
        <button type="button" className="scenes-pill scenes-slides-btn" onClick={() => setOpen(true)}>
          <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden>
            <path d="M7 3v4M13 3v4M5 7h10v3a5 5 0 0 1-10 0V7zM10 15v3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          MCP
          {key && <span className="kq-dot" />}
        </button>
      </QuickTip>
      {open && <McpDialog onClose={() => setOpen(false)} />}
    </>
  );
};

// -----------------------------------------------------------------------------
// footer
// -----------------------------------------------------------------------------

/** bottom right of the canvas (injected by ../../vite.config.mts) */
/** main menu: Excalidraw's and Kurviq's code, and the posts about Kurviq (instead of Excalidraw's X / Discord) */
export const KurviqSocials = () => (
  <>
    <MainMenu.ItemLink icon={GithubIcon} href="https://github.com/excalidraw/excalidraw" aria-label="GitHub (Excalidraw)">
      GitHub (Excalidraw)
    </MainMenu.ItemLink>
    <MainMenu.ItemLink icon={GithubIcon} href="https://github.com/tecsteps/kurviq" aria-label="GitHub (Kurviq)">
      GitHub (Kurviq)
    </MainMenu.ItemLink>
    <MainMenu.ItemLink icon={LinkedInIcon} href="https://www.linkedin.com/feed/hashtag/kurviq/" aria-label="LinkedIn posts about Kurviq">
      #kurviq on LinkedIn
    </MainMenu.ItemLink>
  </>
);

/** bug reports and change requests (kurviq.com: stored in the Worker's D1, see online/worker/feedback.ts) */
const FeedbackDialog = ({ onClose }: { onClose: () => void }) => {
  const [kind, setKind] = useState<"bug" | "change">("bug");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [state, setState] = useState<{ sending?: boolean; error?: string; sent?: boolean }>({});

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const send = async () => {
    const scene = scenesController.getState().current;
    const checked = cleanFeedback({ kind, title, text, scene });
    if (!checked.ok) {
      setState({ error: checked.error });
      return;
    }
    setState({ sending: true });
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(checked.value),
      });
      const body = await res.json().catch(() => ({}));
      setState(res.ok ? { sent: true } : { error: body.error || `Could not send (${res.status})` });
    } catch {
      setState({ error: "Could not send: are you online?" });
    }
  };

  return (
    <div className="kq-overlay" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="kq-dialog kq-feedback" role="dialog" aria-modal="true" aria-labelledby="kq-feedback-title" onKeyDown={(event) => event.stopPropagation()}>
        <div className="kq-dialog__head">
          <h2 id="kq-feedback-title">Feedback</h2>
          <button type="button" className="kq-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        {state.sent ? (
          <>
            <p>Thanks! We read every report and decide together what to build.</p>
            <div className="scenes-row">
              <button type="button" className="scenes-btn scenes-btn--primary" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="kq-feedback__kinds" role="radiogroup" aria-label="Kind">
              {(
                [
                  ["bug", "Bug report"],
                  ["change", "Change request"],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className={clsx("kq-feedback__kind", { "kq-feedback__kind--on": kind === value })}>
                  <input type="radio" name="kq-feedback-kind" checked={kind === value} onChange={() => setKind(value)} />
                  {label}
                </label>
              ))}
            </div>
            <input
              className="scenes-input"
              placeholder={kind === "bug" ? "What went wrong? (short)" : "What would you like? (short)"}
              value={title}
              maxLength={TITLE_MAX}
              onChange={(event) => setTitle(event.target.value)}
            />
            <textarea
              className="scenes-input kq-feedback__text"
              placeholder={kind === "bug" ? "What did you do, what happened, what did you expect?" : "What should change, and why?"}
              value={text}
              maxLength={TEXT_MAX}
              rows={6}
              onChange={(event) => setText(event.target.value)}
            />
            <div className="kq-muted kq-feedback__hint">
              Plain text, up to {TEXT_MAX} characters ({TEXT_MAX - text.length} left). No personal data, please. The scene you
              have open is sent along by name.
            </div>
            {state.error && <div className="scenes-error">{state.error}</div>}
            <div className="scenes-row">
              <button type="button" className="scenes-btn scenes-btn--primary" disabled={state.sending} onClick={send}>
                {state.sending ? "Sending…" : "Send"}
              </button>
              <button type="button" className="scenes-btn" onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

const FeedbackLink = () => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="kq-legal__feedback" onClick={() => setOpen(true)}>
        Feedback
      </button>
      {open && createPortal(<FeedbackDialog onClose={() => setOpen(false)} />, document.querySelector(".excalidraw") ?? document.body)}
    </>
  );
};

export const KurviqLegalLinks = () => (
  <span className="kq-legal">
    <FeedbackLink />
    <a href="/imprint" target="_blank" rel="noopener">
      Imprint
    </a>
    <a href="/privacy" target="_blank" rel="noopener">
      Privacy
    </a>
  </span>
);

export const KurviqFooter = () => (
  <footer className="kq-footer">
    <strong>Kurviq</strong> · built on{" "}
    <a href="https://github.com/excalidraw/excalidraw" target="_blank" rel="noopener noreferrer">
      Excalidraw
    </a>{" "}
    (unofficial, not affiliated) ·{" "}
    <a href="/llms.txt" target="_blank" rel="noopener">
      for AI agents
    </a>{" "}
    ·{" "}
    <a href="https://github.com/tecsteps/kurviq" target="_blank" rel="noopener noreferrer">
      source (MIT)
    </a>{" "}
    ·{" "}
    <a href="/third-party-licenses.txt" target="_blank" rel="noopener">
      licenses
    </a>{" "}
    ·{" "}
    <a href="/imprint" target="_blank" rel="noopener">
      imprint
    </a>{" "}
    ·{" "}
    <a href="/privacy" target="_blank" rel="noopener">
      privacy
    </a>
  </footer>
);
