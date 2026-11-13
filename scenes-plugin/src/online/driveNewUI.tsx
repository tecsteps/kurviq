// Google Drive's "New → More → Kurviq" (specs/2026-11-13-new-scene-from-drive.md):
// the dialog of a tab opened by Drive (/?drive-new=…). Signed in as Drive's
// account it asks for the scene's name, creates the scene in Drive's folder
// and opens it; signed in as anyone else (or not at all) it says which
// account to sign in with and creates nothing.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { isSceneName } from "../../../scenes-mcp/sceneName.mjs";
import { scenesController } from "../controller";
import { useDialogFocus } from "../dialogFocus";
import { connection, enterSpace, otherAccount } from "./drive";
import { clearDriveNew, createDriveNewScene, driveFolder, pendingDriveNew, signInForDriveNew, type DriveFolder } from "./driveNew";
import { checkDriveNewAccount, type AccountCheck, type DriveNewRequest } from "./driveNewState";

/** read once, before the router may rewrite the address */
const pending = pendingDriveNew();

const ignore = () => undefined;

const signInText = (check: Exclude<AccountCheck, "ok">, email: string | undefined) => {
  if (check === "signed-out") {
    return "To create the scene in your Google Drive folder, sign in with the Google account you used in Drive.";
  }
  if (check === "no-drive") {
    return "Kurviq needs access to its files in your Google Drive to create the scene there. Sign in again and allow it.";
  }
  if (check === "unknown") {
    return `You are signed in as ${email ?? "someone"}. Sign in again, so Kurviq can check that it is the account you used in Drive.`;
  }
  return `You are signed in to Kurviq as ${email ?? "another account"}, but you clicked New in the Google Drive of another account. Sign in as the account you used in Drive. Nothing was created.`;
};

const Frame = ({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) => {
  const dialog = useRef<HTMLDialogElement>(null);
  useDialogFocus(dialog, onClose);
  return (
    <div className="kq-overlay" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <dialog open className="kq-dialog kq-dialog--narrow kq-drive-new" aria-modal="true" aria-labelledby="kq-drive-new-title" ref={dialog}>
        <div className="kq-dialog__head">
          <h2 id="kq-drive-new-title">{title}</h2>
          <button type="button" className="kq-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        {children}
      </dialog>
    </div>
  );
};

const SignInDialog = ({ check, raw, onClose }: { check: Exclude<AccountCheck, "ok">; raw: string; onClose: () => void }) => {
  const email = connection.getState().user?.email;
  return (
    <Frame title="Sign in as the account you used in Drive" onClose={onClose}>
      <p className="kq-muted">{signInText(check, email)}</p>
      <div className="scenes-row">
        <button type="button" className="scenes-btn scenes-btn--primary" data-autofocus onClick={() => signInForDriveNew(raw, check === "no-drive")}>
          Sign in with Google
        </button>
        <button type="button" className="scenes-btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Frame>
  );
};

const nameProblem = (name: string) => {
  if (!name) {
    return "Give the scene a name.";
  }
  return isSceneName(name) ? null : "Letters, numbers, spaces and _ . ( ) - only, starting with a letter or number (up to 100).";
};

const NameDialog = ({ request, onClose }: { request: DriveNewRequest; onClose: () => void }) => {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [folder, setFolder] = useState<DriveFolder | null>(null);
  useEffect(() => {
    driveFolder(request).then(setFolder, ignore);
  }, [request]);

  const create = async () => {
    const trimmed = name.trim();
    const problem = nameProblem(trimmed);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { fileId, kurviqFolder } = await createDriveNewScene(request, trimmed, folder);
      clearDriveNew();
      await scenesController.leaveForReload();
      // the Kurviq folder: one of the user's own scenes; any other folder: opened like a scene picked in Drive
      enterSpace(kurviqFolder ? null : fileId, kurviqFolder ? `/${encodeURIComponent(trimmed)}` : `/s/${fileId}/${encodeURIComponent(trimmed)}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setBusy(false);
    }
  };

  return (
    <Frame title="New Kurviq scene" onClose={onClose}>
      <p className="kq-muted">
        {folder ? `In the Google Drive folder “${folder.name}”.` : "In the Google Drive folder where you clicked New."}
      </p>
      <form
        className="kq-field"
        onSubmit={(event) => {
          event.preventDefault();
          create().catch(ignore);
        }}
      >
        <label htmlFor="kq-drive-new-name">Scene name</label>
        <input
          id="kq-drive-new-name"
          className="scenes-input"
          data-autofocus
          value={name}
          maxLength={100}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.stopPropagation()}
        />
        <div className="scenes-row">
          <button type="submit" className="scenes-btn scenes-btn--primary" disabled={busy}>
            {busy ? "Creating…" : "Create"}
          </button>
          <button type="button" className="scenes-btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
      {error && <output className="scenes-error">{error}</output>}
    </Frame>
  );
};

/** Drive's request of this tab, once the sign-in is known (and the tab is in the account's own scenes, if it moves there) */
export const DriveNewHost = () => {
  const [open, setOpen] = useState(pending !== null);
  const state = useSyncExternalStore(connection.subscribe, connection.getState);
  const close = useCallback(() => {
    clearDriveNew();
    setOpen(false);
  }, []);
  if (!open || !pending || state.user === undefined || otherAccount()) {
    return null;
  }
  const check = checkDriveNewAccount(state.user, state.drive, pending.request.userId);
  const body =
    check === "ok" ? (
      <NameDialog request={pending.request} onClose={close} />
    ) : (
      <SignInDialog check={check} raw={pending.raw} onClose={close} />
    );
  return createPortal(body, document.querySelector(".excalidraw") ?? document.body);
};
