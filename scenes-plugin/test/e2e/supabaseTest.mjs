// The shared Supabase test project (values in the repo's .env, never printed):
// apply Kurviq's schema over a Postgres connection (psql), create test users
// and their sign-in codes with the admin API (no real mail is sent), and clean
// up what a run made. Used by own-database.mjs and the schema check.
//   node scenes-plugin/test/e2e/supabaseTest.mjs apply   applies schema.sql
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadEnv } from "../../../scripts/env.mjs";

const env = loadEnv();
export const SUPABASE_URL = env.KURVIQ_TEST_SUPABASE_URL;
export const PUBLISHABLE_KEY = env.KURVIQ_TEST_SUPABASE_ANON_KEY;
const SECRET_KEY = env.KURVIQ_TEST_SUPABASE_SERVICE_KEY;
export const PROJECT_REF = new URL(SUPABASE_URL || "https://none.supabase.co").hostname.split(".")[0];
const SCHEMA = fileURLToPath(new URL("../../src/homes/database/schema.sql", import.meta.url));

export const configured = () => !!(SUPABASE_URL && PUBLISHABLE_KEY && SECRET_KEY && env.KURVIQ_TEST_SUPABASE_DB_PASSWORD);

/** a psql that runs here (Postgres.app's may be for another CPU) */
const psqlBinary = () => {
  for (const candidate of [process.env.PSQL, "psql-17", "/opt/homebrew/bin/psql-17", "psql"].filter(Boolean)) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {}
  }
  throw new Error("No working psql found: set PSQL to one");
};

/** run SQL on the test project as postgres (session pooler) */
export const runSql = (sql) =>
  execFileSync(
    psqlBinary(),
    [`host=${env.KURVIQ_TEST_SUPABASE_POOLER || "aws-1-eu-central-1.pooler.supabase.com"} port=5432 user=postgres.${PROJECT_REF} dbname=postgres sslmode=require`, "-v", "ON_ERROR_STOP=1", "-q", "-f", "-"],
    { input: sql, env: { ...process.env, PGPASSWORD: env.KURVIQ_TEST_SUPABASE_DB_PASSWORD }, encoding: "utf8" },
  );

export const applySchema = () => runSql(readFileSync(SCHEMA, "utf8"));

const admin = async (path, init = {}) => {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/${path}`, {
    ...init,
    headers: { apikey: SECRET_KEY, authorization: `Bearer ${SECRET_KEY}`, "content-type": "application/json", ...init.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`admin ${path}: ${res.status} ${body.msg ?? body.message ?? ""}`);
  }
  return body;
};

/** a sign-in for this address (the user is made if new): the email's code and link, nothing sent */
export const signInLink = async (email, redirectTo) => {
  const body = await admin("generate_link", { method: "POST", body: JSON.stringify({ type: "magiclink", email, ...(redirectTo ? { redirect_to: redirectTo } : {}) }) });
  return { code: body.email_otp ?? body.properties?.email_otp, link: body.action_link ?? body.properties?.action_link, id: body.id ?? body.user?.id };
};

/** delete the test users of a run (their addresses contain the run's tag) */
export const deleteUsers = async (tag) => {
  for (let page = 1; page < 20; page++) {
    const { users = [] } = await admin(`users?page=${page}&per_page=200`); // NOSONAR S9382: pages in order on purpose
    for (const user of users.filter((entry) => entry.email?.includes(tag))) {
      await admin(`users/${user.id}`, { method: "DELETE" }); // NOSONAR S9382: one at a time on purpose
    }
    if (users.length < 200) {
      return;
    }
  }
};

/** a REST call with the secret key (cleanup, checks) */
export const rest = async (path, init = {}) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SECRET_KEY, authorization: `Bearer ${SECRET_KEY}`, "content-type": "application/json", ...init.headers },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

/** a storage call with the secret key */
const storage = async (path, init = {}) => {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/${path}`, {
    ...init,
    headers: { apikey: SECRET_KEY, authorization: `Bearer ${SECRET_KEY}`, "content-type": "application/json", ...init.headers },
  });
  return res.json().catch(() => null);
};

/** delete the pictures of these scenes (storage objects go through the Storage API only) */
const deletePictures = async (sceneIds) => {
  for (const id of sceneIds) {
    const objects = (await storage("object/list/kurviq-files", { method: "POST", body: JSON.stringify({ prefix: `${id}/`, limit: 1000 }) })) ?? []; // NOSONAR S9382: one scene at a time on purpose
    const names = Array.isArray(objects) ? objects.map((object) => `${id}/${object.name}`) : [];
    if (names.length) {
      await storage("object/kurviq-files", { method: "DELETE", body: JSON.stringify({ prefixes: names }) }); // NOSONAR S9382: one scene at a time on purpose
    }
  }
};

const sceneIdsLike = async (pattern) => {
  const { body } = await rest(`kurviq_scenes?select=id&name=like.${encodeURIComponent(pattern)}`);
  return Array.isArray(body) ? body.map((row) => row.id) : [];
};

/** remove a run's rows: its scenes (by name tag) with their pictures, and its members */
export const cleanup = async (tag) => {
  await deletePictures(await sceneIdsLike(`*${tag}*`));
  runSql(`
    delete from public.kurviq_scenes where name like '%${tag}%';
    delete from public.kurviq_members where email like '%${tag}%';
  `);
};

/** reset the space to a fresh one (no owner): only for a run that has the test project to itself */
export const resetSpace = async () => {
  await deletePictures(await sceneIdsLike("*"));
  runSql(`
    delete from public.kurviq_scenes;
    delete from public.kurviq_members;
    update public.kurviq_space set name = 'Team space', settings = '{}' where id = 1;
  `);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "apply") {
    applySchema();
    console.log("schema applied");
  }
}
