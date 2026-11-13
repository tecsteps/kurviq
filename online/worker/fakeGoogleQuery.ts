// The fake Google's files.list query language (./fakeGoogle.ts): only the
// terms Kurviq sends, joined by "and". Anything else is refused with a clear
// error instead of being answered with behaviour nobody compared with Google.
//
//   '<id>' in parents            (also 'root': the caller's My Drive)
//   trashed = true|false, trashed != …
//   name = '…', mimeType = '…' (and !=)
//   sharedWithMe                 (files the caller doesn't own)
//   not 'me' in owners           (the same here)
//   appProperties has { key='k' and value='v' }

/** the file columns a query reads */
export type QueryFile = { parents: string; trashed: number; name: string; mime: string; owner: string; app_props: string };
/** who asks: their email and their My Drive's id */
export type QueryCaller = { email: string; root: string };
export type Predicate = (file: QueryFile, me: QueryCaller) => boolean;

/** a quoted value: '…' (with \\' escapes, as Drive wants them) */
const QUOTED = String.raw`'((?:[^'\\]|\\.)*)'`;
const unquote = (text: string) => text.replaceAll(/\\(.)/g, "$1");

const TERMS: Array<[RegExp, (match: RegExpExecArray) => Predicate]> = [
  [
    new RegExp(String.raw`^${QUOTED}\s+in\s+parents$`),
    (m) => {
      const id = unquote(m[1]);
      return (file, me) => {
        const parents: string[] = JSON.parse(file.parents);
        return parents.includes(id) || (id === "root" && parents.includes(me.root));
      };
    },
  ],
  [/^trashed\s*(=|!=)\s*(true|false)$/, (m) => (file) => (!!file.trashed === (m[2] === "true")) === (m[1] === "=")],
  [
    new RegExp(String.raw`^(name|mimeType)\s*(=|!=)\s*${QUOTED}$`),
    (m) => {
      const column = m[1] === "name" ? "name" : "mime";
      const value = unquote(m[3]);
      return (file) => (file[column] === value) === (m[2] === "=");
    },
  ],
  [/^sharedWithMe$/, () => (file, me) => file.owner !== me.email],
  [/^not\s+'me'\s+in\s+owners$/, () => (file, me) => file.owner !== me.email],
  [
    new RegExp(String.raw`^appProperties\s+has\s*\{\s*key\s*=\s*${QUOTED}\s+and\s+value\s*=\s*${QUOTED}\s*\}$`),
    (m) => {
      const [key, value] = [unquote(m[1]), unquote(m[2])];
      return (file) => JSON.parse(file.app_props || "{}")[key] === value;
    },
  ],
];

/** the terms of q, split at "and" outside quotes and braces */
export const splitTerms = (text: string) => {
  const terms: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (quoted && char === "\\") {
      // escapes the next character
      at++;
    } else if (quoted) {
      quoted = char !== "'";
    } else if (char === "'") {
      quoted = true;
    } else if (char === "{" || char === "}") {
      depth += char === "{" ? 1 : -1;
    } else if (depth === 0 && /^\sand\s/i.test(text.slice(at, at + 5))) {
      terms.push(text.slice(start, at).trim());
      start = at + 5;
      at += 3;
    }
  }
  terms.push(text.slice(start).trim());
  return terms;
};

/** q as a predicate; a term the fake doesn't know throws (answered with 400) */
export const parseQuery = (text: string): Predicate => {
  const predicates = splitTerms(text).map((term) => {
    for (const [pattern, make] of TERMS) {
      const match = pattern.exec(term);
      if (match) {
        return make(match);
      }
    }
    throw new Error(`"${term}" is not supported by the fake Google (online/worker/fakeGoogleQuery.ts lists what is)`);
  });
  return (file, me) => predicates.every((predicate) => predicate(file, me));
};
