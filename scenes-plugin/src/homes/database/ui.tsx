// The database home in the app: connecting a database (Connect with
// Supabase, or paste its address and key after running the shown SQL),
// signing in to one (an email link; a code where the project's email shows
// one), the setting "New scenes are kept", "Move to…", and the bar over a
// database scene that says what this person may do there (and that a free
// project is paused). The share panel is ./shareUI.tsx.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { scenesController } from "../../controller";
import { useDialogFocus } from "../../dialogFocus";
import { createStore } from "../../externalStore";
import { connection } from "../../online/drive";
import { copyText } from "../../useCopy";

import { cleanProjectUrl, connectionOf, createProbe, databases, DEFAULT_SPACE_NAME, keyProblem, refOfUrl, signInByEmail, signOutDb, verifyCode } from "./connections";
import { finishSupabaseConnect, isSupabaseCallback, managementApi, newDatabasePassword, REGIONS, setUpProject, startSupabaseConnect, waitUntilUp } from "./oauth";
import { PAUSED_MESSAGE } from "./rows";
import { DatabaseShareDialog } from "./shareUI";
import { looksLikeEmail } from "./text";

import type { HomeKind, SceneHome } from "../types";
import type { Organization, Project } from "./oauth";
import type { NewHome } from "../../storage";

import "./database.scss";

type Dialog =
  | null
  | { kind: "connect" }
  | { kind: "setup"; token: string; email: string }
  | { kind: "signin"; ref: string; sceneId?: string; email?: string }
  | { kind: "share"; name: string }
  | { kind: "move"; name: string }
  | { kind: "moved"; home: HomeKind; link: string };

const dialogs = createStore<Dialog>(null);
const close = () => dialogs.set(null);

export const openConnectDialog = () => dialogs.set({ kind: "connect" });
export const openSignInDialog = (ref: string, sceneId?: string) => dialogs.set({ kind: "signin", ref, sceneId });
export const openDatabaseShare = (name: string) => dialogs.set({ kind: "share", name });
export const openMoveDialog = (name: string) => dialogs.set({ kind: "move", name });
export const showMovedNote = (home: HomeKind, link: string) => dialogs.set({ kind: "moved", home, link });

/** back from Supabase's consent page (/auth/supabase/callback): the setup goes on with the token (kept in memory only) */
export const resumeSupabaseConnect = async () => {
  if (!isSupabaseCallback()) {
    return false;
  }
  try {
    const { token, email } = await finishSupabaseConnect();
    dialogs.set({ kind: "setup", token, email });
  } catch (error: any) {
    window.alert(error.message);
  }
  return true;
};

const homeName = (kind: HomeKind) => ({ browser: "this browser", drive: "Google Drive", database: "a database" })[kind];

const Frame = ({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) => {
  const dialog = useRef<HTMLDialogElement>(null);
  useDialogFocus(dialog, onClose);
  return (
    <div className="kq-overlay">
      <dialog open className={`kq-dialog kq-share kq-db ${wide ? "" : "kq-dialog--narrow"}`} aria-modal="true" aria-labelledby="kq-db-title" ref={dialog}>
        <div className="kq-dialog__head">
          <h2 id="kq-db-title">{title}</h2>
          <button type="button" className="kq-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        {children}
      </dialog>
    </div>
  );
};

const SupabaseMark = () => (
  <svg viewBox="0 0 109 113" width="16" height="16" aria-hidden>
    <path d="M63.7 110.3c-2.9 3.6-8.7 1.6-8.8-3l-1-67.4h45.1c8.2 0 12.7 9.4 7.6 15.8z" fill="#249361" />
    <path d="M45.3 2.1c2.9-3.6 8.7-1.6 8.8 3l.4 67.4H10c-8.2 0-12.7-9.4-7.6-15.8z" fill="#3ECF8E" />
  </svg>
);

// -----------------------------------------------------------------------------
// connect: with Supabase (OAuth), or by hand (paste address and key)
// -----------------------------------------------------------------------------

const ConnectDialog = () => {
  const [email, setEmail] = useState(() => connection.getState().user?.email ?? "");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [sql, setSql] = useState("");
  useEffect(() => {
    import("./schema")
      .then(({ SCHEMA_SQL }) => setSql(SCHEMA_SQL))
      .catch(() => setSql("-- Kurviq's SQL could not be loaded: reload the page"));
  }, []);
  const emailOk = looksLikeEmail(email);

  const connectByHand = async () => {
    setError(null);
    const address = cleanProjectUrl(url);
    const problem = keyProblem(key);
    if (!address) {
      return setError("Paste the project's URL, e.g. https://abcdefghijklmnopqrst.supabase.co");
    }
    if (problem) {
      return setError(problem);
    }
    setBusy(true);
    try {
      const state = await createProbe({ url: address, key: key.trim() });
      if (state !== "ok") {
        setError(
          {
            missing: "Kurviq's tables are not in this project yet: run the SQL below in its SQL editor first.",
            old: "This project has an older version of Kurviq's tables: run the SQL below again.",
            paused: PAUSED_MESSAGE,
            unreachable: "This project doesn't answer: check the URL and key (and that the project is not paused).",
          }[state],
        );
        return;
      }
      const ref = refOfUrl(address);
      databases.add({ ref, url: address, key: key.trim(), name: DEFAULT_SPACE_NAME });
      dialogs.set({ kind: "signin", ref, email: email.trim() });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame title="Connect a database" onClose={close} wide>
      <p>
        Keep scenes in your own database (Supabase, free to start): everyone you invite works on them in real time, with
        pointers and names, also people without a Google account (they sign in with an email link). Kurviq's servers keep
        nothing of it.
      </p>
      <label className="kq-field">
        {"Your email"}
        <input type="email" value={email} autoComplete="email" onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" />
        <span className="kq-muted">You sign in to the database with it, as its owner.</span>
      </label>
      <button
        type="button"
        className="scenes-btn kq-supabase-btn"
        disabled={!emailOk || busy}
        onClick={() => {
          setBusy(true);
          startSupabaseConnect(email.trim()).catch((err) => {
            setBusy(false);
            setError(err.message);
          });
        }}
      >
        <SupabaseMark /> Connect with Supabase
      </button>
      <p className="kq-muted">Supabase asks you to allow Kurviq; then you pick a project or create one, and Kurviq sets it up.</p>
      <details className="kq-db__manual">
        <summary>Or set it up yourself (also for self-hosted Supabase)</summary>
        <ol>
          <li>
            {"In your project's SQL editor, run Kurviq's SQL (safe to run again):"}
            <textarea className="kq-prompt" readOnly rows={5} value={sql} aria-label="Kurviq's SQL" />
            <button
              type="button"
              className="scenes-btn"
              onClick={() =>
                void copyText(sql).then((done) => {
                  setCopied(done);
                  setTimeout(() => setCopied(false), 1500);
                })
              }
            >
              {copied ? "Copied ✓" : "Copy the SQL"}
            </button>
          </li>
          <li>
            Authentication → URL Configuration: add <code>{`${location.origin}/**`}</code> to the redirect URLs (sign-in links
            come back to Kurviq).
          </li>
          <li>
            <label className="kq-field">
              {"Project URL"}
              <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://abcdefghijklmnopqrst.supabase.co" />
            </label>
            <label className="kq-field">
              {"Publishable key (or the legacy anon key; never the secret key)"}
              <input value={key} onChange={(event) => setKey(event.target.value)} placeholder="sb_publishable_…" />
            </label>
          </li>
        </ol>
        <button type="button" className="scenes-btn scenes-btn--primary" disabled={busy || !url || !key} onClick={() => void connectByHand()}>
          {busy ? "Checking…" : "Connect"}
        </button>
      </details>
      {error && <p className="scenes-error">{error}</p>}
    </Frame>
  );
};

// -----------------------------------------------------------------------------
// after "Connect with Supabase": pick or create a project, then set it up
// -----------------------------------------------------------------------------

const NEW = "__new";

const SetupDialog = ({ token, email }: { token: string; email: string }) => {
  // the management token lives only in this component (memory); it is dropped with it
  const [api] = useState(() => managementApi(token));
  const [orgs, setOrgs] = useState<Organization[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [choice, setChoice] = useState<string>("");
  const [name, setName] = useState("Kurviq");
  const [org, setOrg] = useState("");
  const [region, setRegion] = useState("eu-central-1");
  const [password, setPassword] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    Promise.all([api.organizations(), api.projects()])
      .then(([orgList, projectList]) => {
        setOrgs(orgList);
        setOrg(orgList[0]?.id ?? "");
        setProjects(projectList);
        setChoice(projectList[0]?.ref ?? NEW);
      })
      .catch((err) => setError(`Supabase's projects could not be read: ${err.message}`));
  }, [api]);

  const finish = async (ref: string, label: string) => {
    setStatus("Setting up Kurviq's tables…");
    const values = await setUpProject(api, ref, email);
    databases.add({ ...values, name: label });
    setStatus(null);
    dialogs.set({ kind: "signin", ref, email });
  };

  const run = async () => {
    setError(null);
    try {
      if (choice === NEW) {
        const pass = newDatabasePassword();
        setStatus("Creating the project…");
        const project = await api.createProject({ name: name.trim() || "Kurviq", organizationId: org, region, password: pass });
        setPassword(pass);
        await waitUntilUp(api, project.ref, (state) => setStatus(`Starting the project (${state.toLowerCase().replaceAll("_", " ")})…`));
        await finish(project.ref, project.name);
      } else {
        const project = projects.find((entry) => entry.ref === choice)!;
        await finish(project.ref, project.name);
      }
    } catch (err: any) {
      setStatus(null);
      setError(err.message);
    }
  };

  return (
    <Frame title="Connect with Supabase" onClose={close} wide>
      {!orgs && !error && <p>Reading your Supabase projects…</p>}
      {orgs && (
        <fieldset className="kq-db__projects" disabled={!!status}>
          <legend>Keep Kurviq's scenes in</legend>
          {projects.map((project) => (
            <label key={project.ref} className="kq-db__choice">
              <input type="radio" name="kq-project" checked={choice === project.ref} onChange={() => setChoice(project.ref)} />
              <span className="kq-db__choice-text">
                {project.name} <span className="kq-muted">{project.region} · {project.status.toLowerCase().replaceAll("_", " ")}</span>
              </span>
            </label>
          ))}
          <label className="kq-db__choice">
            <input type="radio" name="kq-project" checked={choice === NEW} onChange={() => setChoice(NEW)} />
            <span className="kq-db__choice-text">
              {"Create a new project"} <span className="kq-muted">(the free plan has two)</span>
            </span>
          </label>
          {choice === NEW && (
            <div className="kq-db__new">
              <label className="kq-field">
                {"Name"}
                <input value={name} onChange={(event) => setName(event.target.value)} />
              </label>
              <label className="kq-field">
                {"Organization"}
                <select value={org} onChange={(event) => setOrg(event.target.value)}>
                  {orgs.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="kq-field">
                {"Region"}
                <select value={region} onChange={(event) => setRegion(event.target.value)}>
                  {REGIONS.map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </fieldset>
      )}
      {password && (
        <div className="kq-notice">
          <p>
            <strong>The new database's password</strong>, shown only now: keep it in your password manager. Kurviq doesn't
            keep it and never needs it.
          </p>
          <code className="kq-db__secret">{password}</code>{" "}
          <button type="button" className="scenes-btn" onClick={() => void copyText(password).then(setCopied)}>
            {copied ? "Copied ✓" : "Copy"}
          </button>
        </div>
      )}
      {status && <output className="kq-muted">{status}</output>}
      {error && <p className="scenes-error">{error}</p>}
      <div className="scenes-row">
        <button type="button" className="scenes-btn scenes-btn--primary" disabled={!orgs || !!status || (choice === NEW && !org)} onClick={() => void run()}>
          {choice === NEW ? "Create and connect" : "Connect this project"}
        </button>
        <button type="button" className="scenes-btn" onClick={close}>
          Cancel
        </button>
      </div>
    </Frame>
  );
};

// -----------------------------------------------------------------------------
// sign in to a database: an email link, or the email's code
// -----------------------------------------------------------------------------

const SignInDialog = ({ dbRef, sceneId, email: given }: { dbRef: string; sceneId?: string; email?: string }) => {
  const state = databases.use();
  const conn = state.connections.find((entry) => entry.ref === dbRef);
  const session = state.sessions[dbRef];
  const [email, setEmail] = useState(given ?? connection.getState().user?.email ?? "");
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (session?.status === "signed-in") {
      close();
      if (sceneId) {
        void openDatabaseScene(dbRef, sceneId);
      }
    }
  }, [session?.status]);

  if (!conn) {
    return null;
  }
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await signInByEmail(dbRef, email, sceneId);
      if (result.sent) {
        setSent(true);
      } else {
        setError(result.why);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      await verifyCode(dbRef, email, code);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Frame title={`Sign in to ${conn.name}`} onClose={close}>
      <p>No password: the database sends you an email with a sign-in link that brings you back here.</p>
      <label className="kq-field">
        {"Your email"}
        <input type="email" autoComplete="email" value={email} disabled={sent} onChange={(event) => setEmail(event.target.value)} />
      </label>
      {!sent ? (
        <button type="button" className="scenes-btn scenes-btn--primary" disabled={busy || !email.includes("@")} onClick={() => void send()}>
          {busy ? "Sending…" : "Email me a sign-in link"}
        </button>
      ) : (
        <>
          <p className="kq-notice">Sent to {email}: open the link in it (in this browser).</p>
          <label className="kq-field">
            {"Or the code from the email (shown there when the database's email template has one)"}
            <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value.replaceAll(/\s/g, ""))} />
          </label>
          <div className="scenes-row">
            <button type="button" className="scenes-btn scenes-btn--primary" disabled={busy || code.length < 6} onClick={() => void verify()}>
              Sign in with the code
            </button>
            <button type="button" className="scenes-btn" onClick={() => setSent(false)}>
              Send again
            </button>
          </div>
        </>
      )}
      {error && <p className="scenes-error">{error}</p>}
    </Frame>
  );
};

// -----------------------------------------------------------------------------
// "Move to…"
// -----------------------------------------------------------------------------

/** the homes a scene can go to: this browser, Google Drive (signed in), every database signed in to */
const useHomeChoices = () => {
  const state = databases.use();
  const signedIn = useSyncExternalStore(connection.subscribe, connection.isActive);
  const choices: { value: NewHome; label: string }[] = [{ value: "browser", label: "This browser only" }];
  if (signedIn) {
    choices.push({ value: "drive", label: "Google Drive" });
  }
  for (const entry of state.connections) {
    if (state.sessions[entry.ref]?.status === "signed-in") {
      choices.push({ value: `db:${entry.ref}`, label: entry.name });
    }
  }
  return choices;
};

const homeKeyOf = (name: string): NewHome => {
  const db = scenesController.databaseOf(name);
  if (db) {
    return `db:${db.ref}`;
  }
  return scenesController.isLocalOnly(name) ? "browser" : "drive";
};

type OldCopy = { home: SceneHome; key: NewHome; version: string | null; id: string | null };

const MoveDialog = ({ name }: { name: string }) => {
  const choices = useHomeChoices();
  const from = homeKeyOf(name);
  const [target, setTarget] = useState<NewHome | null>(() => choices.find((choice) => choice.value !== from)?.value ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [old, setOld] = useState<OldCopy | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const move = async () => {
    if (!target) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const left = await scenesController.moveTo(name, target);
      setOld(left && left.key !== "browser" ? left : null);
      setDone(`“${name}” is in ${scenesController.homeOf(name).label} now.`);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const removeOld = async () => {
    setBusy(true);
    try {
      await scenesController.removeOldCopy(old!, name);
      setOld(null);
      setDone(`The old copy is deleted${old!.key === "drive" ? " (in Google Drive's bin)" : ""}.`);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame title={`Move “${name}” to…`} onClose={close}>
      {done ? (
        <>
          <p>{done}</p>
          {old && (
            <>
              <p className="kq-muted">
                The old copy in {old.home.label} stays with a note that it moved (its link opens the new place). Delete it?
              </p>
              <div className="scenes-row">
                <button type="button" className="scenes-btn scenes-btn--danger" disabled={busy} onClick={() => void removeOld()}>
                  Delete the old copy
                </button>
                <button type="button" className="scenes-btn" onClick={close}>
                  Keep it
                </button>
              </div>
            </>
          )}
          {!old && (
            <button type="button" className="scenes-btn scenes-btn--primary" onClick={close}>
              Done
            </button>
          )}
        </>
      ) : (
        <>
          <p className="kq-muted">Everything moves: elements, pictures, fonts, comments, slides and presentation settings.</p>
          <fieldset className="kq-db__projects">
            <legend>Keep it in</legend>
            {choices.map((choice) => (
              <label key={choice.value} className="kq-db__choice">
                <input type="radio" name="kq-move" disabled={choice.value === from} checked={target === choice.value} onChange={() => setTarget(choice.value)} />
                <span>
                  {choice.label}
                  {choice.value === from ? <span className="kq-muted"> (it is here now)</span> : null}
                </span>
              </label>
            ))}
          </fieldset>
          {choices.length < 2 && <p className="kq-muted">Sign in with Google or connect a database to have somewhere to move it.</p>}
          {error && <p className="scenes-error">{error}</p>}
          <div className="scenes-row">
            <button type="button" className="scenes-btn scenes-btn--primary" disabled={busy || !target || target === from} onClick={() => void move()}>
              {busy ? "Moving…" : "Move"}
            </button>
            <button type="button" className="scenes-btn" onClick={close}>
              Cancel
            </button>
          </div>
        </>
      )}
    </Frame>
  );
};

const MovedNote = ({ home, link }: { home: HomeKind; link: string }) => (
  <Frame title="This scene moved" onClose={close}>
    <p>It is kept in {homeName(home)} now.</p>
    <div className="scenes-row">
      <a className="scenes-btn scenes-btn--primary" href={link}>
        Open it there
      </a>
      <button type="button" className="scenes-btn" onClick={close}>
        Close
      </button>
    </div>
  </Frame>
);

/** the dialogs of the database home (rendered once, next to the editor) */
export const DatabaseDialogs = () => {
  const current = dialogs.use();
  if (!current) {
    return null;
  }
  switch (current.kind) {
    case "connect":
      return <ConnectDialog />;
    case "setup":
      return <SetupDialog token={current.token} email={current.email} />;
    case "signin":
      return <SignInDialog key={current.ref} dbRef={current.ref} sceneId={current.sceneId} email={current.email} />;
    case "share":
      return <DatabaseShareDialog name={current.name} onClose={close} />;
    case "move":
      return <MoveDialog name={current.name} />;
    case "moved":
      return <MovedNote home={current.home} link={current.link} />;
  }
};

// -----------------------------------------------------------------------------
// opening a database scene by its link; the bar over a database scene
// -----------------------------------------------------------------------------

/** a database scene by id (a link): opened in the editor if this person may read it; moved: the note */
export const openDatabaseScene = async (ref: string, sceneId: string) => {
  const { databaseHome } = await import("./connections");
  const home = databaseHome(ref);
  const scene = await home.sceneById(sceneId).catch(() => null);
  if (!scene) {
    window.alert(`This scene is not in ${home.label}, or you have no access to it.`);
    return false;
  }
  if (scene.moved_to) {
    showMovedNote(scene.moved_to.home, scene.moved_to.link);
    return false;
  }
  const name = await scenesController.adoptDatabaseScene(ref, sceneId, scene.name);
  await scenesController.open(name);
  return true;
};

/** over a database scene: what this person may do there, a paused project, signing in */
export const DatabaseBar = () => {
  const state = useSyncExternalStore(scenesController.subscribe, scenesController.getState);
  const dbState = databases.use();
  const db = scenesController.databaseOf(state.current);
  const access = state.homeAccess;
  const session = db ? dbState.sessions[db.ref] : undefined;
  const readOnly = db ? access?.readOnly ?? null : null;
  useEffect(() => {
    const api = scenesController.getApi();
    if (readOnly && api && !api.getAppState().viewModeEnabled) {
      api.updateScene({ appState: { viewModeEnabled: true } });
    }
  }, [readOnly, state.current, state.busy]);
  if (!db) {
    return null;
  }
  const paused = session?.paused || readOnly === PAUSED_MESSAGE;
  const text = paused ? PAUSED_MESSAGE : readOnly;
  if (!text) {
    return null;
  }
  const dashboard = `https://supabase.com/dashboard/project/${db.ref}`;
  return (
    <output className="kq-readonly kq-db-bar">
      {text}
      {session?.status === "signed-out" && (
        <button type="button" className="scenes-link" onClick={() => openSignInDialog(db.ref)}>
          Sign in
        </button>
      )}
      {paused && (
        <a className="scenes-link" href={dashboard} target="_blank" rel="noopener noreferrer">
          Open Supabase
        </a>
      )}
    </output>
  );
};

// -----------------------------------------------------------------------------
// settings: where new scenes go, the connected databases
// -----------------------------------------------------------------------------

export const NewScenesHome = () => {
  const choices = useHomeChoices();
  useSyncExternalStore(scenesController.subscribe, scenesController.getState);
  const value = scenesController.newScenesHome();
  return (
    <label className="kq-field kq-db-setting">
      {"New scenes are kept"}
      <select value={value} onChange={(event) => scenesController.setNewScenesHome(event.target.value as NewHome)}>
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.value === "browser" ? "in this browser" : `in ${choice.label}`}
          </option>
        ))}
      </select>
    </label>
  );
};

export const DatabaseSettings = () => {
  const state = databases.use();
  return (
    <section className="kq-db-settings" aria-label="Databases">
      <NewScenesHome />
      {state.connections.map((entry) => {
        const session = state.sessions[entry.ref];
        let who = "Connecting…";
        if (session?.status === "signed-in") {
          who = session.spaceRole ? `${session.email} · ${session.spaceRole}` : String(session.email);
        } else if (session?.status === "signed-out") {
          who = "Not signed in";
        }
        return (
          <div key={entry.ref} className="kq-db-settings__row">
            <span className="kq-db-settings__name">
              <strong>{entry.name}</strong>
              <span className="kq-muted">{session?.paused ? PAUSED_MESSAGE : who}</span>
            </span>
            {session?.status === "signed-in" ? (
              <button type="button" className="scenes-link" onClick={() => void signOutDb(entry.ref)}>
                Sign out
              </button>
            ) : (
              <button type="button" className="scenes-link" onClick={() => openSignInDialog(entry.ref)}>
                Sign in
              </button>
            )}
            <button
              type="button"
              className="scenes-link"
              onClick={() => {
                if (window.confirm(`Disconnect “${entry.name}” in this browser?\n\nIts scenes stay in the database; connect it again to work on them.`)) {
                  void databases.remove(entry.ref);
                }
              }}
            >
              Disconnect
            </button>
          </div>
        );
      })}
      <button type="button" className="scenes-btn" onClick={openConnectDialog}>
        Connect a database
      </button>
    </section>
  );
};

/** the open scene's database connection (for the panels) */
export const useDatabaseOf = (name: string | null) => {
  databases.use();
  const db = scenesController.databaseOf(name);
  return db ? connectionOf(db.ref) : null;
};
