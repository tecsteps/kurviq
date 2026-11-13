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
import { QuickTip } from "../quickTip";
import { LEGACY_ACCOUNT_KEY, OWN_SPACE_KEY, ownSpaceTarget, spaceMoves } from "../spaces";
import { currentSpace, moveSpaceData } from "../storage";

import {
  CONNECTING_KEY,
  FOLDER_NAME,
  announceSignIn,
  changeRole,
  checkConnection,
  claimPubName,
  connectGoogle,
  connection,
  disconnectGoogle,
  driveWebLink,
  enterSpace,
  folderSharingOf,
  getByline,
  linkAccessOf,
  listPermissions,
  loadPubName,
  pubLink,
  pubNameHolder,
  pubNameStore,
  releasePubName,
  removeAccess,
  setByline,
  setLinkAccess,
  shareLink,
  sharedFileId,
  sharedFolderId,
  signOutListeners,
  spaceAccount,
} from "./drive";
import { pairing } from "./pairing";
import { liveSync } from "./liveSync";
import { PUB_MAX, pubNameProblem, toPubName } from "./pubName";

import { TEXT_MAX, TITLE_MAX, cleanFeedback } from "../../../scenes-mcp/feedback.mjs";
import type { SceneListItem } from "../controller";
import type { FolderSharing, LinkAccess, Permission } from "./drive";
import { audienceText, folderAudience, rowAccess } from "./folderAccess";
import type { RowAccess } from "./folderAccess";

import lilitaLatin from "@excalidraw/excalidraw/fonts/Lilita/Lilita-Regular-i7dPIFZ9Zz-WBtRtedDbYEF8RXi4EwQ.woff2";

import { deck, isDeck } from "../deck";
import { appVersion, isAutoReloading, reloadApp } from "./version";
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
/** the address the page was opened with (the router may rewrite it before the sign-in is known) */
const landing = (() => {
  const url = new URL(window.location.href);
  url.searchParams.delete("google");
  return url;
})();
/** the tab worked in its space once (a later switch starts from where it is then, not from `landing`) */
let settledInSpace = false;

// after signing in: a short dialog (sync is on / Drive access missing)
type Setup = null | { step: "done"; candidates: { name: string; ticked: boolean }[] } | { step: "nodrive" };

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

/** signed in just now: the scenes only in this browser the user hasn't decided on (the dialog asks) */
const activateSync = async () => {
  scenesController.syncNow({ refresh: true }).catch((error) => console.error("[drive]", error));
  return scenesController.signInCandidates();
};

const legacyAccount = () => {
  try {
    return localStorage.getItem(LEGACY_ACCOUNT_KEY);
  } catch {
    return null;
  }
};

/** pages that are not one of the user's own scenes keep their address when the tab changes space */
const KEEP_PATH = /^\/(?:s|pub)\/|^\/features(?:\/|$)/;

/**
 * Where the tab goes in its new space: pages that are no own scene stay, and
 * a scene's address (e.g. a link opened signed out, then signed in) unless
 * that scene was one of the old space's and did not come along under its
 * name: then the new space's open scene ("/").
 */
const pathAfterSwitch = (oldScenes: Set<string>, renames: Map<string, string>) => {
  const from = settledInSpace ? new URL(window.location.href) : landing;
  const { pathname } = from;
  if (KEEP_PATH.test(pathname)) {
    return from.href;
  }
  let name: string | null = null;
  try {
    name = decodeURIComponent(pathname.slice(1));
  } catch {}
  const kept = !!name && (!oldScenes.has(name) || renames.get(name) === name);
  return kept ? from.href : `${window.location.origin}/`;
};

let switching = false;

/**
 * This tab's own scenes are another space's now (signed in with an account,
 * or signed out): the open scene is stored, scenes that move along move (see
 * spaceMoves), and the page reloads into the space. A sign-in's answer goes
 * along, so the dialog after sign-in still appears there.
 */
const switchOwnSpace = async (target: string, signIn: string | null) => {
  if (switching) {
    return;
  }
  switching = true;
  const oldScenes = new Set(scenesController.getState().list.flatMap((item) => (item.name ? [item.name] : [])));
  await scenesController.leaveForReload();
  const legacy = legacyAccount();
  let renames = new Map<string, string>();
  const moves = async () => {
    for (const move of spaceMoves(currentSpace, target, legacy)) {
      const moved = await moveSpaceData(move.from, move.to, move.keepSync); // NOSONAR S9382: in order on purpose (moves write the same stores)
      if (move.to === target) {
        renames = moved;
      }
    }
    if (legacy) {
      localStorage.removeItem(LEGACY_ACCOUNT_KEY);
    }
  };
  try {
    // one tab at a time (several tabs may follow the same sign-in)
    await (navigator.locks ? navigator.locks.request("kurviq-space-move", moves) : moves());
  } catch (error) {
    // nothing is lost: the scenes stay where they were (the move clears its source last)
    console.error("[drive] could not move the scenes to the account's space", error);
  }
  try {
    if (target) {
      localStorage.setItem(OWN_SPACE_KEY, target);
    } else {
      localStorage.removeItem(OWN_SPACE_KEY);
    }
  } catch {}
  const url = new URL(pathAfterSwitch(oldScenes, renames));
  if (signIn) {
    url.searchParams.set("google", signIn);
    try {
      sessionStorage.setItem(CONNECTING_KEY, String(Date.now()));
    } catch {}
  }
  window.location.replace(url.toString());
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
    if (answer === "connected" || answer === "nodrive") {
      notice = null;
    } else if (answer === "cancelled") {
      notice = "Sign-in cancelled.";
    } else {
      notice = "Sign-in failed. Please try again.";
    }
    const params = new URLSearchParams(window.location.search);
    params.delete("google");
    const query = params.toString();
    const suffix = query ? `?${query}` : "";
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${suffix}`);
  }

  // only the tab that went to Google acts on its answer (a link with ?google=connected does nothing)
  let asked = false;
  try {
    asked = Date.now() - Number(sessionStorage.getItem(CONNECTING_KEY) || 0) < 30 * 60_000;
    sessionStorage.removeItem(CONNECTING_KEY);
  } catch {}
  let afterSignIn = asked ? answer : null;
  if (answer === "connected" || answer === "nodrive") {
    // the other tabs check who is signed in now (only a check: harmless for a link carrying the answer)
    announceSignIn();
  }
  // signed out on purpose: the tab leaves the account's scenes (they stay in this browser for its next sign-in)
  signOutListeners.add(() => {
    if (spaceAccount) {
      switchOwnSpace("", null).catch((error) => console.error("[drive]", error));
    } else if (sharedFileId || sharedFolderId) {
      try {
        localStorage.removeItem(OWN_SPACE_KEY);
      } catch {}
    }
  });
  let last = "";
  connection.subscribe(() => {
    const { user, drive } = connection.getState();
    if (user === undefined) {
      return;
    }
    const target = ownSpaceTarget(currentSpace, user?.email ?? null, legacyAccount());
    if (target !== null) {
      // these scenes are not this account's: the tab moves to the account's own (nothing syncs before)
      scenesController.setSignedIn(false);
      switchOwnSpace(target, afterSignIn).catch((error) => console.error("[drive]", error));
      return;
    }
    settledInSpace = true;
    // a shared folder takes new scenes like the user's own (when they may edit it); a shared scene doesn't
    scenesController.setSignedIn(!!user && drive && !sharedFileId);
    if (afterSignIn) {
      const what = afterSignIn;
      afterSignIn = null;
      if (user && !drive) {
        setSetup({ step: "nodrive" });
      } else if (user && what === "connected" && !sharedFileId && !sharedFolderId && !window.location.pathname.startsWith("/s/")) {
        activateSync().then((candidates) => setSetup({ step: "done", candidates })).catch((error) => console.error("[drive]", error));
      }
    }
    const key = JSON.stringify([user?.email ?? null, drive]);
    if (key !== last) {
      last = key;
      scenesController.syncNow({ refresh: true }).catch((error) => console.error("[drive]", error));
    }
  });
  checkConnection().catch((error) => console.error("[drive]", error));
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
  <>
    <button type="button" className="scenes-btn kq-google-btn" onClick={() => connectGoogle()}>
      <span className="kq-icon">{GoogleIcon}</span> {label}
    </button>
    {/* the terms become part of the agreement where the server starts working for you (§305(2) BGB) */}
    <span className="kq-terms-note">
      By signing in you accept the{" "}
      <a href="/terms" target="_blank" rel="noopener">
        terms
      </a>
      .
    </span>
  </>
);

/** in the scene dropdown: offer Google while not signed in */
export const ConnectDriveOffer = () => {
  const { user } = useConnection();
  if (user !== null) {
    return null;
  }
  return (
    <div className="kq-switcher-signin">
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
        Fabian {LinkedInIcon}
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
    <>
      <WelcomeScreen.Center.MenuItem onSelect={() => connectGoogle()} icon={GoogleIcon} shortcut={null}>
        Sign in with Google to sync
      </WelcomeScreen.Center.MenuItem>
      <span className="kq-terms-note kq-terms-note--welcome">
        By signing in you accept the{" "}
        <a href="/terms" target="_blank" rel="noopener">
          terms
        </a>
        .
      </span>
    </>
  );
};

const confirmSignOut = () => {
  if (
    window.confirm(
      "Sign out of Google in this browser? This account's scenes stay in this browser and come back, synced again, when you sign in with it. Signed out (or with another account) you see other scenes.",
    )
  ) {
    disconnectGoogle().catch((error) => console.error("[drive]", error));
  }
};

/** top of the Scenes sidebar: the Google Drive connection of this browser */
export const DrivePanel = () => {
  const { user, drive, error, needsAccess, lost } = useConnection();
  const { remote } = useSyncExternalStore(scenesController.subscribe, scenesController.getState);

  if (user === undefined) {
    return <section className="kq-card kq-muted">Checking Google sign-in…</section>;
  }
  if (!user && spaceAccount) {
    // the sign-in expired (not signed out on purpose): the account's scenes stay on screen
    return (
      <section className="kq-card">
        {notice && <div className="kq-notice">{notice}</div>}
        <div className="kq-card__title">Not signed in any more</div>
        <div className="kq-muted">
          These are the scenes of {spaceAccount}. Your changes are kept in this browser; sign in with that account to
          sync them with Google Drive again.
        </div>
        {error && <div className="scenes-error">{error}</div>}
        <div className="scenes-row">
          <SignInButton label="Sign in again" />
        </div>
      </section>
    );
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
  // a shared folder's tab looks like the user's own (the scene list says whose scenes these are)
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
    <section className="kq-card kq-card--folder">
      {sharedFolderId && lost && <div className="kq-notice">{lost}</div>}
      <a className="scenes-folder" href={folderUrl()} target="_blank" rel="noopener noreferrer" title="Open the folder in Google Drive">
        <span className="scenes-folder__logo">{DriveIcon}</span>
        <span className="scenes-folder__text">
          <span className="scenes-folder__caption">Synced with Google Drive</span>
          <span className="scenes-folder__name">{FOLDER_NAME}</span>
        </span>
        <span className="scenes-folder__external">{ExternalLinkIcon}</span>
      </a>
      <div className="kq-folder-actions">
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

/** kurviq.com/pub/<short name> if the scene has one, else kurviq.com/s/<fileId>/<name> (?present: starts presenting) */
const sceneLink = (fileId: string, name: string, { present = false } = {}) => {
  const short = pubNameStore.get(fileId);
  return `${short ? pubLink(short) : shareLink(fileId, name)}${present ? "?present" : ""}`;
};

/** a file's short name, asked for once per tab (undefined while not known) */
const usePubName = (fileId: string | null | undefined) => {
  const name = useSyncExternalStore(pubNameStore.subscribe, () => (fileId ? pubNameStore.get(fileId) : undefined));
  useEffect(() => {
    if (fileId && pubNameStore.get(fileId) === undefined) {
      loadPubName(fileId).catch(() => {});
    }
  }, [fileId]);
  return name;
};

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
        {copied && !label ? "✓" : icon}
        {label && (copied ? "Copied ✓" : label)}
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
  if (item?.name === null || item?.localOnly || !item) {
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
      strokeWidth="1.25"
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

if (import.meta.env.DEV || import.meta.env.VITE_APP_GOOGLE_API_BASE) {
  // end-to-end tests (dev, and builds for the fake Google): the share dialog without the menus
  (window as any).__openShareDialog = openShareDialog;
}
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

const shortLinkState = (holder: string | null, fileId: string) => {
  if (holder === null) {
    return "free";
  }
  return holder === fileId ? "own" : "taken";
};

const shortLinkStatus = (problem: string | null, wanted: string, state: string | null) => {
  if (problem) {
    return { text: wanted ? problem : "Type a name", tone: "muted" };
  }
  if (state === "free") {
    return { text: "✓ Available", tone: "ok" };
  }
  if (state === "taken") {
    return { text: "Already taken: try another name", tone: "bad" };
  }
  if (state === "own") {
    return { text: "This is the scene's short link already", tone: "muted" };
  }
  if (state === "unknown") {
    return { text: "Could not check right now: it is checked when you save", tone: "muted" };
  }
  return { text: "Checking…", tone: "muted" };
};

/** the short-link dialog over the share dialog: pick a name, see right away whether it is free */
const ShortLinkDialog = ({
  fileId,
  sceneName,
  current,
  restricted,
  onClose,
}: {
  fileId: string;
  sceneName: string;
  current: string | null;
  restricted: boolean;
  onClose: () => void;
}) => {
  const [value, setValue] = useState(current ?? toPubName(sceneName));
  // free / taken (by another scene) / this scene's own / being asked / couldn't ask
  const [check, setCheck] = useState<{ name: string; state: "free" | "taken" | "own" | "checking" | "unknown" } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // a hyphen at the end is where the next word starts while typing: left out
  let end = value.length;
  while (end > 0 && value[end - 1] === "-") {
    end--;
  }
  const wanted = value.slice(0, end);
  const problem = pubNameProblem(wanted);

  useEffect(() => {
    if (problem) {
      setCheck(null);
      return;
    }
    setCheck({ name: wanted, state: "checking" });
    const timer = window.setTimeout(() => {
      pubNameHolder(wanted)
        .then((holder) => setCheck({ name: wanted, state: shortLinkState(holder, fileId) }))
        .catch(() => setCheck({ name: wanted, state: "unknown" }));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [wanted, problem, fileId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopImmediatePropagation();
        onClose();
      }
    };
    // capture: before the share dialog's own Escape
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const state = check?.name === wanted ? check.state : null;
  const canSave = !problem && !busy && (state === "free" || state === "unknown");
  const save = async () => {
    if (!canSave) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await claimPubName(fileId, wanted);
      onClose();
    } catch (err: any) {
      setError(err.message);
      if (err.status === 409) {
        setCheck({ name: wanted, state: "taken" });
      }
    } finally {
      setBusy(false);
    }
  };

  const saveLabel = current ? "Save" : "Make short link";
  const status = shortLinkStatus(problem, wanted, state);

  return (
    <div className="kq-overlay kq-overlay--top" onClick={(event) => event.target === event.currentTarget && onClose()}>{/* NOSONAR S6848: existing dialog layout and pointer event handling must stay unchanged; S1082: existing dialog layout and pointer event handling must stay unchanged */}
      <div className="kq-dialog kq-dialog--narrow kq-share kq-pub" role="dialog" aria-modal="true" aria-labelledby="kq-pub-title">{/* NOSONAR S6819: existing layout and Excalidraw styles must stay unchanged */}
        <div className="kq-dialog__head">
          <h2 id="kq-pub-title">{current ? "Change the short link" : "Make a short link"}</h2>
          <button type="button" className="kq-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <p className="kq-muted">A short, readable address for "{sceneName}". The long link keeps working.</p>
        <form
          className="kq-pub__form"
          onSubmit={(event) => {
            event.preventDefault();
            save().catch((error) => console.error("[share]", error));
          }}
        >
          <label className={clsx("kq-pub__field", status.tone === "bad" && "kq-pub__field--bad", status.tone === "ok" && "kq-pub__field--ok")}>
            <span className="kq-pub__prefix">{pubLink("").replace(/^https?:\/\//, "")}</span>
            <input
              autoFocus
              value={value}
              maxLength={PUB_MAX}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              aria-label="Short name"
              aria-describedby="kq-pub-status"
              onChange={(event) =>
                // typed as it will be: lowercase, spaces and other characters become hyphens
                setValue(
                  event.target.value
                    .normalize("NFKD")
                    .replace(/[\u0300-\u036f]/g, "")
                    .toLowerCase()
                    .replace(/[^a-z0-9-]+/g, "-")
                    .replace(/-{2,}/g, "-")
                    .replace(/^-+/, "")
                    .slice(0, PUB_MAX),
                )
              }
              onFocus={(event) => event.target.select()}
            />
          </label>
          <div id="kq-pub-status" className={`kq-pub__status kq-pub__status--${status.tone}`} role="status">{/* NOSONAR S6819: existing layout and Excalidraw styles must stay unchanged */}
            {status.text}
          </div>
          <p className="kq-muted kq-pub__rules">
            Lowercase letters, digits and hyphens, {3} to {PUB_MAX} characters. Short links are unique on Kurviq: first
            come, first served.
          </p>
          {restricted && (
            <p className="kq-notice">
              Only people you shared the scene with can open it. For everyone, set General access to "Anyone with the
              link can view".
            </p>
          )}
          {error && <p className="scenes-error">{error}</p>}
          <div className="kq-pub__actions">
            <button type="button" className="scenes-btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="scenes-btn scenes-btn--primary" aria-disabled={!canSave || undefined} disabled={busy}>
              {busy ? "Saving…" : saveLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

/** the author on the public page: the user's Google name, only if they choose */
const Byline = ({ fileId }: { fileId: string }) => {
  const me = connection.getState().user?.name ?? null;
  const [by, setBy] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getByline(fileId)
      .then(setBy)
      .catch(() => setBy(null));
  }, [fileId]);
  if (by === undefined || (!me && !by)) {
    return null;
  }
  const change = async (on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await setByline(fileId, on ? me : null);
      setBy(on ? me : null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <label className="scenes-switch">
        <input type="checkbox" checked={!!by} disabled={busy || (!me && !by)} onChange={(event) => change(event.target.checked)} />
        <span className="scenes-switch__track" />
        <span className="scenes-switch__label">
          Show {by && by !== me ? `"${by}"` : "my name"} on the public page
          <span className="scenes-switch__hint">{`"by ${by || me}" under the title, for everyone who opens the link`}</span>
        </span>
      </label>
      {error && <p className="scenes-error">{error}</p>}
    </>
  );
};

/** the share dialog's short link: kurviq.com/pub/<name> with copy / change / remove, or a button to make one */
const ShortLink = ({ fileId, sceneName, restricted }: { fileId: string; sceneName: string; restricted: boolean }) => {
  const name = usePubName(fileId);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (name === undefined) {
    return null;
  }
  return (
    <div className="kq-pub__row">
      <span className="kq-field">Short link</span>
      {name ? (
        <div className="scenes-row">
          <code className="kq-pub__link">{pubLink(name).replace(/^https?:\/\//, "")}</code>
          <CopyLink className="scenes-btn" link={pubLink(name)} label="Copy" tip="Copies the short link" />
          <button type="button" className="scenes-link" onClick={() => setEditing(true)}>
            Change
          </button>
          <button
            type="button"
            className="scenes-link scenes-link--danger"
            onClick={() => {
              setError(null);
              releasePubName(fileId, name).catch((err) => setError(err.message));
            }}
          >
            Remove
          </button>
        </div>
      ) : (
        <div className="scenes-row">
          <button type="button" className="scenes-btn" onClick={() => setEditing(true)}>
            {LINK_ICON} Make a short link…
          </button>
          <span className="kq-muted">like kurviq.com/pub/{toPubName(sceneName) || "my-talk"}</span>
        </div>
      )}
      {error && <p className="scenes-error">{error}</p>}
      {editing && (
        <ShortLinkDialog fileId={fileId} sceneName={sceneName} current={name} restricted={restricted} onClose={() => setEditing(false)} />
      )}
    </div>
  );
};

const ROLE_TEXT: Record<string, string> = { writer: "can edit", reader: "can view", commenter: "can view" };

/** above the people: the scene's folder is shared, so these people have every scene in it */
const FolderNote = ({ folder, onShareFolder }: { folder: FolderSharing; onShareFolder?: () => void }) => {
  if (folder.kind === "theirs") {
    return (
      <p className="kq-share__folder">
        You have this scene through the Kurviq folder of <strong>{folder.owner}</strong>
        {folder.ownerEmail ? ` (${folder.ownerEmail})` : ""}, shared with you (you {ROLE_TEXT[folder.role]}).
      </p>
    );
  }
  const text = audienceText(folderAudience(folder.permissions));
  if (!text) {
    return null;
  }
  return (
    <p className="kq-share__folder kq-share__folder--mine">
      Your folder <strong>"{folder.name}"</strong> is shared with {text.whom}: they {text.what}.{" "}
      <button
        type="button"
        className="kq-share__textbtn"
        title="Opens the folder in Google Drive: click the people icon next to its name"
        onClick={onShareFolder}
      >
        Folder sharing…
      </button>
    </p>
  );
};

/** where a person's access comes from, under their address (only when the folder is shared) */
const accessNote = (access: RowAccess, folder: FolderSharing | null) => {
  if (folder?.kind !== "mine") {
    return null;
  }
  switch (access.kind) {
    case "folder":
      return `Whole folder "${folder.name}"`;
    case "more":
      return `This scene; ${ROLE_TEXT[access.folderRole] ?? "can view"} the whole folder`;
    default:
      return "This scene only";
  }
};

const ShareDialog = ({ name }: { name: string }) => {
  const [fileId, setFileId] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<Permission[] | null>(null);
  const [folder, setFolder] = useState<FolderSharing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const me = connection.getState().user?.email?.toLowerCase();
  const presentation = isDeck(useSyncExternalStore(deck.subscribe, deck.getState));
  // a scene of a folder shared with this person: Kurviq reaches it only through its server, who has access is the owner's business
  const inFolderSpace = !!sharedFolderId;

  const reload = async (id: string) => {
    if (inFolderSpace) {
      setPermissions([]);
      return;
    }
    setPermissions(await listPermissions(id));
  };
  const reloadFolder = (id: string) => {
    folderSharingOf(id).then(setFolder, (err) => console.error("[drive] the scene's folder", err));
  };

  useEffect(() => {
    scenesController
      .fileForSharing(name)
      .then(async (id) => {
        setFileId(id);
        reloadFolder(id);
        await reload(id);
      })
      .catch((err) => setError(err.message));
  }, [name]);

  // back from sharing in Drive's own window: show who has access now
  useEffect(() => {
    if (!fileId) {
      return;
    }
    const onFocus = () => {
      reload(fileId).catch(() => {});
      reloadFolder(fileId);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [fileId]);

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
      scenesController.syncNow({ refresh: true }).catch((error) => console.error("[drive]", error));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Drive's own page of the scene or its folder in a small window, as the
   * account signed in to Kurviq (authuser): Share at its top right sends
   * Google's normal invitations. (Google's in-page share dialog runs as the
   * browser's first Google account: with another one first it hangs.)
   * Back here, the focus listener above shows who has access now.
   */
  const shareInDrive = (id: string, isFolder: boolean) => {
    if (!window.open(driveWebLink(id, isFolder), "kurviq-drive-share", "popup,width=1100,height=780")) {
      setError("Your browser blocked Google Drive's window: allow pop-ups for this site and try again.");
    }
  };

  const people = (permissions ?? []).filter((permission) => permission.type !== "anyone");
  const access = permissions ? linkAccessOf(permissions) : "restricted";
  const folderPermissions = folder?.kind === "mine" ? folder.permissions : [];
  // the copy buttons give the short link once there is one
  usePubName(fileId);
  const link = fileId ? sceneLink(fileId, name) : null;

  return (
    <div className="kq-overlay" onClick={(event) => event.target === event.currentTarget && closeShareDialog()}>{/* NOSONAR S6848: existing dialog layout and pointer event handling must stay unchanged; S1082: existing dialog layout and pointer event handling must stay unchanged */}
      <div className="kq-dialog kq-dialog--narrow kq-share" role="dialog" aria-modal="true" aria-labelledby="kq-share-title">{/* NOSONAR S6819: existing layout and Excalidraw styles must stay unchanged */}
        <div className="kq-dialog__head">
          <h2 id="kq-share-title">Share "{name}"</h2>
          <button type="button" className="kq-close" aria-label="Close" onClick={closeShareDialog}>
            ×
          </button>
        </div>
        {!permissions && !error && <p className="kq-muted">Saving it to Google Drive and asking who has access…</p>}
        {permissions && folder?.kind === "theirs" && <FolderNote folder={folder} />}
        {permissions && !inFolderSpace && (
          <>
            <div className="kq-share__head">
              <span>People with access</span>
              <button
                type="button"
                className="scenes-btn scenes-btn--primary"
                title={`Opens the scene in Google Drive${me ? ` as ${me}` : ""}: click Share at the top right. Google emails them an invitation; in Kurviq they find the scene under "Shared with you…", or with the link.`}
                onClick={() => shareInDrive(fileId!, false)}
              >
                Add people
              </button>
            </div>
            <ul className="kq-share__people">
              {people.map((person) => {
                const isMe = person.emailAddress?.toLowerCase() === me;
                const from = rowAccess(person, folderPermissions);
                const note = accessNote(from, folder);
                const fixed = person.role === "owner" || isMe || from.kind === "folder";
                return (
                  <li key={person.id}>
                    <span className="kq-share__avatar" aria-hidden="true">
                      {(person.displayName || person.emailAddress || person.domain || "?").charAt(0).toUpperCase()}
                    </span>
                    <span className="kq-share__who">
                      <span className="kq-share__name">
                        {person.displayName || person.emailAddress || person.domain}
                        {isMe && " (you)"}
                      </span>
                      {person.displayName && person.emailAddress && <span className="kq-muted">{person.emailAddress}</span>}
                      {note && !isMe && person.role !== "owner" && <span className="kq-share__from">{note}</span>}
                    </span>
                    {fixed ? (
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
                        {from.kind === "direct" && <option value="remove">Remove access</option>}
                      </select>
                    )}
                  </li>
                );
              })}
            </ul>
            {folder?.kind === "mine" && <FolderNote folder={folder} onShareFolder={() => shareInDrive(folder.folderId, true)} />}
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
            {fileId && access !== "restricted" && <Byline fileId={fileId} />}
            {fileId && <ShortLink fileId={fileId} sceneName={name} restricted={access === "restricted"} />}
          </>
        )}
        {permissions && (
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
          </div>
        )}
        {error && <p className="scenes-error">{error}</p>}
      </div>
    </div>
  );
};

/** in the current scene's actions: Share… and the link */
export const SceneSharing = ({ item, iconOnly }: { item: SceneListItem; disabled?: boolean; iconOnly?: boolean }) => {
  useConnection();
  usePubName(item.name === null ? null : item.fileId);
  if (item.name === null || notShareable(item, "scene")) {
    return null;
  }
  const name = item.name;
  const audience = item.public ? "anyone with it can view it" : "only people you share it with can open it";
  return (
    <CopyLink
      link={item.fileId ? sceneLink(item.fileId, name) : null}
      label={iconOnly ? "" : "Copy link"}
      icon={iconOnly ? LINK_ICON : undefined}
      className={iconOnly ? "scenes-icon-btn" : undefined}
      tip={item.fileId ? `Copies the link to this scene (${audience})` : "Not in Google Drive yet: you can copy its link once it has synced"}
    />
  );
};

/** Kurviq was updated while this tab was open: the agent's commands wait for a reload */
export const UpdateBanner = () => {
  const outdated = useSyncExternalStore(appVersion.subscribe, appVersion.isOutdated);
  return outdated ? (
    <div className="kq-update" role="status">{/* NOSONAR S6819: existing layout and Excalidraw styles must stay unchanged */}
      <span>{isAutoReloading() ? "Kurviq was updated: reloading in a moment (your work is saved)…" : "Kurviq was updated. Reload to continue with your agent (your work is saved)."}</span>
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
    <div className="kq-readonly" role="status">{/* NOSONAR S6819: existing layout and Excalidraw styles must stay unchanged */}
      Read only: {readOnly}
    </div>
  ) : null;
};

/** what the engine or the scene's server reports, in words (null: nothing to show) */
const liveProblem = (error: string | null) => {
  if (!error) {
    return null;
  }
  const known: Record<string, string> = {
    "drive-full": "The owner's Google Drive is full: changes stay on Kurviq's server until there is room.",
    "rate-limited": "Google Drive asked to slow down: saving continues in a moment.",
    "google-unreachable": "Google is not reachable: changes stay on Kurviq's server and are saved later.",
    "key-changed": "The scene's key in Drive was changed: changes can't be saved until that is sorted out.",
    "key-missing": "The scene's key is missing in Drive: changes can't be saved until that is sorted out.",
    "key-busy": "The scene is being set up for live saving…",
    "key-invalid": "The scene's key could not be read: changes stay in this browser.",
    "pins-full": "Drive's limit of kept versions is reached: no more milestones are kept.",
    "no-key-yet": "Live changes start once an editor opens this scene.",
    "signed-out": "Sign in again to keep saving: your changes stay in this browser.",
    "sign-in-again": "Sign in again to keep saving: your changes stay in this browser.",
    "signed-out-everywhere": "You were signed out everywhere: sign in again to keep saving.",
    "access-unknown": "Kurviq can't check your access to this scene in Drive right now: saving waits until it can.",
    "audit-failed": "A save to Drive could not be checked afterwards: Kurviq keeps the changes and tries again.",
    "audit-pins-full": "Drive's limit of kept versions is reached: the record of who saved what can't be kept as a version.",
    "outside-too-big": "Someone changed this scene outside Kurviq and the result is too big to merge: changes stay on Kurviq's server.",
    "font-full": "This scene has no free font number left: text with a new font can't be saved (use a font the scene already has).",
    "too-many-tabs": "This scene is open in too many tabs of yours: close some of them (your changes wait in this browser meanwhile).",
    "too-many-connections": "Kurviq's server can't take another connection to this scene right now: close other tabs with it, it tries again shortly.",
  };
  if (error.startsWith("invalid:")) {
    return "A change could not be saved (not a valid drawing): the rest keeps saving.";
  }
  if (error === "no-access" || error.startsWith("seed-")) {
    return null; // shown elsewhere (the Picker), or passing
  }
  return known[error] ?? error;
};

const lifecycleMessage = (lifecycle: string | null) => {
  if (lifecycle === "trashed") {
    return "This scene is in Drive's trash: it isn't saved any more. Save as… keeps your version as a new scene.";
  }
  if (lifecycle === "deleted") {
    return "This scene was deleted for good in Drive. Save as… keeps your version as a new scene.";
  }
  if (lifecycle === "access") {
    return "You no longer have access to this scene in Drive: your changes stay in this browser.";
  }
  if (lifecycle === "local" || lifecycle === "closing") {
    return "This scene was taken out of Drive.";
  }
  return null;
};

const appendBlockedAuthors = (items: ReactNode[], decidable: ReturnType<NonNullable<ReturnType<typeof scenesController.liveCurrent>>["info"]>["blocked"], scene: NonNullable<ReturnType<typeof scenesController.liveCurrent>>) => {
  for (const author of decidable) {
    // an author who lost access to the scene: their changes can only be discarded (or go after 7 days)
    const acceptable = author.acceptable !== false;
    items.push(
      <div key={`blocked-${author.pseudonym}`} className="kq-live__item">
        {author.name ?? "Someone"}'s changes could not be saved
        {acceptable ? "." : " (they no longer have access): they can be discarded now, and are discarded after 7 days."}
        {acceptable && (
          <button type="button" className="scenes-link" onClick={() => scene.decide(author.pseudonym, "accept")}>
            Accept them as yours
          </button>
        )}
        <button
          type="button"
          className="scenes-link scenes-link--danger"
          onClick={() => window.confirm(`Discard ${author.name ?? "these"} changes for good?`) && scene.decide(author.pseudonym, "discard")}
        >
          Discard
        </button>
      </div>,
    );
  }
};

const appendLostChanges = (items: ReactNode[], info: ReturnType<NonNullable<ReturnType<typeof scenesController.liveCurrent>>["info"]>, scene: NonNullable<ReturnType<typeof scenesController.liveCurrent>>) => {
  for (const loser of info.losers) {
    items.push(
      <div key={`lost-${loser.id}`} className="kq-live__item">
        {loser.by ?? "Someone"} changed this at the same time.
        <button type="button" className="scenes-link" onClick={() => scene.restoreLoser(loser.id)}>
          Restore yours?
        </button>
        <button type="button" className="scenes-link" onClick={() => scene.dismissLoser(loser.id)}>
          Keep theirs
        </button>
      </div>,
    );
  }
};

/**
 * Live sync of the open scene: what the user has to see or decide: the
 * scene went to the trash or access ended, someone won a collision over
 * their change ("restore yours?"), changes of an author that can't be saved
 * as theirs, notes (offline copies, undo left something alone), and who
 * else is here.
 */
export const LiveBanner = () => {
  useSyncExternalStore(liveSync.subscribe, liveSync.getVersion);
  useSyncExternalStore(scenesController.subscribe, scenesController.getState);
  const scene = scenesController.liveCurrent();
  if (!scene) {
    return null;
  }
  const info = scene.info();
  const others = info.presence.filter((entry) => entry.pseudonym !== scene.pseudonym());
  const lifecycle = lifecycleMessage(info.lifecycle);
  const decidable = info.role === "edit" ? info.blocked.filter((author) => author.decidable) : [];
  const items: ReactNode[] = [];
  if (lifecycle) {
    items.push(<div key="lifecycle" className="kq-live__item kq-live__item--danger">{lifecycle}</div>);
  }
  if (info.stage === "unsaved") {
    items.push(
      <div key="unsaved" className="kq-live__item kq-live__item--danger">
        This browser could not store your latest changes.
        <button type="button" className="scenes-link" onClick={() => scenesController.exportCurrent()}>{/* NOSONAR S6772: existing button spacing is controlled by the live banner styles */}
          Export the scene
        </button>
      </div>,
    );
  }
  const problem = liveProblem(info.error);
  if (problem) {
    const signIn = info.error === "signed-out" || info.error === "sign-in-again" || info.error === "signed-out-everywhere";
    items.push(
      <div key="error" className="kq-live__item kq-live__item--danger">
        {problem}
        {signIn && (
          <button type="button" className="scenes-link" onClick={() => connectGoogle()}>
            Sign in again
          </button>
        )}
      </div>,
    );
  }
  // a queue an earlier session of this scene left (a reload, a closed tab) that can't be sent
  for (const [i, error] of liveSync.replayProblems(info.fileId).entries()) {
    items.push(
      <div key={`replay-${i}`} className="kq-live__item kq-live__item--danger">
        Changes from an earlier session of this scene wait in this browser: {liveProblem(error) ?? error}
      </div>,
    );
  }
  if (info.waitingForKey) {
    items.push(<div key="key" className="kq-live__item">Your changes wait in this browser until the scene is ready on Kurviq's server…</div>);
  }
  appendLostChanges(items, info, scene);
  appendBlockedAuthors(items, decidable, scene);
  for (const note of info.notes) {
    items.push(
      <div key={`note-${note.at}`} className="kq-live__item">
        {note.text}
        <button type="button" className="scenes-link" aria-label="Dismiss" onClick={() => scene.dismissNote(note.at)}>
          OK
        </button>
      </div>,
    );
  }
  if (!items.length && !others.length) {
    return null;
  }
  return (
    <div className="kq-live" role="status">{/* NOSONAR S6819: existing layout and Excalidraw styles must stay unchanged */}
      {items}
      {others.length > 0 && (
        <div className="kq-live__presence">
          Also here: {[...new Set(others.map((entry) => entry.name ?? "someone"))].join(", ")}
        </div>
      )}
    </div>
  );
};

/** after signing in: which of the scenes only in this browser go to Drive (nothing goes without a tick) */
const SignInChoice = ({ candidates, onDone }: { candidates: { name: string; ticked: boolean }[]; onDone: () => void }) => {
  const [ticked, setTicked] = useState(() => new Set(candidates.filter((entry) => entry.ticked).map((entry) => entry.name)));
  const [busy, setBusy] = useState(false);
  const toggle = (name: string) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(name)) {
        next.add(name);
      }
      return next;
    });
  const decide = async (toDrive: string[]) => {
    setBusy(true);
    await scenesController.decideSignIn(
      toDrive,
      candidates.map((entry) => entry.name).filter((name) => !toDrive.includes(name)),
    );
    onDone();
  };
  return (
    <>
      <p>
        {candidates.length === 1 ? "This scene is" : `These ${candidates.length} scenes are`} only in this browser. Tick
        the ones to put in your Google Drive:
      </p>
      <ul className="kq-choice">
        {candidates.map(({ name }) => (
          <li key={name}>
            <label>
              <input type="checkbox" checked={ticked.has(name)} disabled={busy} onChange={() => toggle(name)} />
              <span>{name}</span>
            </label>
          </li>
        ))}
      </ul>
      <p className="kq-muted">The others stay in this browser only. You can put one in Drive later with its cloud icon.</p>
      <div className="scenes-row">
        <button
          type="button"
          className="scenes-btn scenes-btn--primary"
          disabled={busy || ticked.size === 0}
          onClick={() => decide([...ticked])}
        >
          {ticked.size ? `Put ${ticked.size} in Drive` : "Put in Drive"}
        </button>
        <button type="button" className="scenes-btn" disabled={busy} onClick={() => decide([])}>
          Keep all in this browser
        </button>
      </div>
    </>
  );
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
          New scenes go there, and your changes are saved by themselves as you draw. The cloud icon next to a
          scene moves it in or out of Drive, the lock shares it.
        </p>
        {current.candidates.length > 0 ? (
          <SignInChoice candidates={current.candidates} onDone={close} />
        ) : (
          <div className="scenes-row">
            <button type="button" className="scenes-btn scenes-btn--primary" onClick={close}>
              Start drawing
            </button>
          </div>
        )}
      </>
    );
  return (
    <div className="kq-overlay">
      <div className="kq-dialog kq-dialog--narrow" role="dialog" aria-modal="true" aria-labelledby="kq-setup-title">{/* NOSONAR S6819: existing layout and Excalidraw styles must stay unchanged */}
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
      <div className="kq-dialog" role="dialog" aria-modal="true" aria-labelledby="kq-mcp-title">{/* NOSONAR S6819: existing layout and Excalidraw styles must stay unchanged */}
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
            <path d="M7 3v4M13 3v4M5 7h10v3a5 5 0 0 1-10 0V7zM10 15v3" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
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
      <div className="kq-dialog kq-feedback" role="dialog" aria-modal="true" aria-labelledby="kq-feedback-title" onKeyDown={(event) => event.stopPropagation()}>{/* NOSONAR S6847: existing dialog layout and pointer event handling must stay unchanged; S6819: existing dialog layout and pointer event handling must stay unchanged */}
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
    <a href="/about" target="_blank" rel="noopener">
      About
    </a>
    <a href="/imprint" target="_blank" rel="noopener">
      Imprint
    </a>
    <a href="/privacy" target="_blank" rel="noopener">
      Privacy
    </a>
    <a href="/terms" target="_blank" rel="noopener">
      Terms
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
    </a>{" "}
    ·{" "}
    <a href="/terms" target="_blank" rel="noopener">
      terms
    </a>
  </footer>
);
