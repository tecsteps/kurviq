// The relay, server side: an end-to-end test against `wrangler dev` with the
// fake Google (docs/relay/CONCEPT.md). Plain Node ≥ 22 (global fetch,
// WebSocket, WebCrypto); it plays the tabs itself.
//
//   cd online && KURVIQ_FAKE_GOOGLE=1 KURVIQ_DEV_PORT=8790 node dev-vars.mjs && node build-worker.mjs \
//     && npx wrangler dev --port 8790
//   BASE=http://localhost:8790 node online/test/relay-server.mjs
//
// What it checks: the ticket's role comes from Drive (edit / comment / read;
// no access 403; a Google rate limit is "try again", never "no access"),
// only an editor makes the scene's key (and it lands on the Drive file), the
// relay takes only valid tickets, exactly one of two claims wins, payloads
// pass unread to the right tabs, commenters' operations reach the holder
// with who they are, the holder leaving frees the pen at once, and the
// drain of the retired live sync answers without anything to drain.

const B = process.env.BASE || "http://localhost:8790";
const F = `${B}/fake-google`;
const WS = B.replace(/^http/, "ws");
const RUN = Date.now() % 100000;
let failures = 0;
let passes = 0;
const clean = (value) => String(value).replaceAll(/\p{Cc}/gu, " ");
const ok = (cond, what, extra) => {
  const shown = () => (typeof extra === "string" ? extra : JSON.stringify(extra).slice(0, 600));
  const detail = cond || extra === undefined ? "" : ` -> ${clean(shown())}`;
  console.log(`${cond ? "PASS" : "FAIL"} ${what}${detail}`);
  if (cond) passes++;
  else failures++;
};
const admin = async (path, body, method = body ? "POST" : "GET") =>
  (await fetch(`${F}/admin${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).json(); // NOSONAR S7044 S8476: test client of the local dev server (BASE), paths are the test's own

/** a sign-in through /auth/login with the fake OAuth: the cookie jar */
const login = async (email) => {
  const jar = {};
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  const take = (res) => {
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      if (/Max-Age=0/.test(c)) delete jar[kv.slice(0, i)];
      else jar[kv.slice(0, i)] = kv.slice(i + 1);
    }
  };
  let res = await fetch(`${B}/auth/login?return=/`, { redirect: "manual" });
  take(res);
  let loc = res.headers.get("Location");
  for (let i = 0; i < 8 && loc; i++) {
    const u = new URL(loc, B);
    if (u.pathname.endsWith("/oauth/authorize")) {
      u.pathname = u.pathname.replace("authorize", "approve");
      u.searchParams.set("email", email);
    }
    res = await fetch(u, { redirect: "manual", headers: { Cookie: cookie() } }); // NOSONAR S9382: the OAuth redirects in order
    take(res);
    loc = res.headers.get("Location");
    if (u.pathname === "/auth/callback" && loc && !new URL(loc, B).pathname.includes("authorize")) break;
  }
  return { email, cookie };
};

const post = async (user, path, body = {}) => {
  const res = await fetch(`${B}${path}`, { // NOSONAR S7044 S8476: test client of the local dev server (BASE), paths are the test's own
    method: "POST",
    headers: { Origin: B, Cookie: user.cookie(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};

/** a tab at the relay: its messages in `inbox`, `next(test)` waits for one */
const connect = async (fileId, ticket) => {
  const ws = new WebSocket(`${WS}/relay/${fileId}/live?ticket=${encodeURIComponent(ticket)}`, { headers: { Origin: B } }); // NOSONAR S8480: connects to the local dev server (BASE) with a ticket it issued
  const inbox = [];
  const waiters = [];
  let closed = false;
  ws.addEventListener("message", (event) => {
    inbox.push(JSON.parse(String(event.data)));
    waiters.splice(0).forEach((wake) => wake());
  });
  ws.addEventListener("close", () => {
    closed = true;
    waiters.splice(0).forEach((wake) => wake());
  });
  const opened = await new Promise((resolve) => {
    ws.addEventListener("open", () => resolve(true), { once: true });
    ws.addEventListener("error", () => resolve(false), { once: true });
  });
  const next = async (test, ms = 5000) => {
    const end = Date.now() + ms;
    for (;;) {
      const i = inbox.findIndex((message) => test(message));
      if (i >= 0) return inbox.splice(i, 1)[0];
      if (closed || Date.now() > end) return null;
      await new Promise((resolve) => { // NOSONAR S9382: waits for the next message in order on purpose
        waiters.push(resolve);
        setTimeout(resolve, 200);
      });
    }
  };
  return { ws, opened, next, send: (msg) => ws.send(JSON.stringify(msg)), isClosed: () => closed };
};

const [owner, editor, commenter, reader, stranger] = await Promise.all(["rown", "redi", "rcom", "rrea", "rstr"].map((who) => login(`${who}${RUN}@example.test`)));
const file = await admin("/write", { email: owner.email, name: `relay-${RUN}.excalidraw`, content: JSON.stringify({ type: "excalidraw", elements: [] }) });
const fileId = file.id ?? file.file?.id;
ok(!!fileId, "a scene file in the fake Drive", file);
for (const [user, role] of [[editor, "writer"], [commenter, "commenter"], [reader, "reader"]]) {
  await admin("/share", { fileId, email: user.email, role }); // NOSONAR S9382: setup in order
}
for (const user of [owner, editor, commenter, reader, stranger]) {
  await admin("/grant", { fileId, email: user.email }); // NOSONAR S9382: setup in order
}

// --- tickets: Drive decides ---------------------------------------------------
const tickets = {};
for (const [name, user] of Object.entries({ owner, editor, commenter, reader })) {
  tickets[name] = await post(user, `/relay/${fileId}/ticket`); // NOSONAR S9382: in order on purpose
}
ok(tickets.owner.status === 200 && tickets.owner.data.role === "edit", "the owner's ticket: edit", tickets.owner);
ok(tickets.editor.data?.role === "edit", "a writer's ticket: edit");
ok(tickets.commenter.data?.role === "comment", "a commenter's ticket: comment");
ok(tickets.reader.data?.role === "read", "a reader's ticket: read");
ok(tickets.owner.data.key === null, "no key yet: a ticket alone writes nothing to the file");
ok((await post(stranger, `/relay/${fileId}/ticket`)).status === 403, "no access: 403");
await admin("/faults", { status: 429, path: fileId, count: 1 });
const limited = await post(reader, `/relay/${fileId}/ticket`);
ok(limited.status === 503 && limited.data?.code === "google-unreachable", "a Google rate limit is 'try again' (503), never 'no access'", limited);
await admin("/faults", undefined, "DELETE");
const readerKey = await post(reader, `/relay/${fileId}/ticket`, { createKey: true });
ok(readerKey.data?.key === null, "a reader can't make the scene's key");
const made = await post(editor, `/relay/${fileId}/ticket`, { createKey: true });
ok(typeof made.data?.key === "string" && typeof made.data?.keyId === "string", "an editor (the holder) makes the scene's key", made.data);
const meta = await admin(`/file?fileId=${fileId}`);
ok(String((meta.file ?? meta).appProperties?.kurviqKey ?? "").startsWith(made.data.keyId), "the key is on the Drive file", (meta.file ?? meta).appProperties);
const again = await post(reader, `/relay/${fileId}/ticket`);
ok(again.data?.key === made.data.key, "everyone who may read the file gets the same key");
ok((await post(owner, `/relay/${fileId}/ticket`, {})).data?.color === tickets.owner.data.color, "the same person keeps the same color");

// --- the relay ----------------------------------------------------------------
const forged = await connect(fileId, "not-a-ticket");
ok(!forged.opened || forged.isClosed(), "a forged ticket opens nothing");
const other = await connect("x".repeat(20), tickets.owner.data.ticket);
ok(!other.opened || other.isClosed(), "a ticket of another file opens nothing");

const fresh = async (user) => (await post(user, `/relay/${fileId}/ticket`)).data.ticket;
const a = await connect(fileId, await fresh(owner));
const b = await connect(fileId, await fresh(editor));
const c = await connect(fileId, await fresh(commenter));
const r = await connect(fileId, await fresh(reader));
const ids = {};
for (const [name, tab] of Object.entries({ a, b, c, r })) {
  ids[name] = (await tab.next((m) => m.t === "welcome"))?.you; // NOSONAR S9382: in order on purpose
}
ok(Object.values(ids).every(Boolean), "every tab is welcomed", ids);
a.send({ t: "claim" });
b.send({ t: "claim" });
const refused = await b.next((m) => m.t === "refused");
const state = await r.next((m) => m.t === "state" && m.holder);
ok(refused?.why === "held" && state?.holder?.id === ids.a, "two claims at once: exactly one gets the pen", { refused, holder: state?.holder });
r.send({ t: "claim" });
ok((await r.next((m) => m.t === "refused"))?.why === "not-editor", "a reader can't take the pen");

a.send({ t: "send", kind: "change", body: "opaque-cipher" });
const got = await Promise.all([b, c, r].map((tab) => tab.next((m) => m.t === "msg" && m.kind === "change")));
ok(got.every((m) => m?.body === "opaque-cipher" && m.from.id === ids.a), "the holder's changes reach every other tab, unread", got);
b.send({ t: "send", kind: "change", body: "x" });
ok((await b.next((m) => m.t === "refused"))?.why === "not-holder", "only the holder sends scene changes");

c.send({ t: "send", kind: "ops", body: "comment-cipher", req: "q1" });
const ops = await a.next((m) => m.t === "msg" && m.kind === "ops");
ok(ops?.from?.role === "comment" && ops.from.email === commenter.email && typeof ops.from.key === "string", "a commenter's operations reach the holder with who they are (from the ticket)", ops?.from);
a.send({ t: "send", kind: "result", to: ids.c, body: "ok", req: "q1" });
ok((await c.next((m) => m.t === "msg" && m.kind === "result"))?.req === "q1", "the holder's answer goes back to the commenter");
r.send({ t: "send", kind: "ops", body: "x" });
ok((await r.next((m) => m.t === "refused"))?.why === "not-commenter", "a reader sends no comment operations");

b.send({ t: "ask" });
ok((await a.next((m) => m.t === "asked"))?.by?.id === ids.b, "ask: the holder hears who asks");
a.send({ t: "handover", to: ids.b });
ok((await b.next((m) => m.t === "granted")) !== null, "hand over: the asker gets the pen");

b.ws.close();
const freed = await a.next((m) => m.t === "state" && m.holder === null);
ok(freed !== null, "the holder's tab closing frees the pen at once");

c.send({ t: "send", kind: "ops", body: "x", req: "q2" });
ok((await c.next((m) => m.t === "no-editor"))?.req === "q2", "no holder: the commenter hears it at once (the mailbox takes over)");

for (const tab of [a, c, r]) tab.ws.close();

// --- the drain of the retired live sync ---------------------------------------
const drained = await post(owner, "/live/drain");
ok(drained.status === 200 && Array.isArray(drained.data?.results), "the drain answers (nothing of this account to drain)", drained);
ok((await fetch(`${B}/live/drain`, { method: "POST", headers: { Origin: B } })).status === 401, "the drain needs a sign-in");
const notify = await fetch(`${B}/drive/notify`, { method: "POST" });
ok(notify.status === 200, "Drive's old watch notifications are answered and ignored");

console.log(`\n${passes} passed, ${failures} failed`);
process.exitCode = failures ? 1 : 0;
