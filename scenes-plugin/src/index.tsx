// UI of the scenes plugin. Injected into excalidraw-app by ../vite.config.mts:
//  - <ScenesTopLeftUI/> via the `renderTopLeftUI` prop of <Excalidraw/>
//  - <ScenesSidebar/> as a child of <Excalidraw/> (the slides sidebar and overlays)

import { exportToBlob, getNonDeletedElements, restoreElements, useExcalidrawAPI } from "@excalidraw/excalidraw";
import {
  LoadIcon,
  PlusIcon,
  save,
} from "@excalidraw/excalidraw/components/icons";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import clsx from "clsx";

import { IS_ONLINE } from "./api";
import { isSceneName } from "../../scenes-mcp/sceneName.mjs";
import { IDLE_PUSH_MS, scenesController } from "./controller";
import { IS_RENDERER, connectLive } from "./live";
import { connectRouter } from "./router";
import { deck, isDeck } from "./deck";
import { PresentationOverlay, presenter } from "./present";
import { SlideNotesOverlay } from "./notes";
import { TemplateChangesBar } from "./templateChanges";
import { installTitleTips } from "./titleTips";
import { ICON_PATHS } from "./icons";
import { QuickTip } from "./quickTip";
import { loadFontLibrary, registerSceneFonts } from "./fonts";
import { AddFontOverlay } from "./fontsUI";
import { PublicSceneOverlay } from "./publicScene";
import { SLIDES_SIDEBAR_NAME, SlidesSidebar } from "./slidesUI";
import { connection, enterSpace, sharedFileId, sharedWithMe } from "./online/drive";
import type { SharedWithMe } from "./online/drive";
import {
  ConnectDriveOffer,
  DriveDialogs,
  DriveIcon,
  DrivePanel,
  KurviqFooter,
  McpButton,
  ReadOnlyGuard,
  SceneSharing,
  UpdateBanner,
  startDrive,
} from "./online/ui";

import type { Activity, SceneListItem, ScenesState, SyncStatus } from "./controller";
import type { SceneVersion } from "./api";

import "./scenes.scss";

installTitleTips();


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
        startDrive();
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
  behind: { icon: "↓", label: "Newer in Drive", tone: "info" },
  diverged: { icon: "⇅", label: "Changed on both sides", tone: "warn" },
  conflict: { icon: "!", label: "Conflict", tone: "danger" },
  local: { icon: "○", label: "Not in Drive yet", tone: "muted" },
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

const ScenePlace = ({
  item,
  owner,
}: {
  item: Pick<SceneListItem, "name" | "inDrive" | "localOnly" | "public" | "status">;
  /** a scene someone shared: whose */
  owner?: string;
}) => {
  const signedIn = useSyncExternalStore(connection.subscribe, connection.isActive);
  const inDrive = item.name !== null && !item.localOnly && item.inDrive;
  const where = inDrive
    ? {
        kind: "repository" as const,
        title: `${owner ? `In ${owner}'s Google Drive` : "In your Google Drive"}${item.status === "synced" ? "" : ` (${STATUS[item.status].label.toLowerCase()})`}`,
      }
    : {
        kind: "browser" as const,
        title:
          item.name === null
            ? "Only in this browser: not saved yet"
            : item.localOnly
            ? "Only in this browser: kept local on purpose, never synced"
            : signedIn
            ? "Saved in this browser, not in Google Drive yet"
            : "Only in this browser (not signed in with Google)",
      };
  const who =
    item.public && inDrive
      ? { kind: "public" as const, title: "Anyone with the link can view it" }
      : {
          kind: "private" as const,
          title: inDrive
            ? owner
              ? `Shared with you by ${owner}`
              : "Private: only you and the people you share it with"
            : "Private: only you, in this browser",
        };
  return (
    <span className="scenes-places">
      <PlaceIcon {...where} />
      <PlaceIcon {...who} />
    </span>
  );
};

const isOffline = (state: ScenesState) =>
  !state.sync.notConnected && (state.sync.serverReachable === false || state.sync.driveOnline === false);

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
  useAttachController();
  const state = useScenes();
  const { current, busy, list } = state;
  const currentItem = list.find((item) => item.name === current);
  const status = currentItem?.status ?? "untitled";
  const offline = isOffline(state);
  const [panel, setPanel] = useState<null | "switch" | "scene" | "github">(null);
  const open = panel === "switch";

  return (
    <div className="scenes-switcher">
      <button
        type="button"
        className={clsx("scenes-pill", { "scenes-pill--mobile": isMobile, "scenes-pill--open": open })}
        title={`${STATUS[status].label}${offline ? " · offline" : ""} — switch scene`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setPanel((value) => (value ? null : "switch"))}
      >
        <span className="scenes-pill__icon">{LoadIcon}</span>
        <span className="scenes-pill__name">{current ?? UNTITLED_LABEL}</span>
        {currentItem && <ScenePlace item={currentItem} />}
        {state.checking ? (
          <QuickTip tip="Local copy, read-only while Drive is checked" className="scenes-pill__status" label={false}>
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
      {panel === "switch" && (
        <SceneSwitcher onClose={() => setPanel(null)} onManageScene={() => setPanel("scene")} onDrive={() => setPanel("github")} />
      )}
      {panel === "scene" && <SceneFlyover onClose={() => setPanel(null)} />}
      {panel === "github" && <DriveFlyover onClose={() => setPanel(null)} />}
      {isMobile && <MobileSlidesButton />}
    </div>
  );
};

/** phones have no top-right Slides / Present buttons: the slides sidebar opens from here */
const MobileSlidesButton = () => {
  const api = useExcalidrawAPI();
  return (
    <button
      type="button"
      className="scenes-pill scenes-pill--icon"
      aria-label="Slides"
      title="Slides"
      onClick={() => api?.toggleSidebar({ name: SLIDES_SIDEBAR_NAME })}
    >
      <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden>
        <rect x="2.5" y="3.5" width="15" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M10 13.5v3M6.5 16.5h7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    </button>
  );
};

/** Slides and MCP, at the top right (next to the sidebar button) */
const ScenesTopRightUI = ({ isMobile }: { isMobile: boolean }) => {
  const api = useExcalidrawAPI();
  const state = useSyncExternalStore(deck.subscribe, deck.getState);
  if (isMobile) {
    return null;
  }
  return (
    <div className="scenes-top-right">
      {isDeck(state) && state.slides.some((slide) => !slide.skip) && (
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
 * arrows + Enter to pick, Esc to close. The pen on the open scene manages
 * it (SceneFlyover), "Google Drive…" the connection (DriveFlyover).
 * Scenes others shared with the user are listed too; each opens in a space
 * of its own (the tab reloads into it).
 */
const SceneSwitcher = ({
  onClose,
  onManageScene,
  onDrive,
}: {
  onClose: () => void;
  onManageScene: () => void;
  onDrive: () => void;
}) => {
  const { current, list } = useScenes();
  const query = useSceneFilter();
  /** null: the default (first match, or create) */
  const [picked, setActive] = useState<number | null>(null);
  const signedIn = useSyncExternalStore(connection.subscribe, connection.isActive);
  // scenes others shared with the user (not the one this tab shows)
  const [others, setOthers] = useState<SharedWithMe[]>([]);
  useEffect(() => {
    if (signedIn) {
      sharedWithMe().then(
        (found) => setOthers(found.filter((entry) => entry.fileId !== sharedFileId)),
        () => setOthers([]),
      );
    }
  }, [signedIn]);

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
  type Entry = { item: SceneListItem; owner: string | null } | { item?: undefined; owner: string; name: string; fileId: string };
  const items: Entry[] = [
    ...list.filter((item) => matchesFilter(item.name, query, current)).map((item) => ({ item, owner: null })),
    ...others
      .filter((shared) => matchesFilter(shared.name, query, null))
      .map((shared) => ({ owner: shared.owner, name: shared.name, fileId: shared.fileId })),
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
    isSceneName(query.trim()) &&
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
        // a scene someone shared: the tab switches into its space and opens it
        const { fileId, name } = entry;
        scenesController.leaveForReload().then(() => enterSpace(fileId, `/s/${fileId}/${encodeURIComponent(name)}`));
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
            <div
              className={clsx("scenes-switcher__row", {
                "scenes-switcher__row--current": isCurrent,
                "scenes-switcher__row--active": index === active,
              })}
              key={item ? `here\u0000${item.name ?? "\u0000untitled"}` : `shared\u0000${entry.fileId}`}
              onMouseEnter={() => setActive(index)}
            >
              <button
                type="button"
                role="option"
                aria-selected={isCurrent}
                className={clsx("scenes-switcher__item", { "scenes-switcher__item--current": isCurrent })}
                onClick={() => choose(index)}
              >
                <span className="scenes-switcher__name">{nameOf(entry) ?? UNTITLED_LABEL}</span>
                {showOwner && entry.owner && (
                  <QuickTip
                    tip={`Shared with you by ${entry.owner}: opening it switches this tab to it`}
                    className="scenes-switcher__owner scenes-switcher__owner--other"
                  >
                    {entry.owner}
                  </QuickTip>
                )}
                {item && !["synced", "local", "local-only", "untitled"].includes(item.status) && (
                  <StatusBadge status={item.status} compact />
                )}
              </button>
              {isCurrent && (
                <QuickTip tip="Manage this scene: save, rename, share, history" className="scenes-switcher__pen-tip" label={false}>
                  <button
                    type="button"
                    className="scenes-switcher__pen"
                    aria-label={`Manage “${nameOf(entry) ?? UNTITLED_LABEL}”`}
                    onClick={onManageScene}
                  >
                    <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M13.5 3.5l3 3L7 16H4v-3z" />
                      <path d="M11.5 5.5l3 3" />
                    </svg>
                  </button>
                </QuickTip>
              )}
              <span className="scenes-switcher__places">
                {item ? (
                  <ScenePlace item={item} />
                ) : (
                  <ScenePlace
                    item={{ name: entry.name, inDrive: true, localOnly: false, public: false, status: "synced" }}
                    owner={entry.owner}
                  />
                )}
              </span>
            </div>
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
      <button type="button" className="scenes-switcher__manage" onClick={onDrive}>
        <span className="scenes-switcher__manage-icon">{DriveIcon}</span> Google Drive…
      </button>
      <ConnectDriveOffer />
    </div>
  );
};

// -----------------------------------------------------------------------------
// sidebar
// -----------------------------------------------------------------------------

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
  } else if (sync.driveOnline === false) {
    tone = "danger";
    text = "Drive not reachable — working locally";
  } else if (sync.driveOnline === null) {
    tone = "muted";
    text = "Connecting to Google Drive…";
  } else {
    text = `Drive · checked ${ago(sync.lastCheckedAt, now)}`;
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
          {pending} scene{pending === 1 ? "" : "s"} with changes not in Drive yet
          {isOffline(state) ? " — will sync when back online" : ""}
        </div>
      )}
      {deletes.length > 0 && (
        <div className="scenes-syncbar__pending">
          Deleted here, still in Drive: {deletes.map((name) => `“${name}”`).join(", ")} — deleted there once
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
              : "go to Drive with auto-sync"}
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
      return "Same as in Drive";
    case "ahead":
      return offline
        ? "Local changes — will be pushed when Drive is reachable"
        : autoSync
        ? `Local changes — pushed automatically after ${IDLE_PUSH_MS / 1000}s without edits`
        : "Local changes — not pushed (auto-sync is off for this scene)";
    case "behind":
      return autoSync ? "Newer version in Drive — updating…" : "A newer version is in Drive";
    case "diverged":
      return autoSync
        ? "Changed here and in Drive — merging…"
        : "Changed here and in Drive — Save merges both";
    case "conflict":
      return "You and Drive changed the same elements";
    case "local":
      return empty
        ? "New, empty scene — only in this browser"
        : autoSync
        ? "Only in this browser — pushed automatically after a short pause"
        : "Only in this browser — Save to put it in Drive";
    case "local-only":
      return "Local only — stays in this browser, never synced to Drive. Publish puts it in Drive.";
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
          Local only (not synced to Drive)
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
        You and Drive both changed {clashes} element{clashes === 1 ? "" : "s"} of this scene.
        Nothing is lost until you choose:
      </div>
      <div className="scenes-conflict__actions">
        <button type="button" className="scenes-btn" onClick={() => scenesController.keepMine(name).catch(ignore)}>
          Keep mine
          <span className="scenes-btn__hint">overwrite Drive</span>
        </button>
        <button
          type="button"
          className="scenes-btn"
          onClick={() => {
            if (window.confirm(`Discard your version of "${name}" and take the one from Drive?`)) {
              scenesController.takeTheirs(name).catch(ignore);
            }
          }}
        >
          Take Drive's
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
        <option value="local">local only, never in Drive</option>
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
      ? item.inDrive
        ? "It is local only: it is deleted in this browser. The older copy in Drive is not touched."
        : "It only exists in this browser — it will be gone."
      : item.inDrive
      ? "It is deleted here and in Drive (it stays in the repository's git history)."
      : "It only exists in this browser — it will be gone.",
    unpushed && !item.localOnly ? "Its changes that are not in Drive yet are lost." : null,
  ];
  return window.confirm(lines.filter(Boolean).join("\n\n"));
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

/** a date for the history: relative today, else day and time */
const when = (iso: string | null, now: number) => {
  if (!iso) {
    return "";
  }
  const time = new Date(iso).getTime();
  if (now - time < 20 * 3600 * 1000) {
    return ago(iso, now);
  }
  return new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};

/** "Update scene: oredev" → "Update" (the scene is clear here) */
const versionLabel = (version: SceneVersion) => {
  const text = version.message.replace(/^Agent:\s*/i, "").replace(/\s*scenes?:.*$/i, "").trim() || "Change";
  const label = text[0].toUpperCase() + text.slice(1);
  return label === "Add" ? "Created" : label;
};

/** the scene's versions in Drive; one can be looked at and restored */
const SceneHistory = ({ item }: { item: SceneListItem }) => {
  const name = item.name!;
  const now = useNow(30000);
  const [versions, setVersions] = useState<SceneVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ commit: string; json?: string; url?: string; error?: string } | null>(null);
  const [restored, setRestored] = useState<string | null>(null);
  const [all, setAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    scenesController
      .history(name)
      .then((list) => !cancelled && setVersions(list))
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
    // again after every push (the newest version changes)
  }, [name, item.updatedAt]);

  useEffect(
    () => () => {
      if (preview?.url) {
        URL.revokeObjectURL(preview.url);
      }
    },
    [preview],
  );

  const show = async (version: SceneVersion) => {
    if (open === version.commit) {
      setOpen(null);
      return;
    }
    setOpen(version.commit);
    setPreview({ commit: version.commit });
    try {
      const json = await scenesController.loadVersion(name, version);
      const data = JSON.parse(json);
      await registerSceneFonts(data);
      const blob = await exportToBlob({
        elements: getNonDeletedElements(restoreElements(data.elements, null, { repairBindings: true })),
        appState: { exportBackground: true, viewBackgroundColor: data.appState?.viewBackgroundColor ?? "#ffffff" },
        files: data.files || {},
        maxWidthOrHeight: 640,
        mimeType: "image/png",
      });
      setPreview((prev) => (prev?.commit === version.commit ? { commit: version.commit, json, url: URL.createObjectURL(blob) } : prev));
    } catch (err: any) {
      setPreview((prev) => (prev?.commit === version.commit ? { commit: version.commit, error: err.message } : prev));
    }
  };

  const restore = (version: SceneVersion, json: string) => {
    const date = version.at ? new Date(version.at).toLocaleString() : "this version";
    if (!window.confirm(`Restore “${name}” as of ${date}?\n\nThe canvas shows that version again; undo with ⌘Z. It is saved as a new version, so nothing in the history is lost.`)) {
      return;
    }
    scenesController.restoreVersion(json);
    setRestored(`Restored the version of ${date}. Undo with ⌘Z.`);
    setOpen(null);
  };

  if (error) {
    return <div className="scenes-history__note">History not available: {error}</div>;
  }
  if (!versions) {
    return <div className="scenes-history__note">Loading history…</div>;
  }
  if (!versions.length) {
    return <div className="scenes-history__note">No versions in Drive yet.</div>;
  }
  const shown = all ? versions : versions.slice(0, 8);
  return (
    <>
      {restored && <div className="scenes-history__restored">{restored}</div>}
      <ol className="scenes-history">
        {shown.map((version, index) => (
          <li key={version.commit} className={clsx("scenes-history__item", { "scenes-history__item--open": open === version.commit })}>
            <button type="button" className="scenes-history__row" onClick={() => show(version)} aria-expanded={open === version.commit}>
              <span className="scenes-history__label">
                {versionLabel(version)}
                {index === 0 && <span className="scenes-history__tag">latest</span>}
                {version.agent && <span className="scenes-history__tag scenes-history__tag--agent">agent</span>}
              </span>
              <span className="scenes-history__meta">
                {when(version.at, now)}
                {version.author ? ` · ${version.author}` : ""}
              </span>
            </button>
            {open === version.commit && (
              <div className="scenes-history__preview">
                {preview?.url ? (
                  <img src={preview.url} alt={`“${name}” as of ${version.at ?? "this version"}`} />
                ) : preview?.error ? (
                  <div className="scenes-history__note">Could not load it: {preview.error}</div>
                ) : (
                  <div className="scenes-history__note">Loading…</div>
                )}
                {index > 0 && preview?.json && (
                  <button type="button" className="scenes-btn scenes-btn--primary" onClick={() => restore(version, preview.json!)}>
                    Restore this version
                  </button>
                )}
                {index === 0 && <div className="scenes-history__note">The newest version in Drive.</div>}
              </div>
            )}
          </li>
        ))}
      </ol>
      {versions.length > shown.length && (
        <button type="button" className="scenes-link" onClick={() => setAll(true)}>
          Show all {versions.length} versions
        </button>
      )}
    </>
  );
};

/** a panel under the scene pill (closes on Esc and a click elsewhere) */
const Flyover = ({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) => {
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!(event.target as HTMLElement).closest?.(".scenes-switcher")) {
        onClose();
      }
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [onClose]);
  return (
    <div
      className="scenes-flyover"
      role="dialog"
      onKeyDown={(event) => {
        // keep Excalidraw's own shortcuts out of the way while typing here
        event.stopPropagation();
        if (event.key === "Escape") {
          onClose();
        }
      }}
    >
      <div className="scenes-flyover__head">
        <span className="scenes-flyover__title">{title}</span>
        <button type="button" className="scenes-flyover__close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="scenes-flyover__body">{children}</div>
    </div>
  );
};

/** Drive: the connection, sync settings and what was synced */
const DriveFlyover = ({ onClose }: { onClose: () => void }) => {
  const state = useScenes();
  const now = useNow();
  useSyncExternalStore(connection.subscribe, connection.getState);
  const withDrive = connection.isActive();
  return (
    <Flyover title="Google Drive" onClose={onClose}>
      <DrivePanel />
      {withDrive && <SyncBar state={state} now={now} />}
      <ActivityLog activity={state.activity} now={now} hidden={[]} />
      {IS_ONLINE && <KurviqFooter />}
    </Flyover>
  );
};

/** the open scene: save, rename, share, sync mode, history */
const SceneFlyover = ({ onClose }: { onClose: () => void }) => {
  const state = useScenes();
  const { current, busy, error, list, autoSync, conflict } = state;
  const [prompt, setPrompt] = useState<NamePrompt>(null);
  const isBusy = !!busy;
  const currentItem = list.find((item) => item.name === current);
  const status = currentItem?.status ?? "untitled";
  const sceneAutoSync = scenesController.autoSyncFor(current);
  const empty = !scenesController.getApi()?.getSceneElements().length;
  // not signed in: everything stays in this browser, nothing to publish
  useSyncExternalStore(connection.subscribe, connection.getState);
  const withDrive = connection.isActive();

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
    <Flyover
      title={
        <>
          {current ?? <em>{UNTITLED_LABEL}</em>}
          {current !== null && (withDrive || status !== "local-only") && <StatusBadge status={status} />}
        </>
      }
      onClose={onClose}
    >
      <section className="scenes-current">
        <div className="scenes-current__status">
          {busy === "saving"
            ? "Saving to Google Drive…"
            : busy === "loading"
            ? "Loading…"
            : currentItem?.pendingRename
            ? `Renamed here — in Drive it is still “${currentItem.pendingRename}”, renamed there once reachable`
            : !withDrive && current !== null
            ? "Saved in this browser"
            : currentStatusText(status, { autoSync: sceneAutoSync, offline: isOffline(state), empty })}
        </div>

        {conflict && current !== null && <ConflictBox name={current} clashes={conflict.clashes.length} />}

        {prompt ? (
          <NameForm
            key={prompt.mode}
            prompt={prompt}
            initialValue={
              prompt.mode === "saveAs" || prompt.mode === "duplicate" ? `${current} copy` : prompt.mode === "rename" ? current ?? "" : ""
            }
            onSubmit={submitName}
            onCancel={() => setPrompt(null)}
          />
        ) : (
          <div className="scenes-row">
            {(withDrive || current === null) && (
              <button
                type="button"
                className="scenes-btn scenes-btn--primary"
                disabled={isBusy || !!conflict}
                title={status === "local-only" ? "Put this scene in Drive; it is synced from then on" : "Push to Drive now"}
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

        {current !== null && !prompt && currentItem && (
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
                currentItem.inDrive
                  ? "Delete this scene, also in Drive (its git history keeps the old versions)"
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
            <SceneSharing item={currentItem} disabled={isBusy} />
          </div>
        )}

        {current !== null && !prompt && (
          <div className="scenes-current__footer">
            {currentItem && withDrive && <SceneAutoSync item={currentItem} global={autoSync} />}
            {(status === "behind" || status === "ahead" || status === "diverged") && currentItem?.inDrive && (
              <button
                type="button"
                className="scenes-link"
                disabled={isBusy}
                onClick={() => {
                  if (status === "behind" || window.confirm(`Discard your local changes to "${current}" and load the version from Drive?`)) {
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

      {currentItem && current !== null && (
        <section className="scenes-history-section">
          <div className="scenes-list-header">
            <span>History</span>
          </div>
          {withDrive && currentItem.inDrive && !currentItem.localOnly ? (
            <SceneHistory key={current} item={currentItem} />
          ) : (
            <div className="scenes-history__note">
              {currentItem.localOnly || !withDrive
                ? "Only in this browser: versions are kept once it is in Drive."
                : "Not in Drive yet: its versions start with the first save."}
            </div>
          )}
        </section>
      )}
    </Flyover>
  );
};

/** overlays of the plugin (the scene itself is managed from the pill's flyovers) */
export const ScenesSidebar = () => {
  useAttachController();
  return (
    <>
      <SlidesSidebar />
      <PresentationOverlay />
      <SlideNotesOverlay />
      <TemplateChangesBar />
      <PublicSceneOverlay />
      <AddFontOverlay />
      <DriveDialogs />
      <ReadOnlyGuard />
      {IS_ONLINE && <UpdateBanner />}
    </>
  );
};
