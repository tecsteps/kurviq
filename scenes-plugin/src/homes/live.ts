// The homes' live sessions, wired once by the app (index.tsx) when the editor
// is there. Kept apart from ./drive.ts: the pen imports the controller,
// which imports the homes.

import { pen } from "../online/pen";

import { driveHome } from "./drive";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

driveHome.live = pen;

/** every home with a live session follows the editor's open scene */
export const attachLiveSessions = (api: ExcalidrawImperativeAPI) => {
  for (const home of [driveHome]) {
    home.live?.attach(api);
  }
};
