// Refuses a deploy of an app built for the fake Google (npm run
// build:online:fake): its Drive calls would go to kurviq.com/fake-google,
// where nothing answers. Both builds write to the same dist/app, and
// `npm run deploy` rebuilds only the Worker, so the app on disk is checked.
import { existsSync, readFileSync } from "node:fs";

import { APP_BUILD_INFO } from "./build-info.mjs";

if (!existsSync(APP_BUILD_INFO)) {
  console.error("[deploy] no app build found: run `npm run build:online` in the repo root first");
  process.exit(1);
}
const info = JSON.parse(readFileSync(APP_BUILD_INFO, "utf8"));
if (info.fakeGoogle) {
  console.error("[deploy] the app in dist/app was built for the fake Google: run `npm run build:online` (without KURVIQ_FAKE_GOOGLE) first");
  process.exit(1);
}
