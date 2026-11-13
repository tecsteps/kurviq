// Following the canvas without polling: work that depends on where things are
// on screen (names next to slides, veils over hidden slides) runs after each
// change of the editor for a few frames, then not at all.

/** what this needs of the editor's API */
export type FollowedEditor = {
  onChange: (callback: () => void) => () => void;
  onScrollChange: (callback: () => void) => () => void;
};

/** frames after a change (Excalidraw lays out frame names a frame or two later) */
export const FOLLOW_FRAMES = 5;

/**
 * Runs `step` on animation frames only while the canvas may move: after each
 * change of the editor (camera, elements, view mode, renaming) for `frames`
 * frames, then not at all. Waits for the editor if it isn't there yet.
 * Returns the stop function (an effect's cleanup).
 */
export const followEditor = (getApi: () => FollowedEditor | null | undefined, step: () => void, frames = FOLLOW_FRAMES) => {
  let frame = 0;
  let left = 0;
  let waiting = 0;
  const unsubscribe: (() => void)[] = [];
  const tick = () => {
    frame = 0;
    step();
    left -= 1;
    if (left > 0) {
      frame = requestAnimationFrame(tick);
    }
  };
  const wake = () => {
    left = frames;
    if (!frame) {
      frame = requestAnimationFrame(tick);
    }
  };
  const attach = () => {
    const api = getApi();
    if (!api) {
      waiting = globalThis.setTimeout(attach, 250) as unknown as number;
      return;
    }
    unsubscribe.push(api.onChange(wake), api.onScrollChange(wake));
    wake();
  };
  attach();
  return () => {
    globalThis.clearTimeout(waiting);
    unsubscribe.forEach((off) => off());
    if (frame) {
      cancelAnimationFrame(frame);
    }
  };
};
