// The browser's link to one connected database (Supabase): supabase-js,
// loaded only when a database home is used (it is not in the app's first
// download), signed in as the person (email link or code; the session is
// Supabase's, kept in this browser), and the scene rows of ./rows.ts over it.
// Everything goes from this browser to the database directly.

import { asHomeError, homeError } from "./rows";
import { elementRows } from "./sceneJson";

import type { CommentRow, MetaRow, Role, SceneRow, SceneRows, VersionRow, WholeScene } from "./rows";
import type { ElementRow, FileEntry } from "./sceneJson";
import type { SupabaseClient } from "@supabase/supabase-js";

export const FILES_BUCKET = "kurviq-files";
/** PostgREST answers at most this many rows at once */
const PAGE = 1000;

/** one connected database: its address, public (publishable) key and name; never a secret */
export type DbConnection = {
  /** the project's ref (https://<ref>.supabase.co), Kurviq's id of the connection */
  ref: string;
  url: string;
  /** the publishable (anon) key: public, row-level security decides */
  key: string;
  /** the space's name ("Tecsteps team") */
  name: string;
  addedAt: string;
};

/** the session's key in this browser (a name with "session": "Move my browser scenes" leaves it, ../../browserMove.ts) */
export const sessionKeyOf = (ref: string) => `kurviq-db-session-${ref}`;

type Answer<T> = { data: T; error: any; status?: number };

/** the data of a supabase-js answer, or its error thrown */
const unwrap = <T>({ data, error, status }: Answer<T>): T => {
  if (error) {
    throw Object.assign(error instanceof Error ? error : new Error(error.message ?? String(error)), {
      code: error.code,
      details: error.details,
      status: status ?? error.status ?? 0,
    });
  }
  return data;
};

const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** all rows of a query, page by page */
const allPages = async <T>(page: (from: number, to: number) => PromiseLike<Answer<T[] | null>>) => {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const chunk = unwrap(await page(from, from + PAGE - 1)) ?? []; // NOSONAR S9382: pages in order on purpose
    rows.push(...chunk);
    if (chunk.length < PAGE) {
      return rows;
    }
  }
};

export const dataUrlToBlob = (dataURL: string) => {
  const comma = dataURL.indexOf(",");
  const header = dataURL.slice(5, comma);
  const mime = header.split(";")[0] || "application/octet-stream";
  const body = dataURL.slice(comma + 1);
  if (!header.endsWith(";base64")) {
    return new Blob([decodeURIComponent(body)], { type: mime });
  }
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.codePointAt(i) ?? 0;
  }
  return new Blob([bytes], { type: mime });
};

export const blobToDataUrl = async (blob: Blob, mimeType: string) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCodePoint(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
};

const SCENE_FIELDS = "id,name,public,revision,updated_at";

/** the scene rows of ./rows.ts on a Supabase client */
export const supabaseRows = (client: SupabaseClient, email: () => string | null): SceneRows => {
  const scenes = () => client.from("kurviq_scenes");
  const live = <Q extends { is: (column: string, value: null) => Q }>(query: Q) => query.is("deleted_at", null).is("moved_to", null);
  const removePictures = async (id: string) => {
    const listed = unwrap(await client.storage.from(FILES_BUCKET).list(id, { limit: PAGE })) ?? [];
    if (listed.length) {
      unwrap(await client.storage.from(FILES_BUCKET).remove(listed.map((object) => `${id}/${object.name}`)));
    }
  };
  return {
    scenes: async () => unwrap(await live(scenes().select(SCENE_FIELDS)).order("name")) as SceneRow[],
    sceneByName: async (name) => unwrap(await live(scenes().select(SCENE_FIELDS).eq("name", name)).maybeSingle()) as SceneRow | null,
    sceneById: async (id) => (isUuid(id) ? (unwrap(await scenes().select(`${SCENE_FIELDS},moved_to`).eq("id", id).maybeSingle()) as SceneRow | null) : null),
    createScene: async (name) => unwrap(await scenes().insert({ name, created_by: email() }).select(SCENE_FIELDS).single()) as SceneRow,
    renameScene: async (id, to) => {
      unwrap(await scenes().update({ name: to }).eq("id", id));
    },
    deleteScene: async (id) => {
      await removePictures(id).catch(() => {}); // pictures are best effort: the scene goes anyway
      unwrap(await scenes().delete().eq("id", id));
    },
    setPublic: async (id, on) => {
      unwrap(await scenes().update({ public: on ? "view" : "none" }).eq("id", id));
    },
    markMoved: async (id, mark) => {
      unwrap(await scenes().update({ moved_to: mark }).eq("id", id));
    },
    elements: (id, since) =>
      allPages<ElementRow>((from, to) => {
        const query = client.from("kurviq_elements").select("id,version,version_nonce,pos,data,rev").eq("scene_id", id);
        return (since === undefined ? query : query.gt("rev", since)).order("id").range(from, to);
      }),
    meta: async (id) => {
      const row = unwrap(await client.from("kurviq_scene_meta").select("envelope,files,rev").eq("scene_id", id).maybeSingle()) as Record<string, any> | null;
      return row ? ({ envelope: JSON.stringify(row.envelope ?? {}), files: row.files ?? {}, rev: row.rev } satisfies MetaRow) : null;
    },
    comments: (id, since) =>
      allPages<CommentRow>((from, to) => {
        const query = client.from("kurviq_comments").select("id,data,rev").eq("scene_id", id);
        return (since === undefined ? query : query.gt("rev", since)).order("id").range(from, to);
      }),
    saveScene: async (id, base, scene: WholeScene) =>
      unwrap(
        await client.rpc("kurviq_save_scene", {
          scene: id,
          base,
          elements: scene.elements,
          envelope: JSON.parse(scene.envelope || "{}"),
          files: scene.files,
          comments: scene.comments,
        }),
      ) as number,
    putElements: async (id, elements) => unwrap(await client.rpc("kurviq_put_elements", { scene: id, elements: elementRows(elements) })) as number,
    putComments: async (id, comments) => unwrap(await client.rpc("kurviq_put_comments", { scene: id, comments })) as number,
    putMeta: async (id, envelope, files: Record<string, FileEntry>) =>
      unwrap(await client.rpc("kurviq_put_meta", { scene: id, envelope: envelope === null ? null : JSON.parse(envelope), files })) as number,
    putFile: async (id, fileId, dataURL, mimeType) => {
      unwrap(await client.storage.from(FILES_BUCKET).upload(`${id}/${fileId}`, dataUrlToBlob(dataURL), { contentType: mimeType, upsert: true }));
    },
    getFile: async (id, fileId, mimeType) => {
      const { data, error } = await client.storage.from(FILES_BUCKET).download(`${id}/${fileId}`);
      if (error || !data) {
        return null;
      }
      return blobToDataUrl(data, mimeType);
    },
    versions: async (id) =>
      unwrap(await client.from("kurviq_versions").select("id,revision,name,created_by,created_at").eq("scene_id", id).order("created_at", { ascending: false }).limit(50)) as VersionRow[],
    version: async (id, versionId) => {
      const row = unwrap(await client.from("kurviq_versions").select("snapshot,revision").eq("scene_id", id).eq("id", versionId).maybeSingle()) as Record<string, any> | null;
      return row ? { snapshot: JSON.stringify(row.snapshot), revision: row.revision } : null;
    },
    addVersion: async (id, revision, snapshot, name = null) => {
      unwrap(await client.from("kurviq_versions").insert({ scene_id: id, revision, snapshot: JSON.parse(snapshot), name, created_by: email() }));
    },
    roleOn: async (id) => (unwrap(await client.rpc("kurviq_scene_role", { scene: id })) as Role | null) ?? null,
  };
};

/** a client for a connection (supabase-js loaded on first use) */
export const createDbClient = async (connection: DbConnection) => {
  const { createClient } = await import("@supabase/supabase-js");
  return createClient(connection.url, connection.key, {
    auth: {
      storageKey: sessionKeyOf(connection.ref),
      persistSession: true,
      autoRefreshToken: true,
      // the email link's tokens are taken from the URL by ./connections.ts (the link's # part also carries the key)
      detectSessionInUrl: false,
      flowType: "implicit",
    },
  });
};

/** a call's error as the home's (for the connection's own calls: members, sign-in) */
export const dbCall = async <T>(label: string, fn: () => Promise<Answer<T>>): Promise<T> => {
  try {
    return unwrap(await fn());
  } catch (error) {
    throw asHomeError(error, label);
  }
};

export const notSignedIn = (label: string) => homeError(401, `Sign in to ${label} first`, { notConnected: true });
