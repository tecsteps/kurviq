// The homes' live sessions, wired once by the app (index.tsx) when the editor
// is there. Kept apart from ./drive.ts: the pen imports the controller,
// which imports the homes.

import { pen } from "../online/pen";

import { databaseLive } from "./database/live";
import { driveHome } from "./drive";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

driveHome.live = pen;

/** every home with a live session follows the editor's open scene (the databases' one session: the open database scene) */
export const attachLiveSessions = (api: ExcalidrawImperativeAPI) => {
  for (const live of [driveHome.live, databaseLive]) {
    live?.attach(api);
  }
};
