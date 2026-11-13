// Which version of Kurviq's schema (./schema.sql) a database has, and the
// owner's row of a new space: small, without the SQL itself.

/** the schema version this Kurviq needs (kurviq_schema_version() in the database) */
export const SCHEMA_VERSION = 1;

const EMAIL = /^[^\s@'"\\]{1,64}@[^\s@'"\\]{1,190}$/;

/** the owner of a new space (the person who sets it up), unless it has one */
export const ownerSql = (email: string) => {
  const clean = email.trim().toLowerCase();
  if (!EMAIL.test(clean)) {
    throw new Error("That is not an email address");
  }
  return `insert into public.kurviq_members (email, role) select '${clean}', 'owner' where not exists (select 1 from public.kurviq_members where role = 'owner') on conflict (email) do update set role = 'owner';`;
};

/** what a database answers to kurviq_schema_version(): fine, too old (update it), or not set up */
export const schemaState = (version: unknown) => {
  if (version === null || version === undefined) {
    return "missing" as const;
  }
  return Number(version) >= SCHEMA_VERSION ? ("ok" as const) : ("old" as const);
};
