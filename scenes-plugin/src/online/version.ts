// Which build of Kurviq this tab runs. The Worker sends its own build with
// every agent command: a tab still running an older version (the service
// worker keeps it until a reload) refuses agent commands with a clear message
// instead of half-working with old code, and reloads itself into the new
// version as soon as that doesn't get in the user's way (the agent retries).

export const BUILD: string = import.meta.env.VITE_APP_KURVIQ_BUILD || "";

let outdated = false;
const listeners = new Set<() => void>();

export const appVersion = {
  isOutdated: () => outdated,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** the server runs another build: true if this tab is outdated (and says so once) */
export const checkServerBuild = (serverBuild: unknown) => {
  if (!BUILD || typeof serverBuild !== "string" || !serverBuild || serverBuild === BUILD) {
    return false;
  }
  if (!outdated) {
    outdated = true;
    listeners.forEach((listener) => listener());
    // fetch the new version now, so a reload gets it
    navigator.serviceWorker?.getRegistration().then((registration) => registration?.update()).catch(() => {});
    autoReload(serverBuild);
  }
  return true;
};

export const OUTDATED_MESSAGE =
  "Kurviq in the user's browser was an older version than the server (Kurviq was just updated). The tab is reloading itself into the new version (the user's work is saved): wait about 10 seconds and try again. Only if it keeps failing, ask the user to reload the Kurviq tab.";

// -----------------------------------------------------------------------------
// reloading by itself
// -----------------------------------------------------------------------------

const AUTO_KEY = "kurviq-auto-reload";
/** quiet this long (no pointer / key input) before the tab reloads by itself */
const IDLE_MS = 1500;

let lastInput = Date.now();
let pointerDown = false;
if (typeof window !== "undefined") {
  const input = () => {
    lastInput = Date.now();
  };
  window.addEventListener("pointerdown", () => {
    pointerDown = true;
    input();
  }, true);
  window.addEventListener("pointerup", () => {
    pointerDown = false;
    input();
  }, true);
  window.addEventListener("keydown", input, true);
  window.addEventListener("wheel", input, { capture: true, passive: true });
}

/** nothing of the user's would be interrupted: not presenting, typing text or dragging, and quiet a moment */
const safeToReload = () =>
  document.visibilityState === "hidden" ||
  (!document.body.classList.contains("slides-presenting") &&
    !document.querySelector(".excalidraw-wysiwyg") &&
    !pointerDown &&
    Date.now() - lastInput > IDLE_MS);

/** "reloading by itself" is shown in the banner (null: not planned, the user reloads) */
let reloading = false;
export const isAutoReloading = () => reloading;

/**
 * Reload into the new version once it is safe. Guarded against loops: still outdated
 * for the same server build right after a reload, it drops the service worker and
 * tries once more; after that it leaves it to the user (the banner).
 */
const autoReload = (serverBuild: string) => {
  let tries = 0;
  try {
    const last = JSON.parse(sessionStorage.getItem(AUTO_KEY) || "null");
    if (last?.server === serverBuild && Date.now() - last.at < 3 * 60_000) {
      tries = last.tries;
    }
  } catch {}
  if (tries >= 2) {
    return;
  }
  reloading = true;
  listeners.forEach((listener) => listener());
  const timer = window.setInterval(async () => {
    if (!safeToReload()) {
      return;
    }
    window.clearInterval(timer);
    try {
      sessionStorage.setItem(AUTO_KEY, JSON.stringify({ server: serverBuild, at: Date.now(), tries: tries + 1 }));
    } catch {}
    if (tries === 1) {
      // the service worker kept serving the old version: without it, the reload comes from the server
      try {
        const registration = await navigator.serviceWorker?.getRegistration();
        await registration?.unregister();
      } catch {}
      window.location.reload();
      return;
    }
    reloadApp().catch((error) => console.error("[version] background operation failed", error));
  }, 400);
};

/** reload into the new version (the service worker fetches it first) */
export const reloadApp = async () => {
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    await registration?.update();
  } catch {}
  window.location.reload();
};
