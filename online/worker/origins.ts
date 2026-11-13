// Which addresses count as "this machine". Two different questions, kept
// apart on purpose:
//
//   isDevOrigin     a development server (wrangler dev, the fake Google, test
//                   hooks): loopback only. Gates what must never run on
//                   kurviq.com.
//   isLocalInstall  the user's local Kurviq (it signs in through kurviq.com):
//                   loopback, or a *.test name (Laravel Herd, e.g.
//                   http://draw.test). A security boundary for sessions:
//                   *.test is not loopback (see auth.ts, the sign-in asks
//                   before it hands a session to one).

/** the host name of an http(s) address, or null */
const hostOf = (origin: string | null | undefined) => {
  if (!origin) {
    return null;
  }
  try {
    const url = new URL(origin);
    return url.protocol === "http:" || url.protocol === "https:" ? url.hostname : null;
  } catch {
    return null;
  }
};

/** localhost, 127.0.0.1, [::1] and *.localhost (which browsers resolve to loopback themselves) */
const isLoopbackHost = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");

/** a development server on this machine (loopback only) */
export const isDevOrigin = (origin: string | null | undefined) => {
  const host = hostOf(origin);
  return host !== null && isLoopbackHost(host);
};

/** the user's local install: loopback or *.test, any port, http or https */
export const isLocalInstall = (origin: string | null | undefined) => {
  const host = hostOf(origin);
  return host !== null && (isLoopbackHost(host) || host.endsWith(".test"));
};
