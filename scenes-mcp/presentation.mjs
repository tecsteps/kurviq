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

/** Only an explicit option or a genuinely new template authors a presentation. */
export const presentationEdit = (command, appState, existing = []) => {
  const ids = new Set(existing.map((el) => el.id));
  const templateAdded = (command.add ?? []).some((el) =>
    !ids.has(el.id) && (el.type === "template" ||
      (el.type === "frame" && el.customData?.slides?.role === "template")));
  if (typeof command.isPresentation !== "boolean" && !templateAdded) {
    return null;
  }
  const value = typeof command.isPresentation === "boolean" ? command.isPresentation : true;
  return presentationChange(value, appState);
};

/** A click follows all observed writes even if this device's clock is behind. */
export const presentationChange = (on, appState, now = Date.now()) => ({
  kurviqPresentation: on,
  kurviqPresentationAt: Math.max(now, (appState?.kurviqPresentationAt ?? 0) + 1),
});

export const editedPresentation = (command, appState, existing = []) =>
  presentationEdit(command, appState, existing)?.kurviqPresentation ?? presentationOf({ appState });

/** A whole-scene save carries only presentation fields changed against its read. */
export const presentationSave = (wanted, base, current) => {
  if (!base || typeof wanted?.kurviqPresentation !== "boolean" ||
    (wanted.kurviqPresentation === base.kurviqPresentation &&
      (wanted.kurviqPresentationAt ?? 0) === (base.kurviqPresentationAt ?? 0))) {
    return mergePresentation(current, null);
  }
  return mergePresentation(current, wanted);
};
