// "Move browser scenes…" in the main menu (injected by ../vite.config.mts) and
// its dialog: save everything Kurviq keeps in this browser to a file, or read
// such a file in (see ./browserMove.ts). Mainly for the local install moving
// from http://draw.test to https://draw.test.

import { createRoot } from "react-dom/client";
import { useCallback, useRef, useState } from "react";
import { MainMenu } from "@excalidraw/excalidraw";
import { createStore as idbStore, entries, setMany } from "idb-keyval";

import { exportBrowserScenes, importBrowserScenes, moveFileText, parseMoveFileText, type MoveResult, type MoveStorage } from "./browserMove";
import { scenesController } from "./controller";
import { useDialogFocus } from "./dialogFocus";
import { createStore } from "./externalStore";

import "./online/online.scss";

const openStore = createStore(false);

/** this browser's storage, for the move */
const browserStorage: MoveStorage = {
  localKeys: () => Object.keys(localStorage),
  getLocal: (key) => localStorage.getItem(key),
  setLocal: (key, value) => localStorage.setItem(key, value),
  entries: async (db, store) => (await entries(idbStore(db, store))).map(([key, value]) => [String(key), value]),
  put: async (db, store, items) => {
    if (items.length > 0) {
      await setMany(items, idbStore(db, store));
    }
  },
};

/** without Web Crypto (a plain-http page that isn't localhost) live features can't run */
export const isInsecurePage = () => typeof crypto === "undefined" || !crypto.subtle;

const download = (text: string, name: string) => {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

const saveToFile = async () => {
  const file = await exportBrowserScenes(browserStorage, scenesController.openSceneSnapshot(), location.origin);
  const count = file.spaces.reduce((sum, space) => sum + space.snapshots.length, 0);
  download(await moveFileText(file), `kurviq-browser-scenes-${file.at.slice(0, 10)}.json`);
  return count;
};

const readFile = async (picked: File) => {
  const file = parseMoveFileText(await picked.text());
  // the tab must not write its own scene list over the one read in: it lets go, then reloads
  scenesController.detach();
  return importBrowserScenes(browserStorage, file);
};

const counted = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const doneText = (result: MoveResult) => {
  const parts = [`${counted(result.scenes, "scene")} read in`];
  if (result.fonts) {
    parts.push(counted(result.fonts, "font"));
  }
  let text = `${parts.join(", ")}.`;
  if (result.renamed.length > 0) {
    const renamed = result.renamed.map(([from, to]) => '"' + from + '" is now "' + to + '"').join(", ");
    text += ` Kept both where names were taken: ${renamed}.`;
  }
  return `${text} Reloading…`;
};

const MoveDialog = () => {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const close = useCallback(() => openStore.set(false), []);
  useDialogFocus(dialog, close);

  const run = (work: () => Promise<string>) => {
    setBusy(true);
    setMessage(null);
    work()
      .then((text) => setMessage({ text }))
      .catch((error) => setMessage({ text: error?.message ?? String(error), error: true }))
      .finally(() => setBusy(false));
  };

  return (
    <div className="kq-overlay" onPointerDown={(event) => event.target === event.currentTarget && close()}>
      <dialog open className="kq-dialog kq-dialog--narrow" aria-modal="true" aria-labelledby="kq-move-title" ref={dialog}>
        <div className="kq-dialog__head">
          <h2 id="kq-move-title">Move browser scenes</h2>
          <button type="button" className="kq-close" aria-label="Close" onClick={close}>
            ×
          </button>
        </div>
        {isInsecurePage() && (
          <p className="kq-muted">
            This page is not secure (http), so live features are off here. Save your scenes to a file, open Kurviq on
            https (for the local install: <code>npm run setup:domain</code>, then https://draw.test) and read the file
            in there.
          </p>
        )}
        <p className="kq-muted">
          A browser keeps scenes per web address. To take this browser's scenes (with pictures, comments, fonts and
          settings) to another address, save them here and read the file in there. Scenes in Google Drive come back by
          themselves after signing in. Sign-ins are not in the file.
        </p>
        <div className="scenes-row">
          <button
            type="button"
            className="scenes-btn"
            disabled={busy}
            data-autofocus
            onClick={() => run(async () => `${await saveToFile()} scenes saved to the file.`)}
          >
            Save to a file
          </button>
          <button type="button" className="scenes-btn scenes-btn--primary" disabled={busy} onClick={() => fileInput.current?.click()}>
            Read a file…
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => {
              const picked = event.target.files?.[0];
              event.target.value = "";
              if (picked) {
                run(async () => {
                  const text = doneText(await readFile(picked));
                  setTimeout(() => location.reload(), 1500);
                  return text;
                });
              }
            }}
          />
        </div>
        {message && (
          <output className={message.error ? "scenes-error" : "kq-muted"}>{message.text}</output>
        )}
      </dialog>
    </div>
  );
};

const Host = () => (openStore.use() ? <MoveDialog /> : null);

let container: HTMLDivElement | null = null;
const openMoveDialog = () => {
  if (!container?.isConnected) {
    // inside the editor: the dialog styles and the theme live there (again if the editor was remounted)
    container = document.createElement("div");
    (document.querySelector(".excalidraw") ?? document.body).appendChild(container);
    createRoot(container).render(<Host />);
  }
  openStore.set(true);
};

const MoveIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 12h12M12 6l6 6-6 6" />
    <path d="M20 4v16" />
  </svg>
);

/** the main menu's entry */
export const MoveScenesMenuItem = () => (
  <MainMenu.Item icon={MoveIcon} onSelect={openMoveDialog}>
    Move browser scenes…
  </MainMenu.Item>
);
