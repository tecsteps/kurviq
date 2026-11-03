import { serializeAsJSON as serialize } from "@excalidraw/excalidraw";

export { presentationOf, editedPresentation, presentationEdit, presentationChange, restorePresentation } from "../../scenes-mcp/presentation.mjs";
import { presentationOf } from "../../scenes-mcp/presentation.mjs";

/** Excalidraw filters unknown app state fields during serialization. */
export const serializeAsJSON: typeof serialize = (elements, appState, files, source) => {
  const data = JSON.parse(serialize(elements, appState, files, source));
  data.appState.kurviqPresentation = presentationOf({ elements, appState });
  data.appState.kurviqPresentationAt = (appState as any).kurviqPresentationAt ?? 0;
  return JSON.stringify(data);
};
