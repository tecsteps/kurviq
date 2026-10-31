// Google's endpoints. Real Google by default; `wrangler dev` with
// FAKE_GOOGLE=1 points them at the fake Google of worker/fakeGoogle.ts
// (/fake-google/…) for local tests with several test accounts.

export type GoogleEnv = {
  /** "1": use the fake Google (dev only) */
  FAKE_GOOGLE?: string;
  DEV_ORIGIN?: string;
};

const fake = (env: GoogleEnv, origin: string) => `${env.DEV_ORIGIN || origin}/fake-google`;

/** a local address (the fake Google is only ever reached on one; never on kurviq.com, whatever the env says) */
const isLocal = (origin: string | undefined) => {
  try {
    const { hostname } = new URL(origin || "");
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".localhost");
  } catch {
    return false;
  }
};

export const googleUrls = (env: GoogleEnv, origin = "http://localhost:8787") =>
  env.FAKE_GOOGLE === "1" && isLocal(env.DEV_ORIGIN)
    ? {
        authorize: `${fake(env, origin)}/oauth/authorize`,
        token: `${fake(env, origin)}/oauth/token`,
        revoke: `${fake(env, origin)}/oauth/revoke`,
        api: `${fake(env, origin)}/drive/v3`,
        upload: `${fake(env, origin)}/upload/drive/v3`,
      }
    : {
        authorize: "https://accounts.google.com/o/oauth2/v2/auth",
        token: "https://oauth2.googleapis.com/token",
        revoke: "https://oauth2.googleapis.com/revoke",
        api: "https://www.googleapis.com/drive/v3",
        upload: "https://www.googleapis.com/upload/drive/v3",
      };
