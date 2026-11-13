# Scene text searchable in Google Drive

Status: proposal (Must), 2026-11-13

## Why

Drive's search finds a scene only by its file name. With its words indexed,
"Q3 roadmap" finds the scene that says it.

## How

- Drive takes text to index with a file's metadata:
  `contentHints.indexableText`, at most 128 KB. Google keeps it with the file;
  Kurviq stores nothing.
- What goes in: the scene's name, the plain text of all text elements (formatted
  text as plain text, labels included), slide titles. Not comments (they are
  conversation, not content) and not speaker notes (to decide: they can hold
  private remarks).
- Who sends it: the browser that saves (the pen holder, see the Drive spec), in
  the same upload as the content (`driveScenes.save`), next to `withFonts` /
  `withComments`. Agents' saves (`cowork.ts`) too.
- Cut at 128 KB (whole words).

## Checks

- Unit: the text is built from elements (formatted text, labels, deleted
  elements left out), cut at the limit.
- In Drive: a word from a scene finds it in Drive's search.

## Open

- Speaker notes in the index or not?
