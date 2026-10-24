// UI of the scenes plugin. Injected into excalidraw-app by ../vite.config.mts:
//  - <ScenesTopLeftUI/> via the `renderTopLeftUI` prop of <Excalidraw/>
//  - <ScenesSidebar/> as a child of <Excalidraw/> (custom <Sidebar/>)

import { Sidebar, useExcalidrawAPI } from "@excalidraw/excalidraw";
import {
  ExternalLinkIcon,
  GithubIcon,
  LoadIcon,
  PlusIcon,
  save,
} from "@excalidraw/excalidraw/components/icons";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import clsx from "clsx";

import { IS_ONLINE, SCENE_NAME_RE } from "./api";
import { IDLE_PUSH_MS, scenesController } from "./controller";
import { IS_RENDERER, connectLive } from "./live";
import { connectRouter } from "./router";
import { deck } from "./deck";
import { PresentationOverlay, presenter } from "./present";
import { ICON_PATHS } from "./icons";
import { QuickTip } from "./quickTip";
import { loadFontLibrary } from "./fonts";
import { AddFontOverlay } from "./fontsUI";
import { PublicSceneOverlay } from "./publicScene";
import { SLIDES_SIDEBAR_NAME, SlidesSidebar } from "./slidesUI";
import { connection, otherSpacesScenes } from "./online/github";
import type { SpaceScenes } from "./online/github";
import {
  ConnectGitHubOffer,
  GitHubPanel,
  KurviqFooter,
  McpButton,
  ReadOnlyGuard,
  RepoSetupDialog,
  SceneSharing,
  UpdateBanner,
  setUpSync,
  startOnline,
} from "./online/ui";

import type { Activity, SceneListItem, ScenesState, SyncStatus } from "./controller";

import "./scenes.scss";

export const SCENES_SIDEBAR_NAME = "scenes";

const UNTITLED_LABEL = "Untitled";

/** errors are surfaced through the controller state, nothing to do here */
const ignore = () => {};

const useScenes = () =>
  useSyncExternalStore(scenesController.subscribe, scenesController.getState);

// -----------------------------------------------------------------------------
// scene filter: sticky (localStorage), e.g. "Madsack" to show only that
// customer's scenes while sharing the screen — in the switcher, the sidebar
// list and the activity log. The open scene is always shown.
// -----------------------------------------------------------------------------

const FILTER_KEY = "excalidraw-scenes-filter";
const filterListeners = new Set<() => void>();
let sceneFilter = (() => {
  try {
    return localStorage.getItem(FILTER_KEY) ?? "";
  } catch {
    return "";
  }
})();

const setSceneFilter = (value: string) => {
  sceneFilter = value;
  try {
    if (value) {
      localStorage.setItem(FILTER_KEY, value);
    } else {
      localStorage.removeItem(FILTER_KEY);
    }
  } catch {}
  filterListeners.forEach((listener) => listener());
};

const useSceneFilter = () =>
  useSyncExternalStore(
    (listener) => {
      filterListeners.add(listener);
      return () => filterListeners.delete(listener);
    },
    () => sceneFilter,
  );

const matchesFilter = (name: string | null, filter: string, current: string | null) => {
  const needle = filter.trim().toLowerCase();
  return !needle || name === current || (name ?? UNTITLED_LABEL).toLowerCase().includes(needle);
};

/** re-render periodically for "checked 20s ago" */
const useNow = (intervalMs = 5000) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
};

const useAttachController = () => {
  const api = useExcalidrawAPI();
  useEffect(() => {
    if (api) {
      // fonts the user added (also for the scene that is about to show)
      loadFontLibrary();
      scenesController.attach(api);
      connectLive();
      if (!IS_RENDERER) {
        if (IS_ONLINE) {
          startOnline();
        }
        deck.attach(api);
        connectRouter();
        scenesController.startSync();
      }
      // unmounted (e.g. a crash while rendering; the editor then hands out
      // null or a destroyed API): nothing may be synced from it any more
      return () => scenesController.editorGone();
    }
  }, [api]);
  return api;
};

const ago = (iso: string | number | null, now: number) => {
  if (!iso) {
    return "never";
  }
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 10) {
    return "just now";
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
};

const STATUS: Record<SyncStatus, { icon: string; label: string; tone: string }> = {
  synced: { icon: "✓", label: "Synced", tone: "ok" },
  ahead: { icon: "↑", label: "Not pushed", tone: "warn" },
  behind: { icon: "↓", label: "Newer on GitHub", tone: "info" },
  diverged: { icon: "⇅", label: "Changed on both sides", tone: "warn" },
  conflict: { icon: "!", label: "Conflict", tone: "danger" },
  local: { icon: "○", label: "Not on GitHub yet", tone: "muted" },
  "local-only": { icon: "⌂", label: "Local only", tone: "muted" },
  untitled: { icon: "○", label: "Not saved", tone: "muted" },
};

// where a scene is kept (this browser / a repository) and who can see it
// (private / public): two small icons with tooltips, in the list and the pill


const PlaceIcon = ({ kind, title }: { kind: keyof typeof ICON_PATHS; title: string }) => (
  <QuickTip tip={title} className={`scenes-place scenes-place--${kind}`}>
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {ICON_PATHS[kind]}
    </svg>
  </QuickTip>
);

/** the repository scenes sync with, as "owner/name" (null: none) */
const useRepoName = () => {
  const online = useSyncExternalStore(connection.subscribe, connection.getState);
  if (IS_ONLINE) {
    return online.repo ? `${online.repo.owner}/${online.repo.name}` : null;
  }
  return repoInfo ? `${repoInfo.owner}/${repoInfo.name}` : null;
};

const ScenePlace = ({
  item,
  repo: otherRepo,
}: {
  item: Pick<SceneListItem, "name" | "onGitHub" | "localOnly" | "public" | "status">;
  /** a scene of another space: its repository */
  repo?: string;
}) => {
  const ownRepo = useRepoName();
  const repo = otherRepo ?? ownRepo;
  const inRepo = item.name !== null && !item.localOnly && item.onGitHub;
  const owner = repo?.split("/")[0];
  const where = inRepo
    ? { kind: "repository" as const, title: `In the repository ${item.public && owner ? `${owner}/kurviq-public` : repo ?? "on GitHub"}${item.status === "synced" ? "" : ` (${STATUS[item.status].label.toLowerCase()})`}` }
    : {
        kind: "browser" as const,
        title:
          item.name === null
            ? "Only in this browser: not saved yet"
            : item.localOnly
            ? "Only in this browser: kept local on purpose, never synced"
            : repo
            ? `Only in this browser so far: not in ${repo} yet`
            : "Only in this browser (no repository connected)",
      };
  // private / public is a GitHub thing: the local install only knows its repository
  const who =
    !IS_ONLINE && inRepo
      ? null
      : item.public && inRepo
      ? { kind: "public" as const, title: "Public: anyone with the link can view it" }
      : {
          kind: "private" as const,
          title: inRepo ? `Private: only people with access to ${repo ?? "the repository"} can see it` : "Private: only you, in this browser",
        };
  return (
    <span className="scenes-places">
      <PlaceIcon {...where} />
      {who && <PlaceIcon {...who} />}
    </span>
  );
};

const isOffline = (state: ScenesState) =>
  !state.sync.notConnected && (state.sync.serverReachable === false || state.sync.githubOnline === false);

const StatusBadge = ({ status, compact }: { status: SyncStatus; compact?: boolean }) => {
  const info = STATUS[status];
  return (
    <span className={clsx("scenes-status", `scenes-status--${info.tone}`)} title={info.label}>
      <span className="scenes-status__icon">{info.icon}</span>
      {!compact && <span className="scenes-status__label">{info.label}</span>}
    </span>
  );
};

// -----------------------------------------------------------------------------
// top-left pill: current scene name + sync status, opens the sidebar
// -----------------------------------------------------------------------------

export const ScenesTopLeftUI = ({ isMobile }: { isMobile: boolean }) => {
  const api = useAttachController();
  const state = useScenes();
  const { current, busy, list } = state;
  const currentItem = list.find((item) => item.name === current);
  const status = currentItem?.status ?? "untitled";
  const offline = isOffline(state);
  const [open, setOpen] = useState(false);

  return (
    <div className="scenes-switcher">
      <button
        type="button"
        className={clsx("scenes-pill", { "scenes-pill--mobile": isMobile, "scenes-pill--open": open })}
        title={`${STATUS[status].label}${offline ? " · offline" : ""} — switch scene`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="scenes-pill__icon">{LoadIcon}</span>
        <span className="scenes-pill__name">{current ?? UNTITLED_LABEL}</span>
        {currentItem && <ScenePlace item={currentItem} />}
        {state.checking ? (
          <QuickTip tip="Local copy, read-only while GitHub is checked" className="scenes-pill__status" label={false}>
            checking…
          </QuickTip>
        ) : busy === "saving" || state.sync.running ? (
          <span className="scenes-pill__status">syncing…</span>
        ) : (
          // "local" / "local-only": the browser icon says it
          !["synced", "local", "local-only"].includes(status) && <StatusBadge status={status} compact />
        )}
        {offline && (
          <QuickTip tip="Offline: you keep working here, it syncs once you are back online" className="scenes-pill__offline" label={false}>
            offline
          </QuickTip>
        )}
        <span className="scenes-pill__caret" aria-hidden>▾</span>
      </button>
      {open && (
        <SceneSwitcher
          onClose={() => setOpen(false)}
          onManage={() => {
            setOpen(false);
            api?.toggleSidebar({ name: SCENES_SIDEBAR_NAME, force: true });
          }}
        />
      )}
    </div>
  );
};

/** Slides and MCP, at the top right (next to the sidebar button) */
const ScenesTopRightUI = ({ isMobile }: { isMobile: boolean }) => {
  const api = useExcalidrawAPI();
  const { slides } = useSyncExternalStore(deck.subscribe, deck.getState);
  if (isMobile) {
    return null;
  }
  return (
    <div className="scenes-top-right">
      {slides.some((slide) => !slide.skip) && (
        <button
          type="button"
          className="scenes-pill scenes-pill--primary"
          onClick={() => presenter.start()}
        >
          <svg viewBox="0 0 20 20" width="13" height="13" aria-hidden>
            <path d="M5 3.2v13.6a.8.8 0 0 0 1.2.7l11-6.8a.8.8 0 0 0 0-1.4l-11-6.8A.8.8 0 0 0 5 3.2z" fill="currentColor" />
          </svg>
          Present
        </button>
      )}
      <button
        type="button"
        className="scenes-pill scenes-slides-btn"
        onClick={() => api?.toggleSidebar({ name: SLIDES_SIDEBAR_NAME })}
      >
        <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden>
          <rect x="2.5" y="3.5" width="15" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M10 13.5v3M6.5 16.5h7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        Slides
      </button>
      {IS_ONLINE && <McpButton />}
    </div>
  );
};

/** the app's own `renderTopRightUI`, with Slides and MCP before what it shows (see ../vite.config.mts) */
export const scenesTopRight =
  (upstream: (isMobile: boolean, appState: any) => ReactNode) => (isMobile: boolean, appState: any) => (
    <>
      <ScenesTopRightUI isMobile={isMobile} />
      {upstream(isMobile, appState)}
    </>
  );

/**
 * Quick switch: the scenes as a dropdown under the pill. Type to filter,
 * arrows + Enter to pick, Esc to close; "Manage scenes…" opens the sidebar.
 */
const SceneSwitcher = ({ onClose, onManage }: { onClose: () => void; onManage: () => void }) => {
  const { current, list } = useScenes();
  const query = useSceneFilter();
  /** null: the default (first match, or create) */
  const [picked, setActive] = useState<number | null>(null);
  const { user, repo } = useSyncExternalStore(connection.subscribe, connection.getState);
  // the user's other spaces (organizations): their scenes are listed too
  const [others, setOthers] = useState<SpaceScenes[]>([]);
  useEffect(() => {
    if (IS_ONLINE && user && repo) {
      otherSpacesScenes().then(setOthers, () => setOthers([]));
    }
  }, [user, repo]);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!(event.target as HTMLElement).closest?.(".scenes-switcher")) {
        onClose();
      }
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [onClose]);

  const needle = query.trim().toLowerCase();
  type Entry = { item: SceneListItem; owner: string | null } | { item?: undefined; owner: string; name: string };
  const here = repo?.owner ?? null;
  const items: Entry[] = [
    ...list.filter((item) => matchesFilter(item.name, query, current)).map((item) => ({ item, owner: here })),
    ...others.flatMap((space) =>
      space.scenes.filter((name) => matchesFilter(name, query, null)).map((name) => ({ owner: space.owner, name })),
    ),
  ];
  const nameOf = (entry: Entry) => (entry.item ? entry.item.name : entry.name);
  // one list, by name (Untitled first), each scene with its space when there are several
  items.sort((a, b) =>
    nameOf(a) === null ? -1 : nameOf(b) === null ? 1 : nameOf(a)!.localeCompare(nameOf(b)!) || (a.item ? -1 : 1),
  );
  const showOwner = others.length > 0;
  // "create" only when the text matches no scene (a sticky filter such as a
  // customer name shouldn't offer itself as a new scene every time)
  const canCreate =
    !!needle &&
    SCENE_NAME_RE.test(query.trim()) &&
    !items.some((entry) => (nameOf(entry) ?? UNTITLED_LABEL).toLowerCase().includes(needle));
  const count = items.length + (canCreate ? 1 : 0);
  // highlight the first real match (the open scene is always listed, even
  // when it doesn't match), or "create" when nothing matches
  const firstMatch = items.findIndex((entry) => (nameOf(entry) ?? UNTITLED_LABEL).toLowerCase().includes(needle));
  const active = picked ?? (needle && firstMatch < 0 && canCreate ? items.length : Math.max(0, firstMatch));

  const choose = (index: number) => {
    onClose();
    if (index < items.length) {
      const entry = items[index];
      if (!entry.item) {
        // a scene of another space: the tab switches into that space and opens it
        setUpSync(entry.owner, `/${encodeURIComponent(entry.name)}`);
      } else if (entry.item.name !== current) {
        scenesController.open(entry.item.name).catch(ignore);
      }
    } else if (canCreate) {
      scenesController.openOrCreate(query.trim()).catch(ignore);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    // keep Excalidraw's own shortcuts out of the way while typing here
    event.stopPropagation();
    if (event.key === "Escape") {
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(count ? (active + 1) % count : 0);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(count ? (active - 1 + count) % count : 0);
    } else if (event.key === "Enter" && count) {
      event.preventDefault();
      choose(Math.min(active, count - 1));
    }
  };

  return (
    <div className="scenes-switcher__menu" role="listbox" onKeyDown={onKeyDown}>
      <div className="scenes-switcher__filter">
        <input
          autoFocus
          placeholder="Filter or create a scene…"
          value={query}
          onChange={(event) => {
            setSceneFilter(event.target.value);
            setActive(null);
          }}
        />
        {query && (
          <button
            type="button"
            className="scenes-switcher__clear"
            aria-label="Clear the filter"
            onClick={() => {
              setSceneFilter("");
              setActive(null);
            }}
          >
            ×
          </button>
        )}
      </div>
      <div className="scenes-switcher__list">
        {items.map((entry, index) => {
          const { item } = entry;
          const isCurrent = !!item && item.name === current;
          return (
            <button
              type="button"
              role="option"
              aria-selected={isCurrent}
              key={item ? `here\u0000${item.name ?? "\u0000untitled"}` : `${entry.owner}\u0000${entry.name}`}
              className={clsx("scenes-switcher__item", {
                "scenes-switcher__item--current": isCurrent,
                "scenes-switcher__item--active": index === active,
              })}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(index)}
            >
              <span className="scenes-switcher__name">{nameOf(entry) ?? UNTITLED_LABEL}</span>
              {showOwner && entry.owner && (
                <QuickTip
                  tip={
                    item
                      ? `${entry.owner}'s space: the one this tab shows`
                      : `${entry.owner}'s space: opening it switches this tab to that space`
                  }
                  className={clsx("scenes-switcher__owner", { "scenes-switcher__owner--other": !item })}
                >
                  {entry.owner}
                </QuickTip>
              )}
              {item ? (
                <>
                  {!["synced", "local", "local-only", "untitled"].includes(item.status) && (
                    <StatusBadge status={item.status} compact />
                  )}
                  <ScenePlace item={item} />
                </>
              ) : (
                <ScenePlace
                  item={{ name: entry.name, onGitHub: true, localOnly: false, public: false, status: "synced" }}
                  repo={`${entry.owner}/kurviq-scenes`}
                />
              )}
            </button>
          );
        })}
        {canCreate && (
          <button
            type="button"
            role="option"
            aria-selected={false}
            className={clsx("scenes-switcher__item", "scenes-switcher__item--create", {
              "scenes-switcher__item--active": active === items.length,
            })}
            onMouseEnter={() => setActive(items.length)}
            onClick={() => choose(items.length)}
          >
            + Create “{query.trim()}”
          </button>
        )}
        {!count && <div className="scenes-switcher__empty">No scene matches</div>}
      </div>
      <button type="button" className="scenes-switcher__manage" onClick={onManage}>
        Manage scenes…
      </button>
      {IS_ONLINE && <ConnectGitHubOffer />}
    </div>
  );
};

// -----------------------------------------------------------------------------
// sidebar
// -----------------------------------------------------------------------------

/** https://github.com/owner/repo from https / ssh remote URLs */
const repoInfo = (() => {
  const raw = (import.meta.env.VITE_APP_SCENES_GIT_REPO || "").trim();
  const match = raw.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!match) {
    return null;
  }
  return {
    url: `https://github.com/${match[1]}/${match[2]}`,
    owner: match[1],
    name: match[2],
    branch: import.meta.env.VITE_APP_SCENES_GIT_BRANCH || "main",
  };
})();

const RepoLink = () =>
  repoInfo ? (
    <a
      className="scenes-repo"
      href={repoInfo.url}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open ${repoInfo.url} in a new tab`}
    >
      <span className="scenes-repo__logo">{GithubIcon}</span>
      <span className="scenes-repo__text">
        <span className="scenes-repo__caption">
          Synced with GitHub
          <span className="scenes-repo__branch">{repoInfo.branch}</span>
        </span>
        <span className="scenes-repo__name">
          <span className="scenes-repo__owner">{repoInfo.owner}/</span>
          <wbr />
          {repoInfo.name}
        </span>
      </span>
      <span className="scenes-repo__external">{ExternalLinkIcon}</span>
    </a>
  ) : null;

/** connection + auto-sync bar at the top of the sidebar */
const SyncBar = ({ state, now }: { state: ScenesState; now: number }) => {
  const { sync, autoSync } = state;
  const pending = scenesController.pendingCount();
  const deletes = scenesController.pendingDeletes();
  let tone = "ok";
  let text: string;
  if (sync.serverReachable === false) {
    tone = "danger";
    text = IS_ONLINE ? "Kurviq server not reachable — working locally" : "Scenes server not running — working locally";
  } else if (sync.readOnly) {
    tone = "muted";
    text = `Read only — ${sync.readOnly}`;
  } else if (sync.githubOnline === false) {
    tone = "danger";
    text = "GitHub not reachable — working locally";
  } else if (sync.githubOnline === null) {
    tone = "muted";
    text = "Connecting to GitHub…";
  } else {
    text = `GitHub · checked ${ago(sync.lastCheckedAt, now)}`;
  }

  return (
    <section className="scenes-syncbar">
      <div className="scenes-syncbar__row">
        <span className={clsx("scenes-syncbar__dot", `scenes-syncbar__dot--${tone}`)} />
        <span className="scenes-syncbar__text">{text}</span>
        <button
          type="button"
          className="scenes-link"
          disabled={sync.running}
          onClick={() => scenesController.syncNow({ refresh: true })}
        >
          {sync.running ? "Syncing…" : "Sync now"}
        </button>
      </div>
      {pending > 0 && (
        <div className="scenes-syncbar__pending">
          {pending} scene{pending === 1 ? "" : "s"} with changes not on GitHub yet
          {isOffline(state) ? " — will sync when back online" : ""}
        </div>
      )}
      {deletes.length > 0 && (
        <div className="scenes-syncbar__pending">
          Deleted here, still on GitHub: {deletes.map((name) => `“${name}”`).join(", ")} — deleted there once
          reachable
        </div>
      )}
      <label className="scenes-switch">
        <input
          type="checkbox"
          checked={scenesController.clashMode() === "newest"}
          onChange={(event) => scenesController.setClashMode(event.target.checked ? "newest" : "ask")}
        />
        <span className="scenes-switch__track" />
        <span className="scenes-switch__label">
          Settle clashes automatically
          <span className="scenes-switch__hint">
            {scenesController.clashMode() === "newest"
              ? "same element changed by two people: the newer edit wins"
              : "same element changed by two people: you decide"}
          </span>
        </span>
      </label>
      <label className="scenes-switch">
        <input
          type="checkbox"
          checked={scenesController.newScenesLocalOnly()}
          onChange={(event) => scenesController.setNewScenesLocalOnly(event.target.checked)}
        />
        <span className="scenes-switch__track" />
        <span className="scenes-switch__label">
          New scenes local only
          <span className="scenes-switch__hint">
            {scenesController.newScenesLocalOnly()
              ? "stay in this browser until you publish them"
              : "go to GitHub with auto-sync"}
          </span>
        </span>
      </label>
      <label className="scenes-switch">
        <input
          type="checkbox"
          checked={autoSync}
          onChange={(event) => scenesController.setGlobalAutoSync(event.target.checked)}
        />
        <span className="scenes-switch__track" />
        <span className="scenes-switch__label">
          Auto-sync
          <span className="scenes-switch__hint">
            {autoSync
              ? `push after ${IDLE_PUSH_MS / 1000}s idle, pull & merge automatically`
              : "only when you click Save / Sync now"}
          </span>
        </span>
      </label>
    </section>
  );
};

const currentStatusText = (
  status: SyncStatus,
  { autoSync, offline, empty }: { autoSync: boolean; offline: boolean; empty: boolean },
) => {
  switch (status) {
    case "synced":
      return "Same as on GitHub";
    case "ahead":
      return offline
        ? "Local changes — will be pushed when GitHub is reachable"
        : autoSync
        ? `Local changes — pushed automatically after ${IDLE_PUSH_MS / 1000}s without edits`
        : "Local changes — not pushed (auto-sync is off for this scene)";
    case "behind":
      return autoSync ? "Newer version on GitHub — updating…" : "A newer version is on GitHub";
    case "diverged":
      return autoSync
        ? "Changed here and on GitHub — merging…"
        : "Changed here and on GitHub — Save merges both";
    case "conflict":
      return "You and GitHub changed the same elements";
    case "local":
      return empty
        ? "New, empty scene — only in this browser"
        : autoSync
        ? "Only in this browser — pushed automatically after a short pause"
        : "Only in this browser — Save to put it on GitHub";
    case "local-only":
      return "Local only — stays in this browser, never synced to GitHub. Publish puts it on GitHub.";
    case "untitled":
      return empty ? "Empty — draw something, then save it" : "Not saved yet — give it a name";
  }
};

type NamePrompt =
  | null
  | { mode: "save" | "saveAs" | "new" }
  /** on an existing scene (from the current card or the list) */
  | { mode: "rename" | "duplicate"; scene: string };

const NameForm = ({
  prompt,
  initialValue,
  onSubmit,
  onCancel,
}: {
  prompt: Exclude<NamePrompt, null>;
  initialValue: string;
  onSubmit: (name: string, options: { localOnly: boolean }) => void;
  onCancel: () => void;
}) => {
  const [value, setValue] = useState(initialValue);
  const offersLocalOnly = prompt.mode === "new" || prompt.mode === "save";
  const [localOnly, setLocalOnly] = useState(() => scenesController.newScenesLocalOnly());
  const label = {
    save: "Name & save",
    saveAs: "Save as",
    new: "Create",
    rename: "Rename",
    duplicate: "Duplicate",
  }[prompt.mode];

  return (
    <form
      className="scenes-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim()) {
          onSubmit(value.trim(), { localOnly: offersLocalOnly && localOnly });
        }
      }}
    >
      <input
        autoFocus
        className="scenes-input"
        placeholder={prompt.mode === "duplicate" ? "Name of the copy" : prompt.mode === "rename" ? "New name" : "Scene name"}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          // keep editor shortcuts from firing while typing
          event.stopPropagation();
          if (event.key === "Escape") {
            onCancel();
          }
        }}
      />
      {offersLocalOnly && (
        <label className="scenes-form__check">
          <input type="checkbox" checked={localOnly} onChange={(event) => setLocalOnly(event.target.checked)} />
          Local only (not synced to GitHub)
        </label>
      )}
      <div className="scenes-row">
        <button type="submit" className="scenes-btn scenes-btn--primary">
          {label}
        </button>
        <button type="button" className="scenes-btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
};

const ConflictBox = ({ name, clashes }: { name: string; clashes: number }) => {
  const [copyName, setCopyName] = useState<string | null>(null);
  return (
    <div className="scenes-conflict">
      <div className="scenes-conflict__title">Conflict</div>
      <div className="scenes-conflict__text">
        You and GitHub both changed {clashes} element{clashes === 1 ? "" : "s"} of this scene.
        Nothing is lost until you choose:
      </div>
      <div className="scenes-conflict__actions">
        <button type="button" className="scenes-btn" onClick={() => scenesController.keepMine(name).catch(ignore)}>
          Keep mine
          <span className="scenes-btn__hint">overwrite GitHub</span>
        </button>
        <button
          type="button"
          className="scenes-btn"
          onClick={() => {
            if (window.confirm(`Discard your version of "${name}" and take the one from GitHub?`)) {
              scenesController.takeTheirs(name).catch(ignore);
            }
          }}
        >
          Take GitHub's
          <span className="scenes-btn__hint">discard mine</span>
        </button>
        <button
          type="button"
          className="scenes-btn"
          onClick={() => scenesController.keepBoth(name).then(setCopyName, ignore)}
        >
          Keep both
          <span className="scenes-btn__hint">mine as a copy</span>
        </button>
      </div>
      {copyName && <div className="scenes-conflict__text">Your version is now “{copyName}”.</div>}
    </div>
  );
};

const SceneAutoSync = ({ item, global }: { item: SceneListItem; global: boolean }) => {
  const name = item.name!;
  const override = scenesController.sceneAutoSyncOverride(name);
  const value = item.localOnly ? "local" : override === undefined ? "default" : override ? "on" : "off";
  return (
    <label className="scenes-scene-sync">
      This scene:
      <select
        value={value}
        onChange={async (event) => {
          const next = event.target.value;
          try {
            if (next === "local") {
              await scenesController.setLocalOnly(name, true);
              return;
            }
            scenesController.setSceneAutoSync(name, next === "default" ? undefined : next === "on");
            await scenesController.setLocalOnly(name, false);
          } catch (error: any) {
            window.alert(error.message);
          }
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <option value="default">auto-sync {global ? "on" : "off"} (default)</option>
        <option value="on">always auto-sync</option>
        <option value="off">manual only</option>
        <option value="local">local only, never on GitHub</option>
      </select>
    </label>
  );
};

/** confirm text for deleting a scene — says exactly what will be lost */
const confirmDelete = (item: SceneListItem) => {
  const name = item.name!;
  const unpushed = item.dirty || ["ahead", "diverged", "conflict"].includes(item.status);
  const lines = [
    `Delete “${name}”?`,
    item.localOnly
      ? item.onGitHub
        ? "It is local only: it is deleted in this browser. The older copy on GitHub is not touched."
        : "It only exists in this browser — it will be gone."
      : item.onGitHub
      ? "It is deleted here and on GitHub (it stays in the repository's git history)."
      : "It only exists in this browser — it will be gone.",
    unpushed && !item.localOnly ? "Its changes that are not on GitHub yet are lost." : null,
  ];
  return window.confirm(lines.filter(Boolean).join("\n\n"));
};

const SceneMenu = ({
  item,
  onPrompt,
  onClose,
}: {
  item: SceneListItem;
  onPrompt: (prompt: NamePrompt) => void;
  onClose: () => void;
}) => {
  const name = item.name!;
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!(event.target as HTMLElement).closest?.(".scenes-menu")) {
        onClose();
      }
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [onClose]);
  return (
    <div className="scenes-menu" role="menu">
      <button type="button" role="menuitem" onClick={() => onPrompt({ mode: "rename", scene: name })}>
        Rename…
      </button>
      <button type="button" role="menuitem" onClick={() => onPrompt({ mode: "duplicate", scene: name })}>
        Duplicate…
      </button>
      <button
        type="button"
        role="menuitem"
        className="scenes-menu__danger"
        onClick={() => {
          onClose();
          if (confirmDelete(item)) {
            scenesController.remove(name).catch(ignore);
          }
        }}
      >
        Delete
      </button>
    </div>
  );
};

const SceneRow = ({
  item,
  active,
  disabled,
  menuOpen,
  onMenu,
  prompt,
  onPrompt,
  onSubmitName,
}: {
  item: SceneListItem;
  active: boolean;
  disabled: boolean;
  menuOpen: boolean;
  onMenu: (open: boolean) => void;
  prompt: NamePrompt;
  onPrompt: (prompt: NamePrompt) => void;
  onSubmitName: (name: string, options: { localOnly: boolean }) => void;
}) => {
  const rowPrompt =
    prompt && "scene" in prompt && prompt.scene === item.name && !active ? prompt : null;
  return (
    <li className="scenes-list__row">
      <div className={clsx("scenes-item", { "scenes-item--active": active })}>
        <button
          type="button"
          className="scenes-item__open"
          disabled={disabled}
          onClick={() => scenesController.open(item.name).catch(ignore)}
          title={[
            STATUS[item.status].label,
            item.pendingRename ? `still “${item.pendingRename}” on GitHub` : null,
            item.updatedAt ? `last change on GitHub: ${new Date(item.updatedAt).toLocaleString()}` : null,
            item.name !== null && !item.autoSync && !item.localOnly ? "manual sync" : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        >
          <span className="scenes-item__name">{item.name ?? <em>{UNTITLED_LABEL}</em>}</span>
          {item.name !== null && !item.autoSync && !item.localOnly && <span className="scenes-item__manual">manual</span>}
          {!["synced", "local", "local-only", "untitled"].includes(item.status) && <StatusBadge status={item.status} compact />}
          <ScenePlace item={item} />
        </button>
        {item.name !== null && (
          <button
            type="button"
            className={clsx("scenes-item__more", { "scenes-item__more--open": menuOpen })}
            disabled={disabled}
            aria-label={`Actions for ${item.name}`}
            onClick={() => onMenu(!menuOpen)}
          >
            ⋯
          </button>
        )}
        {menuOpen && <SceneMenu item={item} onPrompt={onPrompt} onClose={() => onMenu(false)} />}
      </div>
      {rowPrompt && (
        <NameForm
          key={`${rowPrompt.mode}:${rowPrompt.scene}`}
          prompt={rowPrompt}
          initialValue={rowPrompt.mode === "duplicate" ? `${rowPrompt.scene} copy` : rowPrompt.scene}
          onSubmit={onSubmitName}
          onCancel={() => onPrompt(null)}
        />
      )}
    </li>
  );
};

const ActivityLog = ({ activity: all, now, hidden }: { activity: Activity[]; now: number; hidden: string[] }) => {
  const [open, setOpen] = useState(false);
  // entries naming a filtered-out scene are not shown
  const activity = all.filter((entry) => !hidden.some((name) => entry.text.includes(`"${name}"`)));
  if (!activity.length) {
    return null;
  }
  const shown = open ? activity.slice(0, 15) : activity.slice(0, 2);
  return (
    <section className="scenes-activity">
      <div className="scenes-list-header">
        <span>Activity</span>
        {activity.length > 2 && (
          <button type="button" className="scenes-link" onClick={() => setOpen(!open)}>
            {open ? "less" : "more"}
          </button>
        )}
      </div>
      <ul>
        {shown.map((entry) => (
          <li key={`${entry.at}-${entry.text}`} className={`scenes-activity__item scenes-activity__item--${entry.kind}`}>
            <span className="scenes-activity__time">{ago(entry.at, now)}</span>
            <span>{entry.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
};

export const ScenesSidebar = () => {
  useAttachController();
  const state = useScenes();
  const { current, busy, error, list, remote, autoSync, conflict, activity } = state;
  const [prompt, setPrompt] = useState<NamePrompt>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const now = useNow();
  const filter = useSceneFilter();
  const shownList = list.filter((item) => matchesFilter(item.name, filter, current));
  const hiddenNames = list
    .filter((item) => item.name !== null && !matchesFilter(item.name, filter, current))
    .map((item) => item.name!);

  const isBusy = !!busy;
  const currentItem = list.find((item) => item.name === current);
  const status = currentItem?.status ?? "untitled";
  const sceneAutoSync = scenesController.autoSyncFor(current);
  const empty = !scenesController.getApi()?.getSceneElements().length;
  // rename / duplicate of the open scene happen in the card, others in the list
  const currentPrompt =
    prompt && (!("scene" in prompt) || prompt.scene === current) ? prompt : null;
  // online without GitHub: everything stays in this browser, nothing to publish
  useSyncExternalStore(connection.subscribe, connection.getState);
  const withGitHub = !IS_ONLINE || connection.isActive();

  const submitName = async (name: string, { localOnly = false }: { localOnly?: boolean } = {}) => {
    if (!prompt) {
      return;
    }
    try {
      if (prompt.mode === "new") {
        await scenesController.create(name, { localOnly });
      } else if (prompt.mode === "rename") {
        await scenesController.rename(prompt.scene, name);
      } else if (prompt.mode === "duplicate") {
        await scenesController.clone(prompt.scene, name);
      } else {
        await scenesController.save(name, prompt.mode === "save" ? { localOnly } : {});
      }
      setPrompt(null);
    } catch {}
  };

  return (
    <>
    <Sidebar name={SCENES_SIDEBAR_NAME} className="scenes-sidebar">
      <Sidebar.Header>
        <div className="scenes-sidebar__title">Scenes</div>
      </Sidebar.Header>
      <div className="scenes-sidebar__body">
        {IS_ONLINE && <GitHubPanel />}
        {withGitHub && <SyncBar state={state} now={now} />}

        <section className="scenes-current">
          <div className="scenes-current__label">Current scene</div>
          <div className="scenes-current__name">
            {current ?? <em>{UNTITLED_LABEL}</em>}
            {current !== null && (withGitHub || status !== "local-only") && <StatusBadge status={status} />}
          </div>
          <div className="scenes-current__status">
            {busy === "saving"
              ? "Pushing to GitHub…"
              : busy === "loading"
              ? "Loading…"
              : currentItem?.pendingRename
              ? `Renamed here — on GitHub it is still “${currentItem.pendingRename}”, renamed there once reachable`
              : !withGitHub && current !== null
              ? "Saved in this browser"
              : currentStatusText(status, { autoSync: sceneAutoSync, offline: isOffline(state), empty })}
          </div>

          {conflict && current !== null && <ConflictBox name={current} clashes={conflict.clashes.length} />}

          {currentPrompt ? (
            <NameForm
              key={currentPrompt.mode}
              prompt={currentPrompt}
              initialValue={
                currentPrompt.mode === "saveAs" || currentPrompt.mode === "duplicate"
                  ? `${current} copy`
                  : currentPrompt.mode === "rename"
                  ? current ?? ""
                  : ""
              }
              onSubmit={submitName}
              onCancel={() => setPrompt(null)}
            />
          ) : (
            <div className="scenes-row">
              {(withGitHub || current === null) && (
              <button
                type="button"
                className="scenes-btn scenes-btn--primary"
                disabled={isBusy || !!conflict}
                title={
                  status === "local-only"
                    ? "Put this scene on GitHub; it is synced from then on"
                    : "Push to GitHub now"
                }
                onClick={() =>
                  current === null
                    ? setPrompt({ mode: "save" })
                    : status === "local-only"
                    ? scenesController.setLocalOnly(current, false).then(() => scenesController.save()).catch(ignore)
                    : scenesController.save().catch(ignore)
                }
              >
                {save} {status === "local-only" ? "Publish" : "Save"}
              </button>
              )}
              {current !== null && (
                <button type="button" className="scenes-btn" disabled={isBusy} onClick={() => setPrompt({ mode: "saveAs" })}>
                  Save as…
                </button>
              )}
              <button type="button" className="scenes-btn" disabled={isBusy} onClick={() => setPrompt({ mode: "new" })}>
                {PlusIcon} New
              </button>
            </div>
          )}

          {current !== null && !currentPrompt && currentItem && (
            <div className="scenes-current__manage">
              <QuickTip tip="Give this scene a new name (its link changes too)" label={false}>
                <button type="button" className="scenes-link" disabled={isBusy} onClick={() => setPrompt({ mode: "rename", scene: current })}>
                  Rename
                </button>
              </QuickTip>
              <QuickTip tip="Make a copy of this scene under a new name" label={false}>
                <button type="button" className="scenes-link" disabled={isBusy} onClick={() => setPrompt({ mode: "duplicate", scene: current })}>
                  Duplicate
                </button>
              </QuickTip>
              <QuickTip
                tip={
                  currentItem.onGitHub
                    ? "Delete this scene, also on GitHub (its git history keeps the old versions)"
                    : "Delete this scene from this browser"
                }
                label={false}
              >
                <button
                  type="button"
                  className="scenes-link scenes-link--danger"
                  disabled={isBusy}
                  onClick={() => confirmDelete(currentItem) && scenesController.remove(current).catch(ignore)}
                >
                  Delete
                </button>
              </QuickTip>
              {IS_ONLINE && <SceneSharing item={currentItem} disabled={isBusy} />}
            </div>
          )}

          {current !== null && !currentPrompt && (
            <div className="scenes-current__footer">
              {currentItem && <SceneAutoSync item={currentItem} global={autoSync} />}
              {(status === "behind" || status === "ahead" || status === "diverged") && currentItem?.onGitHub && (
                <button
                  type="button"
                  className="scenes-link"
                  disabled={isBusy}
                  onClick={() => {
                    if (
                      status === "behind" ||
                      window.confirm(`Discard your local changes to "${current}" and load the version from GitHub?`)
                    ) {
                      scenesController.discardLocal(current).catch(ignore);
                    }
                  }}
                >
                  {status === "behind" ? "Load newer version" : "Discard local changes"}
                </button>
              )}
            </div>
          )}
        </section>

        {error && <div className="scenes-error">{error}</div>}

        <section className="scenes-list-section">
          <div className="scenes-list-header">
            <span>{filter.trim() ? "Scenes" : "All scenes"}</span>
            {filter.trim() && (
              <span className="scenes-filter-chip">
                filter: {filter.trim()}
                <button type="button" aria-label="Clear the filter" onClick={() => setSceneFilter("")}>
                  ×
                </button>
              </span>
            )}
          </div>
          {remote === null && list.length === 0 && <div className="scenes-empty">Loading…</div>}
          {list.length === 0 && remote !== null && <div className="scenes-empty">No scenes yet</div>}
          <ul className="scenes-list">
            {shownList.map((item) => (
              <SceneRow
                key={item.name ?? "\u0000untitled"}
                item={item}
                active={item.name === current}
                disabled={isBusy}
                menuOpen={menuFor !== null && menuFor === item.name}
                onMenu={(open) => setMenuFor(open ? item.name : null)}
                prompt={prompt}
                onPrompt={(next) => {
                  setMenuFor(null);
                  setPrompt(next);
                }}
                onSubmitName={submitName}
              />
            ))}
          </ul>
        </section>

        <ActivityLog activity={activity} now={now} hidden={hiddenNames} />

        {IS_ONLINE ? <KurviqFooter /> : <RepoLink />}
      </div>
    </Sidebar>
    <SlidesSidebar />
    <PresentationOverlay />
    <PublicSceneOverlay />
    <AddFontOverlay />
    {IS_ONLINE && <RepoSetupDialog />}
    {IS_ONLINE && <ReadOnlyGuard />}
    {IS_ONLINE && <UpdateBanner />}
    </>
  );
};
