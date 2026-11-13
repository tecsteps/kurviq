# Scene text searchable in Google Drive

Status: implemented (Must), 2026-11-13; Drive's search not yet checked with real Google (criterion 4)

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

## Implementation

- `scenes-plugin/src/online/indexText.ts` (`sceneIndexText`): the scene's
  name, then every distinct text of the scene in element order, one per line:
  text elements and labels (`originalText`, the plain text of formatted text
  too), frame (slide) titles. Left out: deleted elements, labels of deleted
  shapes, comments, speaker notes, tooltips. Cut at 128 KB (UTF-8 bytes) at a
  word boundary.
- Sent as `contentHints.indexableText` with every save
  (`online/contentHints.ts`, see the thumbnail spec), together with the
  preview.

## Checks

- Unit: the text is built from elements (formatted text, labels, deleted
  elements left out), cut at the limit.
- In Drive: a word from a scene finds it in Drive's search.

## Open

- Speaker notes: decided to leave them out (2026-11-13). They can hold
  private remarks, and a file's indexed words are searchable by everyone it is
  shared with. Revisit if users ask to find decks by their notes.

## Acceptance criteria

1. After a save, the file's `contentHints.indexableText` contains the scene name and the words of every text
   element and label (formatted text as plain text), and slide titles; deleted elements' words are not in it.
2. Comments and (unless decided otherwise) speaker notes are not in it.
3. A scene with more than 128 KB of text saves; the index text is cut at a word boundary, at most 128 KB.
4. In Drive's search (real Google) a word that only occurs inside a scene finds that scene.
5. Agent edits update it the same way; local-only scenes never send it.
