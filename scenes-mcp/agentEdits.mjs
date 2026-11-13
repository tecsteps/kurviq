// What an agent's edit is made of: the rules the MCP tools and the user's tab
// (which applies the edit) must agree on, in one place.

/** create_view pseudo elements: instructions, never drawn */
export const PSEUDO_TYPES = new Set(["cameraUpdate", "delete", "restoreCheckpoint"]);

export const isPlainObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);

/** an edit's requestId (sent again, the edit is never applied twice) */
export const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,80}$/;

/** the operations of an edit that change the scene (comments aside) */
const SCENE_OPERATIONS = ["add", "update", "delete", "restyle", "reset", "addTitleBlock", "isPresentation"];

/** an operation is set (isPresentation: false is one; an empty list is none) */
const isSet = (key, value) => {
  if (key === "isPresentation") {
    return typeof value === "boolean";
  }
  return Array.isArray(value) ? value.length > 0 : !!value;
};

/** the edit changes the scene itself (elements, deck or presentation flag), not only its comments */
export const changesScene = (edit) => SCENE_OPERATIONS.some((key) => isSet(key, edit?.[key]));

/** the edit only adds or changes comments (all a commenter may do) */
export const commentsOnly = (edit) => isSet("comments", edit?.comments) && !changesScene(edit);

/** the edit has nothing to do (upsert alone changes nothing) */
export const isEmptyEdit = (edit) => !changesScene(edit) && !isSet("comments", edit?.comments);
