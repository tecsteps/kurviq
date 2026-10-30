interface ImportMetaEnv {
  /** injected by scenes-plugin/vite.config.mts from SCENES_SERVER_URL */
  VITE_APP_SCENES_SERVER_URL: string;
  /** where Google sign-in lives: "" online (this site), kurviq.com for the local install (KURVIQ_AUTH_URL) */
  VITE_APP_KURVIQ_AUTH_URL: string;
  /** "local" (the install on this machine) or "online" (kurviq.com) */
  VITE_APP_SCENES_TARGET: string;
  /** online: the commit the build is made from */
  VITE_APP_KURVIQ_BUILD: string;
}

declare module "*.woff2" {
  const url: string;
  export default url;
}
