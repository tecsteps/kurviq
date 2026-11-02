/** Resolve legacy files once when opening, never infer from frame count. */
export const presentationOf = (data) => {
  if (typeof data.appState?.kurviqPresentation === "boolean") {
    return data.appState.kurviqPresentation;
  }
  return (data.elements ?? []).some((el) => !el.isDeleted && el.type === "frame" &&
    (el.customData?.slides?.role === "template" || !!el.customData?.slides?.notes?.trim()));
};


/** Local snapshot conflicts use the time of the explicit setting change. */
export const mergePresentation = (mine, theirs) => {
  const latest = (theirs?.kurviqPresentationAt ?? 0) > (mine?.kurviqPresentationAt ?? 0) ? theirs : mine;
  return {
    kurviqPresentation: presentationOf({ appState: latest }),
    kurviqPresentationAt: latest?.kurviqPresentationAt ?? 0,
  };
};

/** Recover filtered browser app state, or prefer newer scene content. */
export const restorePresentation = (data, remembered) => {
  const content = data.appState;
  const hasRemembered = typeof remembered?.kurviqPresentation === "boolean";
  const missingContent = typeof content?.kurviqPresentation !== "boolean";
  if (hasRemembered && (missingContent || (remembered.kurviqPresentationAt ?? 0) > (content.kurviqPresentationAt ?? 0))) {
    return mergePresentation(remembered, null);
  }
  return {
    kurviqPresentation: presentationOf(data),
    kurviqPresentationAt: content?.kurviqPresentationAt ?? 0,
  };
};
