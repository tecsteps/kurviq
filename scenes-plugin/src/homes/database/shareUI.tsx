// Sharing a database scene: invite people by email with a role (viewer,
// commenter, editor) and an optional end date; the database's own mailer
// sends them a sign-in link that opens the scene (no Google account, no
// password). People with access, the space's members, "anyone with the link
// can view", and the link itself. The database's row-level security decides
// (./schema.sql): this panel only writes its rows.

import { useEffect, useRef, useState } from "react";

import { scenesController } from "../../controller";
import { useDialogFocus } from "../../dialogFocus";
import { copyText } from "../../useCopy";

import { connectionOf, databaseHome, databases, invite, members, sceneAccess, sceneLink } from "./connections";

import type { Access, Member } from "./connections";

const ROLES: [Access["role"], string][] = [
  ["viewer", "Viewer"],
  ["commenter", "Commenter"],
  ["editor", "Editor"],
];

const roleLabel = (role: string) => ROLES.find(([value]) => value === role)?.[1] ?? (role === "owner" ? "Owner" : role);

/** an end date (yyyy-mm-dd, the end of that day here) as the database's timestamp; "" → none */
export const endOfDay = (date: string) => (date ? new Date(`${date}T23:59:59`).toISOString() : null);

const dayOf = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

const Person = ({ email, children }: { email: string; children: React.ReactNode }) => (
  <li>
    <span className="kq-share__avatar" aria-hidden>
      {email.slice(0, 1).toUpperCase()}
    </span>
    <span className="kq-share__who">
      <span className="kq-share__name">{email}</span>
    </span>
    {children}
  </li>
);

export const DatabaseShareDialog = ({ name, onClose }: { name: string; onClose: () => void }) => {
  const db = scenesController.databaseOf(name);
  const state = databases.use();
  const conn = db ? connectionOf(db.ref) : null;
  const session = db ? state.sessions[db.ref] : undefined;
  const [sceneId, setSceneId] = useState<string | null>(db?.id ?? null);
  const [canShare, setCanShare] = useState(false);
  const [people, setPeople] = useState<Access[]>([]);
  const [space, setSpace] = useState<Member[]>([]);
  const [isPublic, setPublic] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Access["role"]>("editor");
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; link?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useDialogFocus(dialog, onClose);

  const reload = async (id: string) => {
    const home = databaseHome(db!.ref);
    const [file, scene] = await Promise.all([home.sharing!.fileOf(name), home.sceneById(id)]);
    setCanShare(!!file?.canShare);
    setPublic(scene?.public === "view");
    setPeople(await sceneAccess.list(db!.ref, id).catch(() => []));
    setSpace(await members.list(db!.ref).catch(() => []));
  };

  useEffect(() => {
    if (!db || session?.status !== "signed-in") {
      return;
    }
    scenesController
      .ensureInDatabase(name)
      .then(async (id) => {
        setSceneId(id);
        await reload(id);
      })
      .catch((err) => setError(err.message));
  }, [name, session?.status]);

  if (!db || !conn) {
    return null;
  }
  const link = sceneId ? sceneLink(conn, sceneId) : null;
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await reload(sceneId!);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const sendInvite = () =>
    act(async () => {
      const result = await invite(db.ref, sceneId!, email, role, endOfDay(until));
      setNote(
        result.sent
          ? { text: `${conn.name} emailed ${email.trim()} a sign-in link to this scene.` }
          : { text: `${email.trim()} has access, but no email went out: ${result.why} Send them this link:`, link: result.link },
      );
      setEmail("");
      setUntil("");
    });

  return (
    <div className="kq-overlay">
      <dialog open className="kq-dialog kq-share kq-db" aria-modal="true" aria-labelledby="kq-db-share-title" ref={dialog}>
        <div className="kq-dialog__head">
          <h2 id="kq-db-share-title">Share “{name}”</h2>
          <button type="button" className="kq-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <p className="kq-muted">
          In {conn.name}. People you invite sign in with their email: the database sends them a link (no password, no Google
          account needed).
        </p>
        {session?.status !== "signed-in" && <p className="kq-notice">Sign in to {conn.name} to share this scene.</p>}
        {canShare && (
          <form
            className="kq-db__invite"
            onSubmit={(event) => {
              event.preventDefault();
              void sendInvite();
            }}
          >
            <label className="kq-field">
              {"Invite by email"}
              <input type="email" required value={email} placeholder="name@example.com" onChange={(event) => setEmail(event.target.value)} />
            </label>
            <label className="kq-field">
              {"Role"}
              <select value={role} onChange={(event) => setRole(event.target.value as Access["role"])}>
                {ROLES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="kq-field">
              {"Access until (optional)"}
              <input type="date" value={until} min={new Date().toISOString().slice(0, 10)} onChange={(event) => setUntil(event.target.value)} />
            </label>
            <button type="submit" className="scenes-btn scenes-btn--primary" disabled={busy || !email.includes("@") || !sceneId}>
              {busy ? "Inviting…" : "Invite"}
            </button>
          </form>
        )}
        {note && (
          <div className="kq-notice">
            <p>{note.text}</p>
            {note.link && <input readOnly value={note.link} aria-label="Invitation link" onFocus={(event) => event.target.select()} />}
          </div>
        )}
        <h3 className="kq-db__heading">People with access</h3>
        <ul className="kq-share__people">
          {people.map((person) => (
            <Person key={person.email} email={person.email}>
              {canShare ? (
                <>
                  <select
                    aria-label={`Role of ${person.email}`}
                    value={person.role}
                    disabled={busy}
                    onChange={(event) => void act(() => sceneAccess.set(db.ref, sceneId!, person.email, event.target.value as Access["role"], person.expires_at))}
                  >
                    {ROLES.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <input
                    type="date"
                    aria-label={`Access of ${person.email} until`}
                    value={dayOf(person.expires_at)}
                    disabled={busy}
                    onChange={(event) => void act(() => sceneAccess.set(db.ref, sceneId!, person.email, person.role, endOfDay(event.target.value)))}
                  />
                  <button type="button" className="scenes-link" disabled={busy} onClick={() => void act(() => sceneAccess.remove(db.ref, sceneId!, person.email))}>
                    Remove
                  </button>
                </>
              ) : (
                <span className="kq-share__role">{roleLabel(person.role)}</span>
              )}
            </Person>
          ))}
          {space.map((member) => (
            <Person key={`space:${member.email}`} email={member.email}>
              <span className="kq-share__role kq-muted">{roleLabel(member.role)} of the space</span>
            </Person>
          ))}
        </ul>
        <h3 className="kq-db__heading">General access</h3>
        <label className="scenes-switch">
          <input
            type="checkbox"
            role="switch"
            checked={isPublic}
            disabled={!canShare || busy}
            onChange={(event) => void act(() => databaseHome(db.ref).setPublic(name, event.target.checked))}
          />
          <span className="scenes-switch__track" />
          <span className="scenes-switch__label">
            {"Anyone with the link can view"}
            <span className="scenes-switch__hint">{isPublic ? "read only, without an account (comments stay for people with access)" : "only the people above"}</span>
          </span>
        </label>
        {error && <p className="scenes-error">{error}</p>}
        <div className="scenes-row">
          <button
            type="button"
            className="scenes-btn"
            disabled={!link}
            onClick={() =>
              link &&
              void copyText(link).then((done) => {
                setCopied(done);
                setTimeout(() => setCopied(false), 1500);
              })
            }
          >
            {copied ? "Copied ✓" : "Copy link"}
          </button>
          <button type="button" className="scenes-btn scenes-btn--primary" onClick={onClose}>
            Done
          </button>
        </div>
      </dialog>
    </div>
  );
};
