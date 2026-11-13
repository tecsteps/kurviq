// Kurviq's schema for a user's own database (./schema.sql): the same SQL is
// run by "Connect with Supabase" and shown for the paste-it-yourself setup.
// Loaded only when one of them is used (it is not in the app's first download).

import schema from "./schema.sql?raw";

export { ownerSql, schemaState, SCHEMA_VERSION } from "./schemaVersion";

export const SCHEMA_SQL: string = schema;
