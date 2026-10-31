interface ImportMetaEnv {
  /** injected by scenes-plugin/vite.config.mts from SCENES_SERVER_URL */
  VITE_APP_SCENES_SERVER_URL: string;
  /** where Google sign-in lives: "" online (this site), kurviq.com for the local install (KURVIQ_AUTH_URL) */
  VITE_APP_KURVIQ_AUTH_URL: string;
  /** "local" (the install on this machine) or "online" (kurviq.com) */
  VITE_APP_SCENES_TARGET: string;
  /** online: the commit the build is made from */
  VITE_APP_KURVIQ_BUILD: string;
  /** "/fake-google" in a dev build for the fake Google (KURVIQ_FAKE_GOOGLE=1), else "" (real Google) */
  VITE_APP_GOOGLE_API_BASE: string;
}

declare module "*.woff2" {
  const url: string;
  export default url;
}
