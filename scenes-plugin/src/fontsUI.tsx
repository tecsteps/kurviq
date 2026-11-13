// "Add font…": the entry at the bottom of Excalidraw's font picker (injected
// by ../vite.config.mts) and its dialog: a font from Google Fonts by name, or
// a font file. See ./fonts.ts for how fonts are registered and stored.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import clsx from "clsx";

import { IS_ONLINE } from "./api";
import { createStore } from "./externalStore";
import { addFont, customFonts, fontFromFile, fontFromGoogle } from "./fonts";

// the dialog's look (shared with the online UI; also needed in the local install)
import "./online/online.scss";

const openStore = createStore(false);
const setOpen = openStore.set;
const useOpen = openStore.use;

/** at the bottom of Excalidraw's font picker */
export const AddFontButton = () => (
  <button
    type="button"
    className="kq-add-font"
    title="Google Fonts or a font file"
    onClick={(event) => {
      // close the picker first: it lists its fonts once, when it opens
      event.currentTarget.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      setOpen(true);
    }}
  >
    + Add font…
  </button>
);

/** "Inter-Regular.woff2" → "Inter" */
const familyFromFileName = (name: string) =>
  name
    .replace(/\.[^.]+$/, "")
    .replace(/[-_ ]?(Regular|Variable|VariableFont|Book|Normal|Roman|wght|\[.*\])+$/i, "") // NOSONAR S8786: preserve greedy filename suffix matching; an equivalent rewrite has not been established
    .replace(/_+/g, " ")
    .trim();

const AddFontDialog = () => {
  const [mode, setMode] = useState<"google" | "file">("google");
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useSyncExternalStore(customFonts.subscribe, customFonts.version);

  useEffect(() => {
    input.current?.focus();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setAdded(null);
    try {
      if (mode === "file" && !file) {
        throw new Error("Choose a font file");
      }
      const font = mode === "google" ? await fontFromGoogle(name, { online: IS_ONLINE }) : await fontFromFile(file!, name);
      await addFont(font);
      setAdded(font.family);
      setName("");
      setFile(null);
    } catch (err: any) {
      setError(err?.message || "The font could not be added");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="kq-overlay" onPointerDown={(event) => event.target === event.currentTarget && setOpen(false)}>
      <form // NOSONAR S6847, S6819: form submission and existing modal focus/layout require the form dialog
        className="kq-dialog kq-dialog--narrow"
        role="dialog"
        aria-modal="true"
        aria-labelledby="kq-font-title"
        onKeyDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          submit().catch((error) => console.error("[fonts] could not add font", error));
        }}
      >
        <div className="kq-dialog__head">
          <h2 id="kq-font-title">Add a font</h2>
          <button type="button" className="kq-close" aria-label="Close" onClick={() => setOpen(false)}>
            ×
          </button>
        </div>
        <div className="kq-tabs" role="tablist">
          {(
            [
              ["google", "Google Fonts"],
              ["file", "Font file"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              className={clsx("kq-tab", { "kq-tab--active": mode === value })}
              onClick={() => {
                setMode(value);
                setError(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {mode === "google" ? (
          <>
            <label className="kq-field">
              <span>Font name</span>
              <input
                ref={input}
                value={name}
                placeholder="e.g. Geist, JetBrains Mono, Inter"
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <p className="kq-muted">
              Any family from{" "}
              <a href="https://fonts.google.com" target="_blank" rel="noopener noreferrer">
                fonts.google.com
              </a>
              , by its exact name. All of them are free to use and share.
            </p>
          </>
        ) : (
          <>
            <label className="kq-field">
              <span>Font file (.woff2, .woff, .ttf, .otf)</span>
              <input
                type="file"
                accept=".woff2,.woff,.ttf,.otf"
                onChange={(event) => {
                  const picked = event.target.files?.[0] ?? null;
                  setFile(picked);
                  if (picked && !name) {
                    setName(familyFromFileName(picked.name));
                  }
                }}
              />
            </label>
            <label className="kq-field">
              <span>Name</span>
              <input value={name} placeholder="e.g. Company Sans" onChange={(event) => setName(event.target.value)} />
            </label>
            <p className="kq-muted">
              Only fonts you may share: everyone who can see a scene that uses it gets the font with it.
            </p>
          </>
        )}
        <p className="kq-muted">
          The font travels with every scene that uses it (teammates, shared links, PDFs). Regular style; bold and italic
          are drawn by the browser.
        </p>
        {error && <p className="scenes-error">{error}</p>}
        {added && (
          <p className="kq-added">
            ✓ <strong>{added}</strong> added: pick it in the font list.
          </p>
        )}
        <div className="scenes-row">
          <button type="submit" className="scenes-btn scenes-btn--primary" disabled={busy || !name.trim() || (mode === "file" && !file)}>
            {busy ? "Adding…" : "Add font"}
          </button>
          <button type="button" className="scenes-btn" onClick={() => setOpen(false)}>
            Done
          </button>
        </div>
        {customFonts.list().length > 0 && (
          <p className="kq-muted">Your fonts: {customFonts.list().map((font) => font.family).join(", ")}</p>
        )}
      </form>
    </div>
  );
};

/** rendered next to the editor (see index.tsx) */
export const AddFontOverlay = () => (useOpen() ? <AddFontDialog /> : null);
