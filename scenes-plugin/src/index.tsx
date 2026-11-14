// UI of the scenes plugin. Injected into excalidraw-app by ../vite.config.mts:
//  - <ScenesTopLeftUI/> via the `renderTopLeftUI` prop of <Excalidraw/>
//  - <ScenesSidebar/> as a child of <Excalidraw/> (the slides sidebar and overlays)

import { exportToBlob, getNonDeletedElements, restoreElements, useExcalidrawAPI } from "@excalidraw/excalidraw";
import {
  DuplicateIcon,
  LoadIcon,
  PlusIcon,
  TrashIcon,
  pencilIcon,
  save,
} from "@excalidraw/excalidraw/components/icons";
import { Fragment, useEffect, useState, useSyncExternalStore } from "react";
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
import { TextTipsOverlay } from "./textTips";
import { TemplateChangesBar } from "./templateChanges";
import { installTitleTips } from "./titleTips";
import { ICON_PATHS, PlaceSvg } from "./icons";
import { QuickTip } from "./quickTip";
import { ownSceneList } from "./storage";
import { UNTITLED } from "./spaces";
import type { HomeScene } from "./storage";
import { GROUPS_KEY, folderGroup, isOpen, ownGroup, ownerDomain, readGroups, toggled } from "./sceneGroups";
import type { GroupState } from "./sceneGroups";
import { loadFontLibrary, registerSceneFonts } from "./fonts";
import { AddFontOverlay } from "./fontsUI";
import { PublicSceneOverlay } from "./publicScene";
import { installWheelZoom } from "./wheelZoom";
import { CommentsButton, CommentsLayer, SceneCommentCount } from "./comments/ui";
import { useOpenThreadCounts } from "./comments/sceneCounts";
import { attachLiveSessions } from "./homes/live";
import { PenBar } from "./online/penUI";
import { otherFolderScenes } from "./online/driveNew";
import type { OtherScene } from "./online/driveNewState";
import { DriveNewHost } from "./online/driveNewUI";
import { SLIDES_SIDEBAR_NAME, SlidesSidebar, setPresentation, usePresentation } from "./slidesUI";
import {
  connectGoogle,
  connection,
  enterFolder,
  enterSpace,
  pickerAvailable,
  sharedFileId,
  sharedFolderId,
  sharedFolders,
  sharedWithMe,
  type SharedFolder,
  type SharedWithMe,
} from "./online/drive";
import {
  ConnectDriveOffer,
  DriveDialogs,
  DriveIcon,
  DrivePanel,
  FolderUnseen,
  KurviqFooter,
  McpButton,
  ReadOnlyGuard,
  SceneSharing,
  LinkHint,
  UpdateBanner,
  openShareDialog,
  pickSharedWithMe,
  startDrive,
} from "./online/ui";

import type { Activity, SceneListItem, ScenesState, SyncStatus } from "./controller";
import type { HomeHistoryEntry } from "./homes/types";

import "./scenes.scss";

installTitleTips();
// a mouse wheel zooms, a trackpad pans (while Excalidraw's input-device preference is on auto)
installWheelZoom(() => scenesController.getApi()?.getAppState().inputDevice ?? null);


const UNTITLED_LABEL = "Untitled";

/** errors are surfaced through the controller state, nothing to do here */
const ignore = () => {};

const useScenes = () =>
  useSyncExternalStore(scenesController.subscribe, scenesController.getState);

// -----------------------------------------------------------------------------
// scene filter: sticky (localStorage), e.g. "Madsack" to show only that
// customer's scenes in the scene switcher while sharing the screen. The open
// scene is always shown.
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

/**
 * Connects the controller to the editor. Used once, by ScenesSidebar (a
 * child of <Excalidraw/>, so its lifetime is the editor's): the pill is
 * rendered in a different tree on phones and unmounts when the form factor
 * changes, while the editor stays.
 */
const useAttachController = () => {
  const api = useExcalidrawAPI();
  useEffect(() => {
    if (api) {
      // fonts the user added (also for the scene that is about to show)
      loadFontLibrary().catch((error) => console.error("[scenes] Font library could not be loaded", error));
      scenesController.attach(api);
      connectLive();
      if (!IS_RENDERER) {
        attachLiveSessions(api);
        startDrive();
        deck.attach(api);
        connectRouter().catch((error) => console.error("[scenes] Routing could not be connected", error));
        scenesController.startSync();
      }
      // unmounted (e.g. a crash while rendering; the editor then hands out
      // null or a destroyed API): nothing may be synced from it any more
      // (release: only when nothing attached again, see the controller)
      return () => scenesController.release(api);
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
  ahead: { icon: "↑", label: "Not in Drive yet", tone: "warn" },
  behind: { icon: "↓", label: "Newer in Drive", tone: "info" },
  diverged: { icon: "⇅", label: "Changed on both sides", tone: "warn" },
  conflict: { icon: "!", label: "Conflict", tone: "danger" },
  local: { icon: "○", label: "Not in Drive yet", tone: "muted" },
  "local-only": { icon: "⌂", label: "Local only", tone: "muted" },
  untitled: { icon: "○", label: "Not saved", tone: "muted" },
};

/** states that need no badge (the place icons say it) and no words in the scene panel */
const QUIET_STATUS = new Set<string>(["synced", "local", "local-only", "untitled"]);

// where a scene is kept (this browser / Google Drive) and who can see it
// (private / public): two small icons with tooltips, in the list and the pill


const PlaceIcon = ({ kind, title, onClick }: { kind: keyof typeof ICON_PATHS; title: string; onClick?: () => void }) => {
  const svg = <PlaceSvg kind={kind} />;
  return (
    <QuickTip tip={title} className={clsx(`scenes-place scenes-place--${kind}`, { "scenes-place--action": onClick })}>
      {onClick ? (
        <button
          type="button"
          aria-label={title}
          onClick={(event) => {
            event.stopPropagation();
            onClick();
          }}
        >
          {svg}
        </button>
      ) : (
        svg
      )}
    </QuickTip>
  );
};

/** the cloud / laptop icon: take a scene out of Drive, or put it there */
const toggleDrive = async (name: string, inDrive: boolean, signedIn: boolean) => {
  try {
    if (inDrive) {
      if (
        window.confirm(
          `Keep “${name}” only in this browser?\n\nIt is removed from your Google Drive (moved to its trash, restorable there for 30 days). People you shared it with lose access, and it stops syncing to your other devices.`,
        )
      ) {
        await scenesController.keepOnlyHere(name);
      }
    } else if (!signedIn) {
      connectGoogle();
    } else {
      await scenesController.putInDrive(name);
    }
  } catch (error: any) {
    window.alert(error.message);
  }
};

const ScenePlace = ({
  item,
  owner,
  actions,
}: {
  item: Pick<SceneListItem, "name" | "inDrive" | "localOnly" | "public" | "status">;
  /** a scene someone shared: whose */
  owner?: string;
  /** clickable: the cloud / laptop moves it in or out of Drive, the lock shares it */
  actions?: boolean;
}) => {
  const browserLocationTitle = () => {
    if (item.name === null) {
      return "Only in this browser: not saved yet";
    }
    if (item.localOnly) {
      return "Only in this browser, not synced";
    }
    if (signedIn) {
      return "Saved in this browser, not in Google Drive yet";
    }
    return "Only in this browser (not signed in with Google)";
  };
  const driveActionTitle = () => {
    if (inDrive) {
      return `${where.title}. Click to keep it only in this browser`;
    }
    if (signedIn) {
      return `${where.title}. Click to put it in Google Drive`;
    }
    return `${where.title}. Click to sign in with Google and sync it`;
  };
  const privateLocationTitle = () => {
    if (inDrive) {
      if (owner) {
        return `Shared with you by ${owner}`;
      }
      return "Private: only you and the people you share it with";
    }
    return "Private: only you, in this browser";
  };
  const sharingAction = () => {
    if (own && inDrive) {
      return { title: `${who.title}. Click to share it`, onClick: () => openShareDialog(item.name!) };
    }
    if (own) {
      return { title: `${who.title}. To share it, put it in Google Drive first` };
    }
    return {};
  };

  const signedIn = useSyncExternalStore(connection.subscribe, connection.isActive);
  const inDrive = item.name !== null && !item.localOnly && item.inDrive;
  const driveLocationTitle = () => {
    const driveOwner = owner ? `In ${owner}'s Google Drive` : "In your Google Drive";
    const driveStatus = item.status === "synced" ? "" : ` (${STATUS[item.status].label.toLowerCase()})`;
    return `${driveOwner}${driveStatus}`;
  };
  const where = inDrive
    ? {
        kind: "drive" as const,
        title: driveLocationTitle(),
      }
    : {
        kind: "browser" as const,
        title: browserLocationTitle(),
      };
  // the user's own scene: the lock shares it (both installs); the cloud moves it in or out of Drive (online only)
  const own = actions && !owner && item.name !== null;
  const mine = own && IS_ONLINE;
  const whereAction = mine
    ? {
        title: driveActionTitle(),
        onClick: () => toggleDrive(item.name!, inDrive, signedIn),
      }
    : {};
  const who =
    item.public && inDrive
      ? { kind: "public" as const, title: "Anyone with the link can view it" }
      : {
          kind: "private" as const,
          title: privateLocationTitle(),
        };
  const whoAction = sharingAction();
  return (
    <span className="scenes-places">
      <PlaceIcon {...where} {...whereAction} />
      <PlaceIcon {...who} {...whoAction} />
    </span>
  );
};

const isOffline = (state: ScenesState) => !state.sync.notConnected && state.sync.driveOnline === false;

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
  const pillStatus = () => {
    if (state.checking) {
      return (
        <QuickTip tip="Local copy, read-only while Drive is checked" className="scenes-pill__status" label={false}>
          checking…
        </QuickTip>
      );
    }
    if (state.opening && current === null) {
      return <span className="scenes-pill__status">opening…</span>;
    }
    if (
      (busy === "saving" || state.sync.running) &&
      // a local-only scene never syncs, and nothing syncs while signed out
      !currentItem?.localOnly &&
      !state.sync.notConnected
    ) {
      return <span className="scenes-pill__status">syncing…</span>;
    }
    return (
      // "local" / "local-only": the browser icon says it; an untitled drawing is shown as not saved
      (status === "untitled" || !QUIET_STATUS.has(status)) && <StatusBadge status={status} compact />
    );
  };

  const state = useScenes();
  const { current, busy, list } = state;
  const currentItem = list.find((item) => item.name === current);
  const status = currentItem?.status ?? "untitled";
  const offline = isOffline(state);
  const [panel, setPanel] = useState<null | "switch" | "scene" | "drive">(null);
  const open = panel === "switch";
  const toggleSwitcher = () => setPanel((value) => (value ? null : "switch"));

  return (
    <div className="scenes-switcher">
      {/* the pill: its name (and caret) opens the scene list; the pen, cloud and lock are the scene's own actions */}
      <div className={clsx("scenes-pill scenes-pill--split", { "scenes-pill--mobile": isMobile, "scenes-pill--open": open })}>
        <button
          type="button"
          className="scenes-pill__open"
          title={`${STATUS[status].label}${offline ? " · offline" : ""}. Switch scene`}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={toggleSwitcher}
        >
          <span className="scenes-pill__icon">{LoadIcon}</span>
          <span className="scenes-pill__name">{current ?? state.opening ?? UNTITLED_LABEL}</span>
        </button>
        {currentItem && current !== null && (
          <QuickTip tip="Manage this scene: save, rename, share, history" className="scenes-pill__pen" label={false}>
            <button type="button" className="scenes-switcher__pen" aria-label={`Manage “${current}”`} onClick={() => setPanel((value) => (value === "scene" ? null : "scene"))}>
              {ManagePenIcon}
            </button>
          </QuickTip>
        )}
        {currentItem && <ScenePlace item={currentItem} actions />}
        {pillStatus()}
        {offline && (
          <QuickTip tip="Offline: you keep working here, it syncs once you are back online" className="scenes-pill__offline" label={false}>
            offline
          </QuickTip>
        )}
        <button type="button" className="scenes-pill__open scenes-pill__caret" tabIndex={-1} aria-hidden onClick={toggleSwitcher}>
          ▾
        </button>
      </div>
      {panel === "switch" && (
        <SceneSwitcher onClose={() => setPanel(null)} onManageScene={() => setPanel("scene")} onDrive={() => setPanel("drive")} />
      )}
      {panel === "scene" && <SceneFlyover onClose={() => setPanel(null)} />}
      {panel === "drive" && <DriveFlyover onClose={() => setPanel(null)} />}
      {isMobile && <MobileSlidesButton />}
    </div>
  );
};

/** the pen that opens a scene's panel (save, rename, share, history): in the scene list and the pill */
const ManagePenIcon = (
  <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M13.5 3.5l3 3L7 16H4v-3z" />
    <path d="M11.5 5.5l3 3" />
  </svg>
);

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
        <rect x="2.5" y="3.5" width="15" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.25" />
        <path d="M10 13.5v3M6.5 16.5h7" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
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
          <rect x="2.5" y="3.5" width="15" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.25" />
          <path d="M10 13.5v3M6.5 16.5h7" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
        </svg>
        Slides
      </button>
      <CommentsButton />
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

const useCloseOnOutsidePointer = (onClose: () => void) => {
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!(event.target as HTMLElement).closest?.(".scenes-switcher")) {
        onClose();
      }
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [onClose]);
};

/**
 * The heading above a group of the scene list: this tab's scenes ("My scenes",
 * or the shared folder it shows), then each folder shared with the user. A
 * click folds or unfolds the group (folded: how many scenes it holds).
 */
const GroupHeading = ({ folder, title, open, total, onToggle }: { folder?: SharedFolder; title?: string; open: boolean; total: number; onToggle: () => void }) => (
  <button type="button" className="scenes-switcher__group" aria-expanded={open} onClick={onToggle}>
    <svg
      className={clsx("scenes-switcher__group-chevron", { "scenes-switcher__group-chevron--open": open })}
      viewBox="0 0 20 20"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M8 5l5 5-5 5" />
    </svg>
    <span className="scenes-switcher__group-name">{title ?? groupName(folder)}</span>
    {folder && ownerDomain(folder.ownerEmail) && <span className="scenes-switcher__group-owner">· {ownerDomain(folder.ownerEmail)}</span>}
    {!open && <span className="scenes-switcher__group-count">{total}</span>}
  </button>
);

const groupName = (folder: SharedFolder | undefined) => {
  if (!folder) {
    return "My scenes";
  }
  // a folder picked: its owner; only scenes of it picked: "<owner>'s folder"
  return folder.picked ? folder.owner : folder.name;
};

/** the scene list's group of the user's scenes in other Drive folders (open unless folded) */
const OTHER_FOLDERS_GROUP = "other-folders";

const loadGroups = () => {
  try {
    return readGroups(localStorage.getItem(GROUPS_KEY));
  } catch {
    return {};
  }
};

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
  // open comment threads per scene this browser has (./comments/sceneCounts.ts)
  const commentCounts = useOpenThreadCounts(list.flatMap((item) => (item.name === null ? [] : [item.name])), current);
  /** null: the default (first match, or create) */
  const [picked, setActive] = useState<number | null>(null);
  const signedIn = useSyncExternalStore(connection.subscribe, connection.isActive);
  // scenes others shared with the user (not the one this tab shows)
  const [sharedScenes, setOthers] = useState<SharedWithMe[]>([]);
  // folders others shared with the user, each a group of its own (the one this tab shows: here)
  const [allFolders, setFolders] = useState<SharedFolder[]>([]);
  const folders = allFolders.filter((folder) => folder.folderId !== sharedFolderId);
  const here = allFolders.find((folder) => folder.folderId === sharedFolderId);
  // scenes the user made from Google Drive's "New" outside the Kurviq folder (./online/driveNew.ts): "Other folders"
  const [otherScenes, setOtherScenes] = useState<OtherScene[]>([]);
  // in a shared folder's tab: the user's own scenes (their names), listed first like everywhere else
  const [home] = useState<HomeScene[]>(() => (sharedFolderId ? ownSceneList() : []));
  // folded / unfolded groups, remembered in this browser
  const [groups, setGroups] = useState<GroupState>(loadGroups);
  useEffect(() => {
    if (signedIn) {
      sharedWithMe().then(
        (found) => setOthers(found.filter((entry) => entry.fileId !== sharedFileId)),
        () => setOthers([]),
      );
      sharedFolders().then(setFolders, () => setFolders([]));
      otherFolderScenes().then(
        (found) => setOtherScenes(found.filter((entry) => entry.fileId !== sharedFileId)),
        () => setOtherScenes([]),
      );
    }
  }, [signedIn]);
  // a scene of a shared folder is listed in its folder's group, not again on its own
  const inFolders = new Set(folders.flatMap((folder) => folder.scenes.map((scene) => scene.fileId)));
  const others = sharedScenes.filter((shared) => !inFolders.has(shared.fileId));

  useCloseOnOutsidePointer(onClose);

  const needle = query.trim().toLowerCase();
  type Entry =
    | { item: SceneListItem; owner: string | null; folder?: undefined; home?: undefined }
    | { item?: undefined; owner: string; name: string; fileId: string; folder?: SharedFolder; home?: undefined }
    | { item?: undefined; owner: null; name: string; fileId?: undefined; folder?: undefined; home: HomeScene };
  // this tab's scenes (in a shared folder: no stray "Untitled" of its own unless it is open)
  const tabList = sharedFolderId ? list.filter((item) => item.name !== null || current === null) : list;
  const tabScenes: Entry[] = tabList.filter((item) => matchesFilter(item.name, query, current)).map((item) => ({ item, owner: null }));
  const sharedOnes: Entry[] = others
    .filter((shared) => matchesFilter(shared.name, query, null))
    .map((shared) => ({ owner: shared.owner, name: shared.name, fileId: shared.fileId }));
  const otherOnes: Entry[] = otherScenes
    .filter((scene) => matchesFilter(scene.name, query, null))
    .map((scene) => ({ owner: "", name: scene.name, fileId: scene.fileId }));
  const homeScenes: Entry[] = home.filter((scene) => matchesFilter(scene.name, query, null)).map((scene) => ({ owner: null, name: scene.name, home: scene }));
  // "My scenes": this tab's own list, or (in a shared folder) the user's own scenes, and scenes shared one by one
  const own: Entry[] = sharedFolderId ? [...homeScenes, ...sharedOnes] : [...tabScenes, ...sharedOnes];
  const folderScenes = folders.flatMap((folder) => folder.scenes.map((scene) => ({ folder, scene })));
  // the filter stays when another scene is opened: say what it hides, or the scenes look gone
  const hidden =
    tabList.length - tabScenes.length +
    home.length - homeScenes.length +
    others.length - others.filter((shared) => matchesFilter(shared.name, query, null)).length +
    folderScenes.length - folderScenes.filter(({ scene }) => matchesFilter(scene.name, query, null)).length +
    otherScenes.length - otherOnes.length;
  const nameOf = (entry: Entry) => (entry.item ? entry.item.name : entry.name);
  // by name (Untitled first), each scene with its space when there are several
  const byName = (a: Entry, b: Entry) => {
    if (nameOf(a) === null) {
      return -1;
    }
    if (nameOf(b) === null) {
      return 1;
    }
    return nameOf(a)!.localeCompare(nameOf(b)!) || (a.item ? -1 : 1);
  };
  // this tab's scenes first, then one group per shared folder; folded groups list nothing (a filter searches them all)
  own.sort(byName);
  otherOnes.sort(byName);
  tabScenes.sort(byName);
  const grouped = folders.length > 0 || !!sharedFolderId || otherScenes.length > 0;
  const shows = (key: string) => !grouped || !!needle || isOpen(groups, key);
  const sections: { key: string; folder?: SharedFolder; title?: string; total: number; entries: Entry[] }[] = [
    { key: ownGroup(null), total: (sharedFolderId ? home.length : list.length) + others.length, entries: own },
    // the shared folder this tab shows: its scenes, under its owner like the other folders (open unless folded)
    ...(sharedFolderId
      ? [{ key: ownGroup(sharedFolderId), folder: here ?? { folderId: sharedFolderId, name: "Kurviq", owner: "Shared folder", role: "reader" as const, scenes: [], ownerEmail: null, picked: true, unseen: 0 }, total: tabList.length, entries: tabScenes }]
      : []),
    ...folders.map((folder) => ({
      key: folderGroup(folder.folderId),
      folder,
      total: folder.scenes.length,
      entries: folder.scenes
        .filter((scene) => matchesFilter(scene.name, query, null))
        .map((scene): Entry => ({ owner: folder.owner, name: scene.name, fileId: scene.fileId, folder })),
    })),
    // the user's own scenes in other Drive folders: each opens in a space of its own, like a scene shared with them
    ...(otherScenes.length > 0 ? [{ key: OTHER_FOLDERS_GROUP, title: "Other folders", total: otherScenes.length, entries: otherOnes }] : []),
  ];
  const items: Entry[] = sections.flatMap((section) => (shows(section.key) ? section.entries : []));
  const toggleGroup = (key: string) => {
    const next = toggled(groups, key);
    setGroups(next);
    setActive(null);
    try {
      localStorage.setItem(GROUPS_KEY, JSON.stringify(next));
    } catch {}
  };
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
      if (entry.home) {
        // one of the user's own scenes, from a shared folder's tab: back to their own scenes, with it open
        const { name } = entry;
        scenesController.leaveForReload().then(() => enterSpace(null, `/${encodeURIComponent(name)}`)).catch(ignore);
      } else if (entry.folder) {
        // a scene of a shared folder: the tab switches into the folder's space and opens it
        const { folder, name } = entry;
        scenesController.leaveForReload().then(() => enterFolder(folder.folderId, name)).catch(ignore);
      } else if (!entry.item) {
        // a scene someone shared: the tab switches into its space and opens it
        const { fileId, name } = entry;
        scenesController.leaveForReload().then(() => enterSpace(fileId, `/s/${fileId}/${encodeURIComponent(name)}`)).catch(ignore);
      } else if (entry.item.name !== current) {
        scenesController.open(entry.item.name).catch(ignore);
      }
    } else if (canCreate) {
      scenesController.openOrCreate(query.trim()).catch(ignore);
    }
  };

  // the pen of another scene opens it, then its manage panel (one click instead of open, reopen the menu, pen)
  const manage = (name: string | null) => {
    if (name === current) {
      onManageScene();
      return;
    }
    onClose();
    scenesController.open(name).then(onManageScene, ignore);
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

  const rowKey = (entry: Entry) => {
    if (entry.item) {
      return `here\u0000${entry.item.name ?? UNTITLED}`;
    }
    return entry.home ? `home\u0000${entry.name}` : `shared\u0000${entry.fileId}`;
  };
  const renderRow = (entry: Entry, index: number) => {
    const { item } = entry;
    const isCurrent = !!item && item.name === current;
    return (
      <Fragment key={rowKey(entry)}>
      <div
        className={clsx("scenes-switcher__row", {
          "scenes-switcher__row--current": isCurrent,
          "scenes-switcher__row--active": index === active,
        })}
        onMouseEnter={() => setActive(index)}
      >
        <button // NOSONAR S6819: a row of the filterable scene list (listbox with a pen button beside each entry); a native <option> can't hold that
          type="button"
          role="option"
          aria-selected={isCurrent}
          className={clsx("scenes-switcher__item", { "scenes-switcher__item--current": isCurrent })}
          onClick={() => choose(index)}
        >
          <span className="scenes-switcher__name">{nameOf(entry) ?? UNTITLED_LABEL}</span>
          {typeof item?.name === "string" && <SceneCommentCount count={commentCounts.get(item.name) ?? 0} />}
          {showOwner && entry.owner && !entry.folder && (
            <QuickTip
              tip={`Shared with you by ${entry.owner}: opening it switches this tab to it`}
              className="scenes-switcher__owner scenes-switcher__owner--other"
            >
              {entry.owner}
            </QuickTip>
          )}
          {item && !QUIET_STATUS.has(item.status) && (
            <StatusBadge status={item.status} compact />
          )}
        </button>
        {item && (
          <QuickTip
            tip={isCurrent ? "Manage this scene: save, rename, share, history" : "Open this scene and manage it: save, rename, share, history"}
            className={clsx("scenes-switcher__pen-tip", { "scenes-switcher__pen-tip--other": !isCurrent })}
            label={false}
          >
            <button
              type="button"
              className="scenes-switcher__pen"
              aria-label={`Manage “${nameOf(entry) ?? UNTITLED_LABEL}”`}
              onClick={() => manage(item.name)}
            >
              {ManagePenIcon}
            </button>
          </QuickTip>
        )}
        <span className="scenes-switcher__places">
          {item ? (
            <ScenePlace item={item} actions />
          ) : (
            <ScenePlace
              item={{
                name: entry.name,
                inDrive: entry.home?.inDrive ?? true,
                localOnly: entry.home?.localOnly ?? false,
                public: false,
                status: entry.home?.localOnly ? "local-only" : "synced",
              }}
              owner={entry.owner ?? undefined}
            />
          )}
        </span>
      </div>
      </Fragment>
    );
  };

  return (
    <div className="scenes-switcher__menu" role="listbox" tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="scenes-switcher__filter">
        <input
          autoFocus // NOSONAR S9379: opening the switcher focuses its filter for arrow and Enter navigation
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
        {sections.map((section) => {
          if (needle && section.entries.length === 0) {
            return null;
          }
          const open = shows(section.key);
          const first = items.indexOf(section.entries[0]);
          return (
            <Fragment key={section.key}>
              {grouped && (
                <GroupHeading folder={section.folder} title={section.title} open={open} total={section.total} onToggle={() => toggleGroup(section.key)} />
              )}
              {open && <FolderUnseen folder={section.folder} onPicked={() => sharedFolders().then(setFolders, () => setFolders([]))} />}
              {open && section.entries.map((entry, offset) => renderRow(entry, first + offset))}
            </Fragment>
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
        {hidden > 0 && (
          <div className="scenes-switcher__empty scenes-switcher__hidden">
            {hidden === 1 ? "1 more scene" : `${hidden} more scenes`} hidden by the filter ·{" "}
            <button
              type="button"
              className="scenes-link"
              onClick={() => {
                setSceneFilter("");
                setActive(null);
              }}
            >
              Show all
            </button>
          </div>
        )}
      </div>
      {signedIn && pickerAvailable() && (
        <QuickTip tip="Scenes and Kurviq folders others shared with you in Google Drive: pick them once and they are listed here (no email or link needed)">
          <button
            type="button"
            className="scenes-switcher__manage"
            onClick={() => {
              onClose();
              pickSharedWithMe().catch(ignore);
            }}
          >
            <span className="scenes-switcher__manage-icon">{DriveIcon}</span> Shared with you…
          </button>
        </QuickTip>
      )}
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
  if (sync.readOnly) {
    tone = "muted";
    text = `Read only: ${sync.readOnly}`;
  } else if (sync.driveOnline === false) {
    tone = "danger";
    text = "Drive not reachable: working locally";
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
          {isOffline(state) ? ", will sync when back online" : ""}
        </div>
      )}
      {deletes.length > 0 && (
        <div className="scenes-syncbar__pending">
          Deleted here, still in Drive: {deletes.map((name) => `“${name}”`).join(", ")}. Deleted there once
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
          {"Settle clashes automatically"}
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
          {"New scenes local only"}
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
          {"Auto-sync"}
          <span className="scenes-switch__hint">
            {autoSync
              ? `saved to Drive ${IDLE_PUSH_MS / 1000}s after you stop drawing, changes from others merged in`
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
  const aheadStatusText = () => {
    if (offline) {
      return "Changes not in Drive yet. Saved there when Drive is reachable";
    }
    if (autoSync) {
      return `Changes not in Drive yet. Saved there ${IDLE_PUSH_MS / 1000}s after you stop drawing`;
    }
    return "Changes not in Drive yet (auto-sync is off for this scene: Save puts them there)";
  };
  const localStatusText = () => {
    if (empty) {
      return "New, empty scene, only in this browser";
    }
    if (autoSync) {
      return "Only in this browser. Saved to Drive after a short pause";
    }
    return "Only in this browser. Save to put it in Drive";
  };

  switch (status) {
    case "synced":
      return "Same as in Drive";
    case "ahead":
      return aheadStatusText();
    case "behind":
      return autoSync ? "Newer version in Drive, updating…" : "A newer version is in Drive";
    case "diverged":
      return autoSync
        ? "Changed here and in Drive, merging…"
        : "Changed here and in Drive. Save merges both";
    case "conflict":
      return "You and Drive changed the same elements";
    case "local":
      return localStatusText();
    case "local-only":
      return "Local only: stays in this browser, never synced to Drive. Publish puts it in Drive.";
    case "untitled":
      return empty ? "Empty: draw something, then save it" : "Not saved yet: give it a name";
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
  const namePlaceholder = () => {
    if (prompt.mode === "duplicate") {
      return "Name of the copy";
    }
    if (prompt.mode === "rename") {
      return "New name";
    }
    return "Scene name";
  };

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
        autoFocus // NOSONAR S9379: naming is the explicit action that opens this form
        className="scenes-input"
        placeholder={namePlaceholder()}
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
          {"Local only (not synced to Drive)"}
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
          {"Keep mine"}
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
          {"Take Drive's"}
          <span className="scenes-btn__hint">discard mine</span>
        </button>
        <button
          type="button"
          className="scenes-btn"
          onClick={() => scenesController.keepBoth(name).then(setCopyName, ignore)}
        >
          {"Keep both"}
          <span className="scenes-btn__hint">mine as a copy</span>
        </button>
      </div>
      {copyName && <div className="scenes-conflict__text">Your version is now “{copyName}”.</div>}
    </div>
  );
};

const SceneAutoSync = ({ item, global }: { item: SceneListItem; global: boolean }) => {
  const autoSyncValue = () => {
    if (override === undefined) {
      return "default";
    }
    if (override) {
      return "on";
    }
    return "off";
  };

  const name = item.name!;
  const override = scenesController.sceneAutoSyncOverride(name);
  const value = autoSyncValue();
  return (
    <QuickTip tip="Auto-sync for this scene" label={false}>
    <label className="scenes-scene-sync">
      <select
        aria-label="Auto-sync for this scene"
        value={value}
        onChange={(event) => {
          const next = event.target.value;
          try {
            scenesController.setSceneAutoSync(name, next === "default" ? undefined : next === "on");
          } catch (error: any) {
            window.alert(error.message);
          }
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <option value="default">Auto-sync {global ? "on" : "off"} (default)</option>
        <option value="on">Always auto-sync</option>
        <option value="off">Manual save only</option>
      </select>
    </label>
    </QuickTip>
  );
};

/** the scene is a presentation: a switch (it also turns it on, like "Start a presentation"); off keeps every frame */
const ScenePresentationSwitch = () => {
  const on = usePresentation();
  return (
    <QuickTip tip={on ? "This scene is a presentation. Switch off to hide Present and the slide tools (frames stay)." : "Make this scene a presentation"} label={false}>
      <label className="scenes-switch scenes-switch--inline">
        <input type="checkbox" role="switch" checked={on} aria-label="Presentation" onChange={(event) => setPresentation(event.target.checked)} />
        <span className="scenes-switch__track" />
        <span className="scenes-switch__label">Presentation</span>
      </label>
    </QuickTip>
  );
};

/** confirm text for deleting a scene: says exactly what will be lost */
const confirmDelete = (item: SceneListItem) => {
  const deleteDescription = () => {
    if (item.localOnly) {
      if (item.inDrive) {
        return "It is local only: it is deleted in this browser. The older copy in Drive is not touched.";
      }
      return "It only exists in this browser. It will be gone.";
    }
    if (item.inDrive) {
      return "It is deleted here and moved to the trash of your Google Drive (restorable there for 30 days).";
    }
    return "It only exists in this browser. It will be gone.";
  };

  const name = item.name!;
  const unpushed = item.dirty || ["ahead", "diverged", "conflict"].includes(item.status);
  const lines = [
    `Delete “${name}”?`,
    deleteDescription(),
    unpushed && !item.localOnly ? "Its changes that are not in Drive yet are lost." : null,
  ];
  return window.confirm(lines.filter(Boolean).join("\n\n"));
};

const ActivityLog = ({ activity, now }: { activity: Activity[]; now: number }) => {
  const [open, setOpen] = useState(false);
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

/** the scene's versions in Drive; one can be looked at and restored */
const SceneHistory = ({ item }: { item: SceneListItem }) => {
  const name = item.name!;
  const now = useNow(30000);
  const [versions, setVersions] = useState<HomeHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ id: string; json?: string; url?: string; error?: string } | null>(null);
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

  const show = async (version: HomeHistoryEntry) => {
    if (open === version.id) {
      setOpen(null);
      return;
    }
    setOpen(version.id);
    setPreview({ id: version.id });
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
      setPreview((prev) => (prev?.id === version.id ? { id: version.id, json, url: URL.createObjectURL(blob) } : prev));
    } catch (err: any) {
      setPreview((prev) => (prev?.id === version.id ? { id: version.id, error: err.message } : prev));
    }
  };

  const restore = (version: HomeHistoryEntry, json: string) => {
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
        {shown.map((version, index) => {
          const historyPreview = () => {
            if (preview?.url) {
              return <img src={preview.url} alt={`“${name}” as of ${version.at ?? "this version"}`} />;
            }
            if (preview?.error) {
              return <div className="scenes-history__note">Could not load it: {preview.error}</div>;
            }
            return <div className="scenes-history__note">Loading…</div>;
          };
          return (
            <li key={version.id} className={clsx("scenes-history__item", { "scenes-history__item--open": open === version.id })}>
              <button type="button" className="scenes-history__row" onClick={() => show(version)} aria-expanded={open === version.id}>
                <span className="scenes-history__label">
                  Change
                  {index === 0 && <span className="scenes-history__tag">latest</span>}
                  {version.agent && <span className="scenes-history__tag scenes-history__tag--agent">agent</span>}
                </span>
                <span className="scenes-history__meta">
                  {when(version.at, now)}
                  {version.author ? ` · ${version.author}` : ""}
                </span>
              </button>
              {open === version.id && (
                <div className="scenes-history__preview">
                  {historyPreview()}
                  {index > 0 && preview?.json && (
                    <button type="button" className="scenes-btn scenes-btn--primary" onClick={() => restore(version, preview.json!)}>
                      Restore this version
                    </button>
                  )}
                  {index === 0 && <div className="scenes-history__note">The newest version in Drive.</div>}
                </div>
              )}
            </li>
          );
        })}
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
  useCloseOnOutsidePointer(onClose);
  return (
    <div // NOSONAR S6819, S6847: styled non-modal flyover isolates editor shortcuts with bubbling key events
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
      <ActivityLog activity={state.activity} now={now} />
      {IS_ONLINE && <KurviqFooter />}
    </Flyover>
  );
};

/** "save as": an outline floppy with a plus, in the stroke style of Excalidraw's menu icons */
const saveAsIcon = (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M10 16.667H4.583a1.25 1.25 0 0 1-1.25-1.25V4.583a1.25 1.25 0 0 1 1.25-1.25h8.334l3.75 3.75V10" />
    <path d="M6.25 3.333v3.334h5V3.333M6.25 16.667v-4.167h4.167" />
    <path d="M15 12.5v4.167M12.917 14.583h4.166" />
  </svg>
);


/** the open scene: save, rename, share, sync mode, history */
const SceneFlyover = ({ onClose }: { onClose: () => void }) => {
  const sceneStatus = () => {
    if (busy === "saving") {
      return "Saving to Google Drive…";
    }
    if (busy === "loading") {
      return "Loading…";
    }
    if (currentItem?.pendingRename) {
      return `Renamed here. In Drive it is still “${currentItem.pendingRename}”, renamed there once reachable`;
    }
    if (!withDrive && current !== null) {
      return "Saved in this browser";
    }
    return currentStatusText(status, { autoSync: sceneAutoSync, offline: isOffline(state), empty });
  };
  const initialName = (namePrompt: Exclude<NamePrompt, null>) => {
    if (namePrompt.mode === "saveAs" || namePrompt.mode === "duplicate") {
      return `${current} copy`;
    }
    if (namePrompt.mode === "rename") {
      return current ?? "";
    }
    return "";
  };
  const saveTip = () => {
    if (current === null) {
      return "Save: give it a name";
    }
    if (status === "local-only") {
      return "Put it in Google Drive (synced from then on)";
    }
    return "Save to Google Drive now";
  };

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

  const sceneActions = () => (
    <div className="scenes-actions">
      {(withDrive || current === null) && (
        <QuickTip tip={saveTip()} label={false}>
          <button
            type="button"
            className="scenes-btn scenes-btn--primary"
            disabled={isBusy || !!conflict}
            onClick={() => {
              if (current === null) {
                return setPrompt({ mode: "save" });
              }
              if (status === "local-only") {
                return scenesController
                  .setLocalOnly(current, false)
                  .then(() => scenesController.save())
                  .catch(ignore);
              }
              return scenesController.save().catch(ignore);
            }}
          >
            {save} {status === "local-only" ? "Publish" : "Save"}
          </button>
        </QuickTip>
      )}
      {current !== null && (
        <QuickTip tip="Save as… (a copy under a new name)" label={false}>
          <button type="button" className="scenes-icon-btn" aria-label="Save as" disabled={isBusy} onClick={() => setPrompt({ mode: "saveAs" })}>
            {saveAsIcon}
          </button>
        </QuickTip>
      )}
      <QuickTip tip="New scene" label={false}>
        <button type="button" className="scenes-icon-btn" aria-label="New scene" disabled={isBusy} onClick={() => setPrompt({ mode: "new" })}>
          {PlusIcon}
        </button>
      </QuickTip>
      {current !== null && currentItem && (
        <>
          <QuickTip tip="Rename" label={false}>
            <button type="button" className="scenes-icon-btn" aria-label="Rename" disabled={isBusy} onClick={() => setPrompt({ mode: "rename", scene: current })}>
              {pencilIcon}
            </button>
          </QuickTip>
          <QuickTip tip="Duplicate" label={false}>
            <button
              type="button"
              className="scenes-icon-btn"
              aria-label="Duplicate"
              disabled={isBusy}
              onClick={() => setPrompt({ mode: "duplicate", scene: current })}
            >
              {DuplicateIcon}
            </button>
          </QuickTip>
          <SceneSharing item={currentItem} iconOnly />
          <span className="scenes-actions__spacer" />
          <QuickTip tip={currentItem.inDrive ? "Delete (also in Drive: goes to its trash)" : "Delete"} label={false}>
            <button
              type="button"
              className="scenes-icon-btn scenes-icon-btn--danger"
              aria-label="Delete"
              disabled={isBusy}
              onClick={() => confirmDelete(currentItem) && scenesController.remove(current).catch(ignore)}
            >
              {TrashIcon}
            </button>
          </QuickTip>
        </>
      )}
    </div>
  );

  const sceneFooter = () =>
    current !== null &&
    !prompt && (
      <div className="scenes-current__footer">
        <div className="scenes-current__options">
          {currentItem && withDrive && !currentItem.localOnly ? <SceneAutoSync item={currentItem} global={autoSync} /> : <span />}
          <ScenePresentationSwitch />
        </div>
        {(status === "behind" || status === "ahead" || status === "diverged") && currentItem?.inDrive && (
          <button
            type="button"
            className="scenes-link"
            disabled={isBusy}
            onClick={() => {
              if (status === "behind" || window.confirm(`Discard your local changes to "${current}" and load the version from Drive?`)) {
                scenesController.takeTheirs(current).catch(ignore);
              }
            }}
          >
            {status === "behind" ? "Load newer version" : "Discard local changes"}
          </button>
        )}
      </div>
    );

  return (
    <Flyover
      title={
        <>
          {current ?? <em>{UNTITLED_LABEL}</em>}
          {current !== null && (withDrive || status !== "local-only") && <StatusBadge status={status} />}
          {currentItem && current !== null && <ScenePlace item={currentItem} actions />}
        </>
      }
      onClose={onClose}
    >
      <section className="scenes-current">
        {(busy || currentItem?.pendingRename || (withDrive && current !== null && !QUIET_STATUS.has(status))) && (
        <div className="scenes-current__status">
          {sceneStatus()}
        </div>
        )}

        {conflict && current !== null && <ConflictBox name={current} clashes={conflict.clashes.length} />}

        {prompt ? (
          <NameForm
            key={prompt.mode}
            prompt={prompt}
            initialValue={initialName(prompt)}
            onSubmit={submitName}
            onCancel={() => setPrompt(null)}
          />
        ) : (
          sceneActions()
        )}

        {sceneFooter()}
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
      <TextTipsOverlay />
      <CommentsLayer />
      <TemplateChangesBar />
      <PublicSceneOverlay />
      <AddFontOverlay />
      <DriveDialogs />
      {IS_ONLINE && <DriveNewHost />}
      <ReadOnlyGuard />
      {!IS_RENDERER && <PenBar />}
      {IS_ONLINE && <UpdateBanner />}
      <LinkHint />
    </>
  );
};
