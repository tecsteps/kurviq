// A mouse wheel zooms the canvas; a trackpad's two-finger scroll keeps
// panning. Excalidraw does this only when its "Input device" preference
// (main menu → Preferences) is set to Mouse; its default ("auto") treats every
// wheel like a trackpad. While the preference is left on auto, Kurviq tells
// the two apart per event and hands a mouse wheel to Excalidraw as a zoom
// (the ctrl+wheel it already zooms with). A preference set by the user wins.

type WheelLike = Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode"> & { wheelDeltaY?: number };

const LINE_PX = 40;
const PAGE_PX = 800;

/**
 * A wheel event from a mouse wheel (notches), not from a trackpad. Lines or
 * pages (Firefox's mouse wheel) are a mouse; Chrome and Safari also report
 * the old wheelDeltaY: a trackpad's is exactly -3 × deltaY, a wheel's comes
 * in notches of 120. Anything unclear counts as a trackpad (it pans, as
 * before).
 */
export const isMouseWheel = (event: WheelLike) => {
  if (event.deltaMode === 1 || event.deltaMode === 2) {
    return event.deltaX === 0;
  }
  const legacy = event.wheelDeltaY;
  if (!legacy || event.deltaX !== 0) {
    return false;
  }
  return legacy % 120 === 0 && legacy !== -3 * event.deltaY;
};

/** the vertical distance in pixels (Excalidraw's zoom works in pixels) */
export const deltaPixels = (event: Pick<WheelEvent, "deltaY" | "deltaMode">) => {
  if (event.deltaMode === 1) return event.deltaY * LINE_PX;
  if (event.deltaMode === 2) return event.deltaY * PAGE_PX;
  return event.deltaY;
};

/** installs the listener once; `inputDevice` reads the editor's preference (null: no editor yet) */
export const installWheelZoom = (inputDevice: () => string | null) => {
  if (typeof window === "undefined") {
    return;
  }
  window.addEventListener(
    "wheel",
    (event) => {
      const target = event.target as Element | null;
      if (
        !event.isTrusted ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey ||
        target?.tagName !== "CANVAS" ||
        !target.closest(".excalidraw") ||
        inputDevice() !== "auto" ||
        !isMouseWheel(event as WheelLike)
      ) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      target.dispatchEvent(
        new WheelEvent("wheel", {
          deltaX: 0,
          deltaY: deltaPixels(event),
          deltaMode: 0,
          clientX: event.clientX,
          clientY: event.clientY,
          screenX: event.screenX,
          screenY: event.screenY,
          buttons: event.buttons,
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    { capture: true, passive: false },
  );
};
