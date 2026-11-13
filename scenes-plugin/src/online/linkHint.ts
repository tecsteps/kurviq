// A scene link (kurviq.com/<name>) that created a new scene may have meant
// one shared with the user that Kurviq can't see yet: Drive shows Kurviq a
// shared file only once it was opened with Kurviq. The hint (LinkHint in
// ui.tsx) offers the Picker, searched for that name, where the scene or the
// shared folder it is in can be picked (nothing about it is kept on Kurviq's
// server). Its own module: the router sets it, the UI shows it.

import { createStore } from "../externalStore";

import { connection, pickerAvailable, sharedFileId } from "./drive";

/** the scene name the hint is about (null: no hint) */
export const linkHint = createStore<string | null>(null);

/** after a scene link created a new scene (router.ts): offer to look for it among the scenes shared with the user */
export const offerSharedLookup = (scene: string) => {
  if (connection.isActive() && pickerAvailable() && !sharedFileId) {
    linkHint.set(scene);
  }
};
