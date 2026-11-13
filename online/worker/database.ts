// Kurviq's D1 database (binding FEEDBACK, database kurviq-feedback): the one
// type for it, and the one place its tables are defined.
//
// The tables are made on the first use in an isolate, all in one batch (one
// round trip), instead of by each module on its own. A new column or table
// goes into SCHEMA below (CREATE … IF NOT EXISTS, or an ALTER that tolerates
// running twice), so every module and the retention job can rely on the
// tables being there.
//
// Kurviq keeps no customer data and no Google tokens here
// (specs/2026-11-13-drive-collaboration-without-server-data.md): only feedback,
// contact messages, short links and the statistics' counters.

/** a prepared statement, as far as Kurviq uses it */
export type D1Statement = {
  bind: (...values: unknown[]) => D1Statement;
  first: <T>() => Promise<T | null>;
  run: () => Promise<{ meta?: { changes?: number } }>;
  all: <T>() => Promise<{ results?: T[] }>;
};

/** the D1 binding, as far as Kurviq uses it (batch: one transaction) */
export type D1 = {
  prepare: (sql: string) => D1Statement;
  batch: (statements: D1Statement[]) => Promise<unknown>;
};

export const SCHEMA = [
  // bug reports and change requests (./feedback.ts)
  `CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  scene TEXT,
  source TEXT NOT NULL,
  sender TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  note TEXT
)`,
  // the contact form (./contact.ts)
  `CREATE TABLE IF NOT EXISTS contact_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  name TEXT,
  email TEXT NOT NULL,
  message TEXT NOT NULL,
  sender TEXT NOT NULL,
  emailed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'new'
)`,
  // short links (./pubLinks.ts)
  `CREATE TABLE IF NOT EXISTS pub_links (
  name TEXT PRIMARY KEY,
  file_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
)`,
  // usage statistics (./stats.ts)
  `CREATE TABLE IF NOT EXISTS stats_hourly (hour TEXT NOT NULL, metric TEXT NOT NULL, dim TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY (hour, metric, dim)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS stats_daily (day TEXT NOT NULL, metric TEXT NOT NULL, dim TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY (day, metric, dim)) WITHOUT ROWID`,
  // the statistics' writes that D1 committed: a write is never applied twice (./stats.ts flush)
  `CREATE TABLE IF NOT EXISTS stats_flushes (id TEXT PRIMARY KEY, at TEXT NOT NULL) WITHOUT ROWID`,
  // migration: shared folders no longer go through the server; their registrations (with the
  // owners' sealed sign-ins) and member lists are deleted (a no-op once they are gone)
  `DROP TABLE IF EXISTS shared_folder_members`,
  `DROP TABLE IF EXISTS shared_folders`,
];

let ready: Promise<void> | null = null;

/** the database with its tables, or null when there is none (a Kurviq without D1) */
export const database = async (db: D1 | undefined): Promise<D1 | null> => {
  if (!db) {
    return null;
  }
  ready ??= db
    .batch(SCHEMA.map((sql) => db.prepare(sql)))
    .then(() => undefined)
    .catch((error: unknown) => {
      // tried again with the next request
      ready = null;
      throw error;
    });
  await ready;
  return db;
};

/** for tests: the tables are made again on the next use (a new database) */
export const resetSchemaForTests = () => {
  ready = null;
};
