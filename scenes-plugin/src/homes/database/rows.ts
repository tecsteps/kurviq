// What the database home reads and writes, as calls on the user's database
// (./schema.sql). `SceneRows` is the interface (a fake one in the tests); the
// real one talks to Supabase with supabase-js (./client.ts). Row-level
// security in the database decides what the signed-in person may do; these
// calls only map its answers to the home's errors (HomeError).

import type { HomeError, MovedMark } from "../types";

import type { ElementRow, FileEntry } from "./sceneJson";

export type Role = "owner" | "editor" | "commenter" | "viewer";

export type SceneRow = {
  id: string;
  name: string;
  public: "none" | "view";
  revision: number;
  updated_at: string | null;
  moved_to?: MovedMark | null;
};

export type MetaRow = { envelope: string; files: Record<string, FileEntry>; rev: number };

export type CommentRow = { id: string; data: Record<string, any>; rev: number };

export type VersionRow = { id: string; revision: number; name: string | null; created_by: string | null; created_at: string };

export type WholeScene = {
  elements: Record<string, any>[];
  envelope: string;
  files: Record<string, FileEntry>;
  comments: unknown[];
};

export interface SceneRows {
  /** the live scenes this person may read (not deleted, not moved) */
  scenes(): Promise<SceneRow[]>;
  /** a live scene by name (null: none this person may read) */
  sceneByName(name: string): Promise<SceneRow | null>;
  /** any scene by id, moved ones too (null: none this person may read) */
  sceneById(id: string): Promise<SceneRow | null>;
  /** a new, empty scene (409 exists: the name is taken) */
  createScene(name: string): Promise<SceneRow>;
  renameScene(id: string, to: string): Promise<void>;
  deleteScene(id: string): Promise<void>;
  setPublic(id: string, on: boolean): Promise<void>;
  markMoved(id: string, mark: MovedMark): Promise<void>;
  /** its elements (deleted ones too), those changed after revision `since` if given */
  elements(id: string, since?: number): Promise<ElementRow[]>;
  meta(id: string): Promise<MetaRow | null>;
  comments(id: string, since?: number): Promise<CommentRow[]>;
  /** a whole scene, only on revision `base` (null: any); 409 with remoteVersion otherwise. The new revision */
  saveScene(id: string, base: number | null, scene: WholeScene): Promise<number>;
  /** changed elements (each taken if newer); the scene's revision */
  putElements(id: string, elements: Record<string, any>[]): Promise<number>;
  putComments(id: string, comments: unknown[]): Promise<number>;
  /** settings (null: unchanged) and pictures added to the index */
  putMeta(id: string, envelope: string | null, files: Record<string, FileEntry>): Promise<number>;
  putFile(id: string, fileId: string, dataURL: string, mimeType: string): Promise<void>;
  getFile(id: string, fileId: string, mimeType: string): Promise<string | null>;
  versions(id: string): Promise<VersionRow[]>;
  version(id: string, versionId: string): Promise<{ snapshot: string; revision: number } | null>;
  /** a version of a scene: whole scene, kept as it is (milestones) */
  addVersion(id: string, revision: number, snapshot: string, name?: string | null): Promise<void>;
  /** this person's role on a scene (null: none; a public scene can still be read) */
  roleOn(id: string): Promise<Role | null>;
}

export const homeError = (status: number, message: string, extra: Partial<HomeError> = {}) =>
  Object.assign(new Error(message), { status, ...extra }) as HomeError;

/** a database that doesn't answer at all: paused (free projects pause after a week unused) or not reachable */
export const PAUSED_MESSAGE = "Your database is paused: open Supabase to wake it";

/** whether an answer says the project is paused (Supabase answers 540 / "paused" for it) */
export const isPausedAnswer = (status: number, text: string) => status === 540 || (status >= 500 && /paus(ed|ing)|inactive/i.test(text));

/** already one of the home's errors (thrown by a call here, passed on) */
const isHomeError = (value: unknown): value is HomeError =>
  value instanceof Error && typeof (value as HomeError).status === "number" && ["offline", "notConnected", "exists", "remoteVersion", "readOnly"].some((key) => key in value);

type Failure = { code: string; message: string; status: number; details: unknown };

/** the failures with a meaning of their own, in order: a test, and the home's error for it */
const FAILURES: [(failure: Failure) => boolean, (failure: Failure, what: string) => HomeError][] = [
  [({ status, message }) => isPausedAnswer(status, message), () => homeError(503, PAUSED_MESSAGE, { offline: true, paused: true })],
  [({ code }) => code === "P0409", ({ details }) => homeError(409, "The scene was changed meanwhile", { remoteVersion: details ? String(details) : null })],
  [({ code }) => code === "23505", () => homeError(409, "A scene with this name already exists in the database", { exists: true })],
  [({ code, status }) => code === "P0002" || status === 404, () => homeError(404, "Scene not found in the database")],
  [
    ({ code, status }) => code === "42501" || status === 401 || status === 403,
    ({ message }) => homeError(403, message.includes("row-level security") ? "You may not change this scene" : message, { readOnly: true }),
  ],
  [({ code, message }) => code === "PGRST301" || /JWT|not signed in/i.test(message), (_failure, what) => homeError(401, `${what}: sign in again`, { notConnected: true })],
  [({ status, message }) => !status || /fetch|network|Load failed|ECONN/i.test(message), (_failure, what) => homeError(0, `${what} is not reachable: working locally`, { offline: true })],
];

/**
 * The home's error for a failed call: network failures are `offline` (keep
 * working, retry later), a paused project is `offline` + `paused`, refused
 * by row-level security 403 / readOnly, a changed scene 409 with its
 * revision, missing rows 404.
 */
export const asHomeError = (error: unknown, what = "The database"): HomeError => {
  const value = error as any;
  if (isHomeError(value)) {
    return value;
  }
  const failure: Failure = {
    code: String(value?.code ?? ""),
    message: String(value?.message ?? value ?? "failed"),
    status: Number(value?.status ?? value?.statusCode ?? 0),
    details: value?.details,
  };
  const known = FAILURES.find(([test]) => test(failure));
  if (known) {
    return known[1](failure, what);
  }
  return homeError(failure.status >= 400 ? failure.status : 500, failure.message);
};
