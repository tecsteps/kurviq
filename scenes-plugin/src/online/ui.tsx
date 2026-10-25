// Kurviq's own UI (online build only): Connect GitHub (scenes go to the
// private repository <account>/kurviq-scenes), the "MCP" button with the agent link and prompt, and the
// footer (built on Excalidraw, llms.txt).

import { MainMenu, WelcomeScreen } from "@excalidraw/excalidraw";
import { GithubIcon, ExternalLinkIcon } from "@excalidraw/excalidraw/components/icons";
import clsx from "clsx";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";

import { scenesController } from "../controller";
import { PlaceSvg } from "../icons";
import { QuickTip } from "../quickTip";

import { SPACE_KEY, currentSpace, spaceSuffix } from "../storage";

import {
  CONNECTING_KEY,
  SCENES_REPO,
  checkConnection,
  chooseRepo,
  connectGitHub,
  connection,
  copyScenes,
  createScenesRepo,
  disconnectGitHub,
  findScenesRepo,
  isInstalledFor,
  listSpaces,
  newRepoUrl,
  notPrivate,
  storeRepoForSpace,
} from "./github";
import { pairing } from "./pairing";

import { TEXT_MAX, TITLE_MAX, cleanFeedback } from "../../../scenes-mcp/feedback.mjs";
import type { SceneListItem } from "../controller";
import type { RepoChoice, Space } from "./github";

import lilitaLatin from "@excalidraw/excalidraw/fonts/Lilita/Lilita-Regular-i7dPIFZ9Zz-WBtRtedDbYEF8RXi4EwQ.woff2";

import { deck } from "../deck";
import { publicScene } from "../publicScene";
import { appVersion, reloadApp } from "./version";
import { openPublicScene } from "../router";

import "./online.scss";

const useConnection = () => useSyncExternalStore(connection.subscribe, connection.getState);
const usePairingKey = () => useSyncExternalStore(pairing.subscribe, pairing.getKey);

// -----------------------------------------------------------------------------
// start: is this browser connected? (and the answer of a GitHub redirect)
// -----------------------------------------------------------------------------

let notice: string | null = null;
let started = false;
/** the answer of a GitHub redirect, read before anything can rewrite the URL */
const githubAnswer = new URLSearchParams(window.location.search).get("github");

// setting up sync, as a dialog: a space is a GitHub account or organization
// with its <owner>/kurviq-scenes; Kurviq uses it, or creates it, and where it
// can't, the dialog says what to do on GitHub. GitHub decides who may do what.
type Setup =
  | null
  | { step: "working"; owner: string }
  | { step: "create"; owner: string }
  | { step: "access"; owner: string }
  | { step: "move"; owner: string; from: RepoChoice }
  | { step: "error"; owner: string; message: string }
  | { step: "done"; owner: string; repo: RepoChoice; published: number; copied: number };

// what the user did on GitHub in this tab (sessionStorage: survives the trips there)
const CREATED_KEY = "kurviq-setup-created";
const MOVE_KEY = "kurviq-setup-move-from";
/** the old scenes repository the user chose to leave alone */
const KEEP_KEY = "kurviq-keep-repo";

const session = {
  get: (key: string) => {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key: string, value: string | null) => {
    try {
      value === null ? sessionStorage.removeItem(key) : sessionStorage.setItem(key, value);
    } catch {}
  },
};

/** the user created (or already has) <owner>/kurviq-scenes */
const markCreated = (owner: string) => session.set(CREATED_KEY, owner.toLowerCase());
const wasCreated = (owner: string) => session.get(CREATED_KEY) === owner.toLowerCase();
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

/** sync this space with its repository from now on; returns how many local-only scenes went along */
const activateRepo = async (repo: RepoChoice) => {
  const current = connection.getState().repo;
  const switching = !!current && (current.owner !== repo.owner || current.name !== repo.name);
  chooseRepo(repo);
  // from now on new scenes go to GitHub with auto-sync
  scenesController.setNewScenesLocalOnly(false);
  if (switching) {
    await scenesController.resetGitHubState();
  }
  let published = 0;
  if (!repo.readOnly) {
    for (const name of localOnlyScenes()) {
      await scenesController.setLocalOnly(name, false).then(
        () => published++,
        () => {},
      );
    }
  }
  scenesController.syncNow({ refresh: true });
  return published;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** the browser-storage id of a space: "" = the personal one */
const spaceIdOf = (owner: string) =>
  owner.toLowerCase() === connection.getState().user?.login.toLowerCase() ? "" : owner.toLowerCase();

/** the space whose scenes this tab shows (its owner), if sync is set up */
export const spaceOwner = () => connection.getState().repo?.owner ?? null;

/**
 * Switch this tab to another space: its scenes live in their own browser
 * storage, so the page reloads into it (the open scene is kept first).
 */
const enterSpace = async (owner: string, repo: RepoChoice, path = "/") => {
  const space = spaceIdOf(owner);
  storeRepoForSpace(space, repo);
  try {
    const metaKey = `excalidraw-scenes${spaceSuffix(space)}`;
    if (!localStorage.getItem(metaKey)) {
      // a space new to this browser: its new scenes sync (like after setting up sync)
      localStorage.setItem(metaKey, JSON.stringify({ newLocalOnly: false }));
    }
    localStorage.setItem(SPACE_KEY, space);
  } catch {}
  await scenesController.leaveForReload();
  window.location.href = path;
};

/**
 * Sync with <owner>/kurviq-scenes (default: the space of this tab, or the
 * personal one). Another space than this tab's: the tab switches into it,
 * and opens `path` there.
 */
export const setUpSync = async (owner?: string, path?: string) => {
  const login = connection.getState().user?.login;
  if (!login) {
    return;
  }
  owner ??= currentSpace ? spaceOwner() ?? currentSpace : login;
  setSetup({ step: "working", owner });
  try {
    let repo = await findScenesRepo(owner);
    if (!repo) {
      // GitHub shows a private repository only once Kurviq may use it: "not
      // found" means missing, or not shared with Kurviq yet. With the app's
      // Administration permission Kurviq could create it; without it (the
      // default) the user does, in GitHub's form, and then shares it.
      if (!wasCreated(owner) && (await isInstalledFor(owner))) {
        const created = await createScenesRepo(owner);
        if (created === "created") {
          for (let attempt = 0; attempt < 10 && !repo; attempt++) {
            await sleep(1000);
            repo = await findScenesRepo(owner);
          }
        } else if (created === "exists") {
          markCreated(owner);
        }
      }
      if (!repo) {
        setSetup({ step: wasCreated(owner) ? "access" : "create", owner });
        return;
      }
    }
    if (!repo.private) {
      // private scenes never go to a public repository
      setSetup({ step: "error", owner, message: notPrivate(owner) });
      return;
    }
    session.set(CREATED_KEY, null);
    if (spaceIdOf(owner) !== currentSpace) {
      await enterSpace(owner, repo, path);
      return;
    }
    // moving from an older scenes repository: its scenes come along
    const from = JSON.parse(session.get(MOVE_KEY) || "null") as RepoChoice | null;
    const copied = from ? await copyScenes(from, repo) : 0;
    session.set(MOVE_KEY, null);
    setSetup({ step: "done", owner, repo, published: await activateRepo(repo), copied });
  } catch (error: any) {
    setSetup({ step: "error", owner, message: error.message });
  }
};

export const startOnline = () => {
  if (started) {
    return;
  }
  started = true;
  // someone's shared scene: members of that space edit it there
  publicScene.setSpaceOpener((owner, name) => {
    publicScene.close();
    setUpSync(owner, `/${encodeURIComponent(name)}`);
  });
  // keep the scenes even under storage pressure (Safari, full disks)
  navigator.storage?.persist?.().catch(() => {});

  const params = new URLSearchParams(window.location.search);
  const answer = githubAnswer;
  if (answer) {
    notice =
      answer === "connected"
        ? null
        : answer === "cancelled"
        ? "GitHub connection cancelled."
        : "GitHub connection failed — please try again.";
    params.delete("github");
    const query = params.toString();
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  }

  // back from GitHub without sync yet: set it up right away (only if this
  // tab went there to connect: a link with ?github=connected does nothing)
  let asked = false;
  try {
    asked = Date.now() - Number(sessionStorage.getItem(CONNECTING_KEY) || 0) < 30 * 60_000;
    sessionStorage.removeItem(CONNECTING_KEY);
  } catch {}
  let showSetup = answer === "connected" && asked;
  let offeredMove = false;
  let last = "";
  connection.subscribe(() => {
    const { user, repo, lost } = connection.getState();
    if (showSetup && user !== undefined) {
      showSetup = false;
      // (signed in to see someone's shared scene: no setup of one's own then)
      if (user && !repo && !/^\/(@|%40)/i.test(window.location.pathname)) {
        setUpSync();
      }
    }
    // synced with an older scenes repository (from before kurviq-scenes): offer the move, once
    if (user && repo && !lost && !currentSpace && repo.name !== SCENES_REPO && !offeredMove && !/^\/(@|%40)/i.test(window.location.pathname)) {
      offeredMove = true;
      let kept = false;
      try {
        kept = localStorage.getItem(KEEP_KEY) === `${repo.owner}/${repo.name}`;
      } catch {}
      if (!kept && !setup) {
        setSetup({ step: "move", owner: user.login, from: repo });
      }
    }
    const key = JSON.stringify([user?.login ?? null, repo]);
    if (key !== last) {
      last = key;
      scenesController.syncNow({ refresh: true });
    }
  });
  checkConnection();
};

// -----------------------------------------------------------------------------
// sidebar: GitHub
// -----------------------------------------------------------------------------

const repoUrl = (repo: RepoChoice) => `https://github.com/${repo.owner}/${repo.name}`;

/** in the scene dropdown: offer GitHub while it is not connected */
export const ConnectGitHubOffer = () => {
  const { user } = useConnection();
  if (user !== null) {
    return null;
  }
  return (
    <div className="kq-switcher-github">
      <span className="kq-muted">Scenes are saved in this browser only.</span>
      <button type="button" className="scenes-btn scenes-btn--primary" onClick={() => connectGitHub()}>
        <span className="kq-icon">{GithubIcon}</span> Connect GitHub
      </button>
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
  const { user, repo } = useConnection();
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
        {user && repo
          ? "Your drawings are saved in this browser and synced with GitHub."
          : user
          ? "Your drawings are saved in this browser. Set up sync in the Scenes sidebar to keep them in your repository."
          : "Your drawings are saved in this browser. Connect GitHub to keep them safe in your repository."}
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

/** on the welcome screen (injected by ../../vite.config.mts), while GitHub is not connected */
export const WelcomeConnectGitHub = () => {
  const { user } = useConnection();
  if (user !== null) {
    return null;
  }
  return (
    <WelcomeScreen.Center.MenuItem onSelect={() => connectGitHub()} icon={GithubIcon} shortcut={null}>
      Connect GitHub to sync
    </WelcomeScreen.Center.MenuItem>
  );
};

/** top of the Scenes sidebar: the GitHub connection of this browser */
export const GitHubPanel = () => {
  const { user, repo, error, lost } = useConnection();

  if (user === undefined) {
    return <section className="kq-card kq-muted">Checking GitHub connection…</section>;
  }
  if (!user) {
    return (
      <section className="kq-card">
        {notice && <div className="kq-notice">{notice}</div>}
        <div className="kq-card__title">Your scenes are saved in this browser</div>
        <div className="kq-muted">
          No account needed. Connect GitHub to sync them with a repository: on all your devices, with other people
          who use the same repository, and with your coding agents.
        </div>
        {error && <div className="scenes-error">{error}</div>}
        <div className="scenes-row">
          <button type="button" className="scenes-btn scenes-btn--primary" onClick={() => connectGitHub()}>
            <span className="kq-icon">{GithubIcon}</span> Connect GitHub
          </button>
        </div>
        <span className="kq-muted kq-left">
          Your scenes go to the private repository <code>{SCENES_REPO}</code> on your GitHub account.
        </span>
      </section>
    );
  }
  if (lost && repo) {
    return (
      <section className="kq-card">
        <div className="kq-card__title">Sync with {repo.owner}/{repo.name} stopped</div>
        <div className="kq-muted">{lost}. Your scenes are safe in this browser.</div>
        <div className="scenes-row">
          <button type="button" className="scenes-btn scenes-btn--primary" onClick={() => setUpSync(repo.owner)}>
            Set up sync again
          </button>
        </div>
        <SpaceSwitcher />
        <button type="button" className="scenes-link kq-left" onClick={() => disconnectGitHub()}>
          Disconnect GitHub
        </button>
      </section>
    );
  }
  if (!repo) {
    return (
      <section className="kq-card">
        <div className="kq-card__title">
          Connected as <strong>{user.login}</strong>, sync is not set up yet
        </div>
        <div className="kq-muted">
          Your scenes go to the private repository{" "}
          <code>
            {currentSpace || user.login}/{SCENES_REPO}
          </code>
          ; Kurviq creates it if it doesn't exist.
        </div>
        <div className="scenes-row">
          <button type="button" className="scenes-btn scenes-btn--primary" onClick={() => setUpSync()}>
            Set up sync
          </button>
        </div>
        <SpaceSwitcher />
        <button type="button" className="scenes-link kq-left" onClick={() => disconnectGitHub()}>
          Disconnect GitHub
        </button>
      </section>
    );
  }
  return (
    <section className="kq-card kq-card--repo">
      <a className="scenes-repo" href={repoUrl(repo)} target="_blank" rel="noopener noreferrer" title={`Open ${repoUrl(repo)}`}>
        <span className="scenes-repo__logo">{GithubIcon}</span>
        <span className="scenes-repo__text">
          <span className="scenes-repo__caption">
            {repo.readOnly ? "Read only on GitHub" : "Synced with GitHub"}
            <span className="scenes-repo__branch">{repo.branch}</span>
          </span>
          <span className="scenes-repo__name">
            <span className="scenes-repo__owner">{repo.owner}/</span>
            <wbr />
            {repo.name}
          </span>
        </span>
        <span className="scenes-repo__external">{ExternalLinkIcon}</span>
      </a>
      {repo.readOnly && <div className="kq-muted">Read only: {repo.readOnly}.</div>}
      <SpaceSwitcher />
      <div className="kq-repo-actions">
        <span className="kq-muted">as {user.login}</span>
        <button
          type="button"
          className="scenes-link scenes-link--danger"
          onClick={() => {
            if (
              window.confirm(
                "Disconnect GitHub in this browser? Your scenes stay here; changes are synced again once you reconnect.",
              )
            ) {
              disconnectGitHub();
            }
          }}
        >
          Disconnect
        </button>
      </div>
    </section>
  );
};

/**
 * Spaces: your account and every organization where the Kurviq app is
 * installed (as GitHub lists them). Switching reloads the tab into that
 * space's scenes.
 */
const SpaceSwitcher = () => {
  const { user, repo } = useConnection();
  const [spaces, setSpaces] = useState<Space[] | null>(null);
  useEffect(() => {
    listSpaces()
      .then(setSpaces)
      .catch(() => setSpaces(null));
  }, [user?.login]);
  if (!user) {
    return null;
  }
  const here = (repo?.owner ?? (currentSpace || user.login)).toLowerCase();
  return (
    <div className="kq-space">
      <label className="kq-field">
        <span>Space</span>
        <select
          value={here}
          onChange={(event) => {
            const owner = spaces?.find((space) => space.owner.toLowerCase() === event.target.value)?.owner;
            if (owner) {
              setUpSync(owner);
            }
          }}
        >
          {!spaces?.some((space) => space.owner.toLowerCase() === here) && <option value={here}>{repo?.owner ?? here}</option>}
          {(spaces ?? []).map((space) => (
            <option key={space.owner} value={space.owner.toLowerCase()}>
              {space.owner}
              {space.organization ? " (organization)" : " (personal)"}
            </option>
          ))}
        </select>
      </label>
      <QuickTip tip="Install the Kurviq app on an organization on GitHub; its members then share that space" label={false}>
        <button type="button" className="scenes-link kq-left" onClick={() => connectGitHub("install")}>
          Add an organization…
        </button>
      </QuickTip>
    </div>
  );
};

/** kurviq.com/@owner/scene (?present: starts presenting) */
const shareLink = (owner: string, name: string, { present = false } = {}) =>
  `${window.location.origin}/@${encodeURIComponent(owner)}/${encodeURIComponent(name)}${present ? "?present" : ""}`;

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

/** who can open a scene's link, for its tooltip */
const shareTip = (item: SceneListItem | undefined, repo: RepoChoice | null, what: string) => {
  if (!repo) {
    return `Nothing to share yet: this ${what} is only in this browser. Sign in with GitHub to sync it, then share it.`;
  }
  if (!item || item.name === null || item.localOnly) {
    return `Nothing to share: this ${what} is local only (only in this browser). Turn sync on for it to share it.`;
  }
  if (!item.onGitHub) {
    return `Not on GitHub yet: you can share this ${what} once it has synced.`;
  }
  return item.public
    ? `Copies a link to this ${what}. It is public: anyone with the link can open it, no sign-in needed.`
    : `Copies a link to this ${what}. It is private: only people who can read ${repo.owner}/${repo.name} on GitHub can open it, after signing in with GitHub. To share with anyone: Manage scenes → Make public.`;
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

const togglePublic = (name: string, isPublic: boolean | undefined, repo: RepoChoice) => {
  const ok = isPublic
    ? window.confirm(
        `Make "${name}" private again? It moves back to ${repo.owner}/${SCENES_REPO}. Note: what was public stays in the git history of ${repo.owner}/kurviq-public.`,
      )
    : window.confirm(
        `Make "${name}" public? It moves to the public repository ${repo.owner}/kurviq-public: anyone can view it, including images and text on it, and it stays in that repository's git history.`,
      );
  if (ok) {
    scenesController.setPublic(name, !isPublic).catch((error) => window.alert(error.message));
  }
};

const visibilityTip = (isPublic: boolean | undefined, repo: RepoChoice) =>
  isPublic
    ? `Public now: anyone with the link can view it, without a GitHub account. "Make private" moves it back to your private ${repo.owner}/${SCENES_REPO}; then only people with access to that repository can open it.`
    : `Private now: only people with access to ${repo.owner}/${SCENES_REPO} on GitHub can open it. "Make public" lets anyone with the link view it, without a GitHub account (it moves to the public repository ${repo.owner}/kurviq-public).`;

/** the Slides sidebar's Share tab: who can open the links, the links, public / private */
export const SlidesShare = () => {
  const { repo } = useConnection();
  const { current, list } = useSyncExternalStore(scenesController.subscribe, scenesController.getState);
  const item = list.find((entry) => entry.name === current);
  const shareable = !!repo && !!item && item.name !== null && !item.localOnly && item.onGitHub;
  const name = item?.name ?? null;
  return (
    <section className="slides-details">
      {shareable ? (
        <>
          <span className={clsx("slides-badge", item!.public ? "slides-badge--public" : "slides-badge--private")}>
            <PlaceSvg kind={item!.public ? "public" : "private"} />
            {item!.public ? "Public" : "Private"}
          </span>
          <p className="slides-hint">
            {item!.public ? (
              "Anyone with the link can watch it, no sign-in needed."
            ) : (
              <>
                Only people who can read{" "}
                <a href={repoUrl(repo!)} target="_blank" rel="noopener noreferrer">
                  {repo!.owner}/{repo!.name}
                </a>{" "}
                on GitHub can open the link, after signing in with GitHub.
              </>
            )}
          </p>
        </>
      ) : (
        <p className="slides-hint">{shareTip(item, repo, "presentation")}</p>
      )}
      <div className="slides-row">
        <CopyLink
          className="slides-btn slides-btn--primary"
          link={shareable ? shareLink(repo!.owner, name!, { present: true }) : null}
          label="Copy presentation link"
          icon={LINK_ICON}
          tip={shareTip(item, repo, "presentation")}
        />
        <CopyLink
          className="slides-btn"
          link={shareable ? shareLink(repo!.owner, name!) : null}
          label="Copy scene link"
          tip={shareTip(item, repo, "scene")}
        />
      </div>
      {shareable && !repo!.readOnly && (
        <QuickTip tip={visibilityTip(item!.public, repo!)} label={false}>
          <button type="button" className="slides-btn" onClick={() => togglePublic(name!, item!.public, repo!)}>
            {item!.public ? "Make private" : "Make public"}
          </button>
        </QuickTip>
      )}
    </section>
  );
};

/** in the current scene's actions: share links, public / private */
export const SceneSharing = ({ item, disabled }: { item: SceneListItem; disabled?: boolean }) => {
  const { repo } = useConnection();
  const { slides } = useSyncExternalStore(deck.subscribe, deck.getState);
  if (!repo || item.name === null || item.localOnly) {
    return null;
  }
  const name = item.name;
  return (
    <>
      <CopyLink link={item.onGitHub ? shareLink(repo.owner, name) : null} label="Copy link" tip={shareTip(item, repo, "scene")} />
      {slides.length > 0 && (
        <CopyLink
          link={item.onGitHub ? shareLink(repo.owner, name, { present: true }) : null}
          label="Copy presentation link"
          tip={shareTip(item, repo, "presentation")}
        />
      )}
      {!repo.readOnly && (
        <QuickTip
          label={false}
          tip={visibilityTip(item.public, repo)}
        >
          <button
            type="button"
            className="scenes-link"
            disabled={disabled}
            onClick={() => togglePublic(name, item.public, repo)}
          >
            {item.public ? "Make private" : "Make public"}
          </button>
        </QuickTip>
      )}
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

/** a read-only space: the editor shows the scenes, nothing can be changed */
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

/** the steps of setting up sync, as GitHub has them */
const Checklist = ({ owner, at }: { owner: string; at: "create" | "access" | "done" }) => {
  const { user } = useConnection();
  const order = ["signin", "create", "access", "done"] as const;
  const now = order.indexOf(at);
  const steps: Array<[(typeof order)[number], React.ReactNode]> = [
    ["signin", <>Signed in as {user?.login}</>],
    [
      "create",
      <>
        Create <code>{owner}/{SCENES_REPO}</code> (private)
      </>,
    ],
    ["access", <>Give Kurviq access to it</>],
    ["done", <>Sync is on</>],
  ];
  return (
    <ol className="kq-steps">
      {steps.map(([key, label], index) => (
        <li
          key={key}
          className={clsx("kq-steps__item", {
            "kq-steps__item--done": index < now || at === "done",
            "kq-steps__item--now": index === now && at !== "done",
          })}
        >
          <span className="kq-steps__mark">{index < now || at === "done" ? "✓" : index + 1}</span>
          <span>{label}</span>
        </li>
      ))}
    </ol>
  );
};

/** setting up sync (rendered next to the editor, see index.tsx) */
export const RepoSetupDialog = () => {
  const current = useSetup();
  const { user } = useConnection();
  const close = () => setSetup(null);

  useEffect(() => {
    if (!current) {
      return;
    }
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && close();
    // back from GitHub's tab (repository created): look again
    const onFocus = () => current.step === "create" && wasCreated(current.owner) && setUpSync(current.owner);
    window.addEventListener("keydown", onKey);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("focus", onFocus);
    };
  }, [current]);

  if (!current || !user) {
    return null;
  }
  const { owner } = current;
  const personal = owner.toLowerCase() === user.login.toLowerCase();
  const target = `${owner}/${SCENES_REPO}`;
  const retry = () => setUpSync(owner);
  const later = (
    <button type="button" className="scenes-link kq-left" onClick={close}>
      Later (Scenes sidebar, top left)
    </button>
  );
  const body = (() => {
    switch (current.step) {
      case "working":
        return (
          <>
            <h2 id="kq-setup-title">Setting up sync…</h2>
            <p className="kq-muted">
              Checking <code>{target}</code> on GitHub.
            </p>
          </>
        );
      case "create":
        return (
          <>
            <h2 id="kq-setup-title">Set up sync</h2>
            <Checklist owner={owner} at="create" />
            <p className="kq-muted">
              GitHub opens its form with everything filled in. Click <strong>Create repository</strong> there, then come
              back to this tab.{personal ? "" : ` You need the right to create repositories in ${owner}.`}
            </p>
            <div className="scenes-row">
              <a
                className="scenes-btn scenes-btn--primary"
                href={newRepoUrl(owner)}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => markCreated(owner)}
              >
                Create it on GitHub
              </a>
              <button
                type="button"
                className="scenes-btn"
                onClick={() => {
                  markCreated(owner);
                  setSetup({ step: "access", owner });
                }}
              >
                I already have it
              </button>
            </div>
            {later}
          </>
        );
      case "access":
        return (
          <>
            <h2 id="kq-setup-title">Set up sync</h2>
            <Checklist owner={owner} at="access" />
            <p className="kq-muted">
              On GitHub, pick <strong>{owner}</strong> and allow Kurviq <code>{SCENES_REPO}</code>: under{" "}
              <em>Only select repositories</em> choose it (or keep <em>All repositories</em>). You're back here right
              after.{personal ? "" : ` In organizations, an owner may have to approve this.`}
            </p>
            <div className="scenes-row">
              <button type="button" className="scenes-btn scenes-btn--primary" onClick={() => connectGitHub("install")}>
                Continue on GitHub
              </button>
              <button type="button" className="scenes-btn" onClick={retry}>
                Check again
              </button>
            </div>
            {later}
          </>
        );
      case "move":
        return (
          <>
            <h2 id="kq-setup-title">Move to {SCENES_REPO}?</h2>
            <p>
              Kurviq now keeps your scenes in your own private repository <code>{target}</code>. This browser still
              syncs with{" "}
              <a href={repoUrl(current.from)} target="_blank" rel="noopener noreferrer">
                {current.from.owner}/{current.from.name}
              </a>
              .
            </p>
            <p className="kq-muted">
              Moving copies its scenes into <code>{SCENES_REPO}</code> (the old repository stays as it is), and syncs
              there from then on.
            </p>
            <div className="scenes-row">
              <button
                type="button"
                className="scenes-btn scenes-btn--primary"
                onClick={() => {
                  session.set(MOVE_KEY, JSON.stringify(current.from));
                  setUpSync(owner);
                }}
              >
                Move to {SCENES_REPO}
              </button>
              <button
                type="button"
                className="scenes-btn"
                onClick={() => {
                  try {
                    localStorage.setItem(KEEP_KEY, `${current.from.owner}/${current.from.name}`);
                  } catch {}
                  close();
                }}
              >
                Keep {current.from.name}
              </button>
            </div>
          </>
        );
      case "done":
        return (
          <>
            <h2 id="kq-setup-title">{current.repo.readOnly ? "Connected, read only" : "Synced with GitHub ✓"}</h2>
            <Checklist owner={owner} at="done" />
            <p>
              Your scenes now sync with{" "}
              <a href={repoUrl(current.repo)} target="_blank" rel="noopener noreferrer">
                {current.repo.owner}/{current.repo.name}
              </a>
              .
            </p>
            <p className="kq-muted">
              {current.repo.readOnly
                ? `Read only: ${current.repo.readOnly}. You can view its scenes and make copies of them.`
                : [
                    current.copied ? `${current.copied} scene${current.copied === 1 ? "" : "s"} copied from the old repository.` : "",
                    current.published
                      ? `${current.published} scene${current.published === 1 ? "" : "s"} from this browser ${
                          current.published === 1 ? "goes" : "go"
                        } there now.`
                      : "",
                    "Every change is saved there a few seconds after you stop drawing.",
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
      case "error":
        return (
          <>
            <h2 id="kq-setup-title">Sync could not be set up</h2>
            <p className="scenes-error">{current.message}</p>
            <div className="scenes-row">
              <button type="button" className="scenes-btn scenes-btn--primary" onClick={retry}>
                Try again
              </button>
            </div>
            {later}
          </>
        );
    }
  })();
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
