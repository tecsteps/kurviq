// Live sync, server side: an end-to-end test against `wrangler dev` with the
// fake Google (docs/live-sync/PROTOCOL.md §8). Plain Node ≥ 22 (global fetch,
// WebSocket, WebCrypto); it plays the tabs itself (encrypting like
// scenes-plugin/src/online/liveCrypto.ts).
//
//   cd online && KURVIQ_FAKE_GOOGLE=1 KURVIQ_DEV_PORT=8789 node dev-vars.mjs && node build-worker.mjs \
//     && npx wrangler dev --port 8789 --persist-to /tmp/kurviq-live-b
//   BASE=http://localhost:8789 node online/test/live-server.mjs

import http from "node:http";

const B = process.env.BASE || "http://localhost:8789";
const F = `${B}/fake-google`;
const WS = B.replace(/^http/, "ws");
let failures = 0;
let passes = 0;
const ok = (cond, what, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${what}${cond || extra === undefined ? "" : ` -> ${typeof extra === "string" ? extra : JSON.stringify(extra).slice(0, 600)}`}`);
  cond ? passes++ : failures++;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const admin = async (path, body, method = body ? "POST" : "GET") =>
  (await fetch(`${F}/admin${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).json();

// -----------------------------------------------------------------------------
// sign-in through /auth/login with the fake OAuth
// -----------------------------------------------------------------------------

/** a sign-in; tried again if the fake OAuth round trip left no session (seen once in many runs) */
const login = async (email) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const user = await loginOnce(email);
    if (user.token) return user;
    console.log(`      (sign-in of ${email} gave no session, trying again)`);
  }
  return loginOnce(email);
};

const loginOnce = async (email) => {
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
    res = await fetch(u, { redirect: "manual", headers: { Cookie: cookie() } });
    take(res);
    loc = res.headers.get("Location");
    if (u.pathname === "/auth/callback" && loc && !new URL(loc, B).pathname.includes("authorize")) break;
  }
  const token = await (await fetch(`${B}/auth/token`, { method: "POST", headers: { Origin: B, Cookie: cookie() } })).json();
  return { email, token: token.token, cookie, jar };
};

const post = async (user, path, body = {}) => {
  const res = await fetch(`${B}${path}`, {
    method: "POST",
    headers: { Origin: B, Cookie: user.cookie(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};

const drive = async (token, path, init = {}) => {
  const res = await fetch(path.startsWith("http") ? path : `${F}/drive/v3${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.json ? { "Content-Type": "application/json" } : {}), ...(init.headers || {}) },
    body: init.json ? JSON.stringify(init.json) : init.body,
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: res.status, data, text };
};

// -----------------------------------------------------------------------------
// the tab's crypto (as liveCrypto.ts)
// -----------------------------------------------------------------------------

const enc = new TextEncoder();
const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const importKey = async (key64) => crypto.subtle.importKey("raw", Buffer.from(key64, "base64"), "AES-GCM", false, ["encrypt", "decrypt"]);
/** the additional data binds file, kind, id and key (liveProtocol aadOf); the kind follows from the id unless given */
const kindOf = (id) => (id === "settings" ? "set" : id === "name" ? "name" : "el");
const encrypt = async (scene, id, value, k = kindOf(id)) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(`${scene.fileId}:${k}:${id}:${scene.keyId}`) }, scene.key, enc.encode(JSON.stringify(value))),
  );
  return b64(Buffer.concat([iv, cipher]));
};
const decrypt = async (scene, id, c, k = kindOf(id)) => {
  const bytes = Buffer.from(c, "base64");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: enc.encode(`${scene.fileId}:${k}:${id}:${scene.keyId}`) },
    scene.key,
    bytes.subarray(12),
  );
  return JSON.parse(new TextDecoder().decode(plain));
};
const readableOf = (el) => ({
  id: el.id,
  type: el.type,
  version: el.version,
  versionNonce: el.versionNonce,
  isDeleted: !!el.isDeleted,
  index: el.index ?? null,
  boundIds: (el.boundElements || []).map((b) => b.id),
  containerId: el.containerId ?? null,
  startId: el.startBinding?.elementId ?? null,
  endId: el.endBinding?.elementId ?? null,
  frameId: el.frameId ?? null,
  groupIds: el.groupIds || [],
  fileId: el.fileId ?? null,
  fontFamily: typeof el.fontFamily === "number" ? el.fontFamily : null,
});
const contentOf = ({ id, version, versionNonce, isDeleted, index, ...rest }) => rest;
const elEvent = async (scene, el, base) => ({ k: "el", id: el.id, base, r: readableOf(el), c: await encrypt(scene, el.id, contentOf(el)) });

const rect = (id, index, extra = {}) => ({
  id,
  type: "rectangle",
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  angle: 0,
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 2,
  roughness: 1,
  opacity: 100,
  groupIds: [],
  frameId: null,
  index,
  roundness: null,
  seed: 1,
  version: 1,
  versionNonce: 1,
  isDeleted: false,
  boundElements: null,
  updated: 1,
  link: null,
  locked: false,
  ...extra,
});

// -----------------------------------------------------------------------------
// a tab: WebSocket + frames (frames.ts) + message queue
// -----------------------------------------------------------------------------

const PART = 256 * 1024;
const openTab = async (user, fileId, ticketAnswer, tabId) => {
  const ws = new WebSocket(`${WS}/scene/${fileId}/live?ticket=${encodeURIComponent(ticketAnswer.ticket)}`, { headers: { Origin: B } });
  const inbox = [];
  const waiters = [];
  const parts = new Map();
  let closed = null;
  ws.addEventListener("message", (event) => {
    let message = JSON.parse(String(event.data));
    if (message.type === "part") {
      const entry = parts.get(message.id) ?? [];
      entry[message.i] = message.data;
      parts.set(message.id, entry);
      if (entry.filter((x) => x !== undefined).length < message.total) return;
      parts.delete(message.id);
      message = JSON.parse(entry.join(""));
    }
    inbox.push(message);
    waiters.splice(0).forEach((wake) => wake());
  });
  ws.addEventListener("close", (event) => {
    closed = { code: event.code, reason: event.reason };
    waiters.splice(0).forEach((wake) => wake());
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("WebSocket failed")), { once: true });
  });
  const send = (message) => {
    const text = JSON.stringify(message);
    if (text.length <= PART) return ws.send(text);
    const id = Math.random().toString(36).slice(2, 12);
    const total = Math.ceil(text.length / PART);
    for (let i = 0; i < total; i++) ws.send(JSON.stringify({ type: "part", id, i, total, data: text.slice(i * PART, (i + 1) * PART) }));
  };
  /** the next message matching `test` (taken out of the inbox) */
  const next = async (test, ms = 8000) => {
    const until = Date.now() + ms;
    for (;;) {
      const at = inbox.findIndex(test);
      if (at >= 0) return inbox.splice(at, 1)[0];
      if (closed || Date.now() > until) return null;
      await new Promise((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, Math.max(0, until - Date.now()));
      });
    }
  };
  const tab = { user, ws, inbox, send, next, tab: tabId, get closed() { return closed; }, counter: 0, ticket: ticketAnswer };
  tab.scene = ticketAnswer.key ? { key: await importKey(ticketAnswer.key), keyId: ticketAnswer.keyId, fileId } : null;
  return tab;
};

const hello = async (tab, { seq = 0, generation = null, revision = null } = {}) => {
  tab.send({ type: "hello", protocol: 1, tab: tab.tab, openToken: `open-${tab.tab}`, revision, seq, generation });
  return tab.next((m) => m.type === "welcome");
};

const batch = async (tab, events, extra = {}) => {
  const counter = extra.counter ?? ++tab.counter;
  tab.send({ type: "batch", counter, live: true, made: Date.now(), via: "user", events, ...extra, counter });
  return tab.next((m) => (m.type === "ack" || m.type === "refused") && m.counter === counter);
};

const ticketFor = async (user, fileId) => post(user, `/scene/${fileId}/ticket`);

const fileContent = async (token, fileId) => JSON.parse((await drive(token, `/files/${fileId}?alt=media`)).text);
const waitFor = async (check, ms = 15000, step = 300) => {
  const until = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value || Date.now() > until) return value;
    await sleep(step);
  }
};

// -----------------------------------------------------------------------------

console.log(await admin("/reset", {}));
const alice = await login("alice@example.test");
const bob = await login("bob@example.test");
const carol = await login("carol@example.test");
ok(alice.token && bob.token && carol.token, "three test users signed in");

// a scene in alice's Drive, shared with bob (writer, opened in Kurviq) and carol (reader)
const original = {
  type: "excalidraw",
  version: 2,
  source: "https://kurviq.com",
  elements: [rect("A", "a0"), rect("B", "a1", { x: 200 })],
  appState: { viewBackgroundColor: "#ffffff", gridSize: 20, gridStep: 5, gridModeEnabled: false },
  files: {},
};
const boundary = "kq" + Math.random().toString(36).slice(2);
const created = await drive(alice.token, `${F}/upload/drive/v3/files?uploadType=multipart&fields=id,headRevisionId,md5Checksum`, {
  method: "POST",
  headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
  body: `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({
    name: "Live test.excalidraw",
    mimeType: "application/vnd.excalidraw+json",
    appProperties: { kurviq: "scene" },
  })}\r\n--${boundary}\r\nContent-Type: application/vnd.excalidraw+json\r\n\r\n${JSON.stringify(original)}\r\n--${boundary}--`,
});
const fileId = created.data?.id;
ok(created.status === 200 && fileId, "scene file created in alice's Drive", created);
await admin("/share", { fileId, email: "bob@example.test", role: "writer" });
await admin("/grant", { fileId, email: "bob@example.test" });
await admin("/share", { fileId, email: "carol@example.test", role: "reader" });
await admin("/grant", { fileId, email: "carol@example.test" });

// --- tickets -----------------------------------------------------------------
const ta = await ticketFor(alice, fileId);
ok(ta.status === 200 && ta.data.enabled && ta.data.role === "edit" && ta.data.key && ta.data.keyId && ta.data.ticket && ta.data.proof, "alice gets an editor ticket with a new key", ta);
ok(ta.data.head?.revision === created.data.headRevisionId && ta.data.head?.md5 === created.data.md5Checksum, "ticket carries Drive's head revision + md5", ta.data.head);
let meta = await drive(alice.token, `/files/${fileId}?fields=appProperties`);
ok(meta.data.appProperties?.kurviqKey?.startsWith(`${ta.data.keyId}.${fileId}.`) && meta.data.appProperties?.kurviqSync === "do-1", "key + marker written to appProperties", meta.data);
const tc = await ticketFor(carol, fileId);
ok(tc.status === 200 && tc.data.role === "read" && tc.data.key === ta.data.key, "carol gets a viewer ticket with the same key", tc.data?.role);
const nobody = await fetch(`${B}/scene/${fileId}/ticket`, { method: "POST", headers: { Origin: B } });
ok(nobody.status === 401, "ticket without sign-in refused", nobody.status);
const evilOrigin = await fetch(`${B}/scene/${fileId}/ticket`, { method: "POST", headers: { Origin: "https://evil.example", Cookie: alice.cookie() } });
ok(evilOrigin.status === 403, "ticket from a foreign origin refused", evilOrigin.status);

// --- connect, seed -------------------------------------------------------------
const a1 = await openTab(alice, fileId, ta.data, "tabA1");
const wa = await hello(a1);
ok(wa?.mode === "seed" && wa.fileId === fileId && wa.openToken === "open-tabA1" && wa.keyId === ta.data.keyId, "empty scene object asks alice to seed", wa);
const reused = await openTab(alice, fileId, ta.data, "tabX").then(() => "opened", () => "refused");
ok(reused === "refused", "a ticket works only once", reused);

const seedEvents = await Promise.all(original.elements.map((el) => elEvent(a1.scene, el, null)));
seedEvents.push({ k: "set", id: "settings", base: null, c: await encrypt(a1.scene, "settings", original.appState) });
seedEvents.push({ k: "name", id: "name", base: null, c: await encrypt(a1.scene, "name", { name: "Live test" }) });
a1.send({ type: "seed", scene: { revision: "wrong-revision", md5: ta.data.head.md5, events: seedEvents } });
const staleSeed = await a1.next((m) => m.type === "seed-refused");
ok(staleSeed?.reason === "old", "a seed of another revision is refused", staleSeed);
a1.send({ type: "seed", scene: { revision: ta.data.head.revision, md5: ta.data.head.md5, events: seedEvents } });
const seeded = await a1.next((m) => m.type === "welcome");
ok(seeded?.mode === "events" && seeded.seq >= 1, "seed accepted", seeded);
const generation = seeded.generation;

const tb = await ticketFor(bob, fileId);
const b1 = await openTab(bob, fileId, tb.data, "tabB1");
const wb = await hello(b1, { revision: ta.data.head.revision });
ok(wb?.mode === "events" && Array.isArray(wb.events), "bob, who loaded the saved revision, gets the events since", wb?.mode);
const c1 = await openTab(carol, fileId, tc.data, "tabC1");
const wc = await hello(c1);
ok(wc?.mode === "state" && wc.state.events.length === 4 && wc.role === "read", "carol (fresh) gets the full state", wc?.mode);
const stateA = wc.state.events.find((e) => e.id === "A");
ok(stateA && (await decrypt(a1.scene, "A", stateA.c)).type === "rectangle", "state decrypts with the scene key");

// --- editing ---------------------------------------------------------------------
const baseOf = (event) => ({ v: event.r ? event.r.version : event.v.v, n: event.r ? event.r.versionNonce : event.v.n });
let curA = { ...original.elements[0] };
let curB = { ...original.elements[1] };
const seedA = baseOf(stateA);
const seedB = baseOf(wc.state.events.find((e) => e.id === "B"));

curA = { ...curA, x: 10 };
const ack1 = await batch(a1, [await elEvent(a1.scene, curA, seedA)]);
ok(ack1?.type === "ack" && ack1.stamps.A?.v === seedA.v + 1, "alice's change to A is accepted and re-stamped", ack1);
const seenByBob = await b1.next((m) => m.type === "events" && m.seq === ack1.seq);
ok(seenByBob && seenByBob.events[0].r.version === ack1.stamps.A.v && seenByBob.pseudonym === ta.data.pseudonym && seenByBob.counter === 1, "bob receives it with the DO's stamp", seenByBob);
ok(!(await a1.next((m) => m.type === "events" && m.seq === ack1.seq, 500)), "the sender does not get its own batch back");

curB = { ...curB, y: 30 };
const ackB = await batch(b1, [await elEvent(b1.scene, curB, seedB)]);
ok(ackB?.type === "ack" && ackB.seq > ack1.seq, "bob edits another element (B) at the same time: accepted, later seq", ackB);

const clash = await batch(b1, [await elEvent(b1.scene, { ...curA, strokeColor: "#ff0000" }, seedA)]);
ok(clash?.type === "refused" && clash.reason === "collision" && clash.current[0]?.id === "A" && clash.current[0].r.version === ack1.stamps.A.v, "bob's change on a stale base of A is refused with the current state", clash);

// own pending batch as base: two batches before the first answer
curA = { ...curA, x: 20 };
const c2 = ++a1.counter;
a1.send({ type: "batch", counter: c2, live: true, made: Date.now(), via: "user", events: [await elEvent(a1.scene, curA, ack1.stamps.A)] });
curA = { ...curA, x: 30 };
const c3 = ++a1.counter;
a1.send({ type: "batch", counter: c3, live: true, made: Date.now(), via: "user", base: c2, events: [await elEvent(a1.scene, curA, ack1.stamps.A)] });
const ack2 = await a1.next((m) => m.type === "ack" && m.counter === c2);
const ack3 = await a1.next((m) => (m.type === "ack" || m.type === "refused") && m.counter === c3);
ok(ack2 && ack3?.type === "ack" && ack3.seq === ack2.seq + 1 && ack3.stamps.A.v === ack2.stamps.A.v + 1, "a batch built on the tab's own pending batch is accepted, in order", { ack2, ack3 });

// resend dedupe
a1.send({ type: "batch", counter: c2, live: true, made: Date.now(), via: "user", events: [await elEvent(a1.scene, curA, ack1.stamps.A)] });
const dup = await a1.next((m) => m.counter === c2 && (m.type === "ack" || m.type === "refused"));
ok(dup?.type === "ack" && dup.duplicate && dup.seq === ack2.seq, "a resent batch is recognised and stored once", dup);

// viewer, references, limits, invalid, index repair
const roleRefused = await batch(c1, [await elEvent(a1.scene, rect("V", "a5"), null)]);
ok(roleRefused?.reason === "role", "a viewer's batch is refused", roleRefused);
const text = { ...rect("T", "a6"), type: "text", containerId: "nope", text: "x" };
const refRefused = await batch(a1, [await elEvent(a1.scene, text, null)]);
ok(refRefused?.reason === "reference", "an element bound to an unknown container is refused", refRefused);
a1.counter--; // the tab resends a refused batch under its counter
const unknownBase = await batch(a1, [await elEvent(a1.scene, rect("Z", "a7"), { v: 3, n: 3 })]);
ok(unknownBase?.reason === "collision", "an unknown element with a non-zero base is a collision", unknownBase);
a1.counter--;
const invalid = await batch(a1, [{ k: "el", id: "Q", base: null, r: { id: "Q" }, c: "x".repeat(30) }]);
ok(invalid?.reason === "invalid", "an event without a valid readable part is refused", invalid);
a1.counter--;
const many = await batch(a1, Array.from({ length: 5001 }, (_, i) => ({ k: "set", id: "settings", base: null, c: "y".repeat(30 + i) })));
ok(many?.reason === "limit" || many?.reason === "invalid", "a batch over the event limit is refused", many?.reason);
a1.counter--;
const clashIndex = await batch(a1, [await elEvent(a1.scene, rect("C", "a1", { y: 300 }), null)]);
ok(clashIndex?.type === "ack" && clashIndex.repairs?.C && clashIndex.repairs.C > "a1", "a clashing fractional index is repaired by the DO", clashIndex);

// --- reconnect with receipts --------------------------------------------------
a1.ws.close();
await sleep(300);
const ta2 = await ticketFor(alice, fileId);
const a2 = await openTab(alice, fileId, ta2.data, "tabA1");
const wa2 = await hello(a2, { seq: ack1.seq, generation });
ok(wa2?.mode === "events" && wa2.events.map((e) => e.seq).join() === [ackB.seq, ack2.seq, ack3.seq, clashIndex.seq].join(), "reconnect: the events since its seq", wa2?.events?.map((e) => e.seq));
ok(wa2.knownMark >= 3 || wa2.known.includes(c3), "reconnect: the tab learns which of its batches the DO has", { mark: wa2.knownMark, known: wa2.known });
a2.counter = 4;

// --- save round: every tab leaves -> grouped versions per author in Drive -------
const revsBefore = (await admin(`/revisions?fileId=${fileId}`)).revisions?.length ?? (await drive(alice.token, `/files/${fileId}/revisions`)).data.revisions.length;
for (const t of [a2, b1, c1]) t.ws.close();
const saved = await waitFor(async () => {
  const head = await drive(alice.token, `/files/${fileId}?fields=headRevisionId,appProperties,md5Checksum`);
  const revs = (await drive(alice.token, `/files/${fileId}/revisions?fields=revisions(id,md5Checksum,lastModifyingUser(emailAddress))`)).data.revisions;
  return revs.length >= revsBefore + 2 ? { head: head.data, revs } : null;
}, 20000);
ok(saved, "the save round wrote new versions to Drive", saved);
const content = saved ? await fileContent(alice.token, fileId) : null;
const byId = Object.fromEntries((content?.elements || []).map((el) => [el.id, el]));
ok(byId.A?.x === 30 && byId.B?.y === 30 && byId.C?.y === 300 && byId.C.index === clashIndex.repairs.C, "Drive has everyone's changes (A by alice, B by bob, C repaired)", byId);
ok(content?.kurviq?.v === 1 && content.kurviq.op && content.kurviq.authors?.A === ta.data.pseudonym && content.kurviq.authors?.B === tb.data.pseudonym, "file carries op id and per-element pseudonyms", content?.kurviq);
ok(content?.kurviq?.receipts?.tabA1?.mark >= c3 && content.kurviq.receipts.tabB1?.mark >= 1, "file carries receipts per tab", content?.kurviq?.receipts);
ok(saved?.head.appProperties?.kurviqSync === "do-1", "file stays marked kurviqSync=do-1");
const modifiers = saved ? saved.revs.slice(revsBefore).map((rev) => rev.lastModifyingUser?.emailAddress) : [];
ok(modifiers.includes("alice@example.test") && modifiers.includes("bob@example.test"), "one version per author, written with each author's own access", modifiers);
const pseudo = await ticketFor(alice, fileId);
ok(pseudo.data.pseudonym === ta.data.pseudonym && pseudo.data.pseudonym !== tb.data.pseudonym, "pseudonyms are stable per person and scene");

// --- outside change, with a pending Kurviq change on top ----------------------------
const ta3 = await ticketFor(alice, fileId);
const a3 = await openTab(alice, fileId, ta3.data, "tabA3");
const wa3 = await hello(a3);
const live = Object.fromEntries(wa3.state.events.map((e) => [e.id, e]));
curB = { ...byId.B, backgroundColor: "#00ff00" };
const ackKurviqB = await batch(a3, [await elEvent(a3.scene, curB, baseOf(live.B))]);
ok(ackKurviqB?.type === "ack", "alice changes B (pending)");
const outside = structuredClone(content);
outside.elements = outside.elements.map((el) => (el.id === "B" ? { ...el, backgroundColor: "#0000ff" } : el.id === "A" ? { ...el, strokeColor: "#ff00ff" } : el));
outside.elements.push(rect("D", "a9", { y: 500 }));
delete outside.kurviq;
await admin("/write", { email: "alice@example.test", fileId, content: JSON.stringify(outside) });
a3.ws.close(); // the last tab leaves: the round merges the outside revision first, then saves alice's B
const merged = await waitFor(async () => {
  const data = await fileContent(alice.token, fileId);
  const els = Object.fromEntries(data.elements.map((el) => [el.id, el]));
  return data.kurviq && els.D && els.B?.backgroundColor === "#00ff00" ? els : null;
}, 20000);
ok(merged && merged.A.strokeColor === "#ff00ff" && merged.D && merged.B.backgroundColor === "#00ff00", "outside change merged: Kurviq's pending B wins, outside A and D kept", merged && { A: merged.A.strokeColor, B: merged.B.backgroundColor, D: !!merged.D });

// --- outside change right after our own save (no quiet window): merged; need-token when no credential is at hand
const ta4 = await ticketFor(alice, fileId);
const a4 = await openTab(alice, fileId, ta4.data, "tabA4");
const wa4 = await hello(a4);
const outside2 = await fileContent(alice.token, fileId);
outside2.elements.push(rect("E", "b0", { y: 700 }));
delete outside2.kurviq;
await admin("/write", { email: "alice@example.test", fileId, content: JSON.stringify(outside2) });
const need = await a4.next((m) => m.type === "need-token" || (m.type === "events" && m.origin === "outside"), 10000);
if (need?.type === "need-token") {
  const rec = await post(alice, `/scene/${fileId}/reconcile`);
  ok(rec.status === 200 && rec.data.ok, "without a credential at hand the DO asks a tab (need-token → reconcile)", rec);
} else {
  a4.inbox.unshift(need);
  ok(need, "the outside edit right after our own save is checked with the last working access (no quiet window)");
}
const outsideEvents = await a4.next((m) => m.type === "events" && m.origin === "outside", 10000);
ok(outsideEvents?.events.some((e) => e.id === "E"), "the outside change reaches the tab as origin outside", outsideEvents);
const savedOutside = await a4.next((m) => m.type === "saved", 5000);
ok(savedOutside, "the merged outside revision becomes the saved base");

// --- renew --------------------------------------------------------------------------
const renewed = await post(alice, `/scene/${fileId}/renew`, { tab: "tabA4", proof: ta4.data.proof });
ok(renewed.status === 200 && renewed.data.proof && renewed.data.expiresAt > Date.now(), "proof renewal", renewed);
const badRenew = await post(bob, `/scene/${fileId}/renew`, { tab: "tabA4", proof: ta4.data.proof });
ok(badRenew.status === 401, "someone else's proof can't be renewed", badRenew.status);
a4.ws.close();

// --- blocked author: bob revoked, alice's independent work still saves ------------
const tb2 = await ticketFor(bob, fileId);
const b2 = await openTab(bob, fileId, tb2.data, "tabB2");
const wb2 = await hello(b2);
const now2 = Object.fromEntries(wb2.state.events.map((e) => [e.id, e]));
const bobD = { ...merged.D, x: 999 };
const ackBobD = await batch(b2, [await elEvent(b2.scene, bobD, baseOf(now2.D))]);
ok(ackBobD?.type === "ack", "bob changes D");
await admin("/revoke", { email: "bob@example.test" });
b2.ws.close();
const now4 = Object.fromEntries((await (async () => {
  const t = await ticketFor(alice, fileId);
  const tab = await openTab(alice, fileId, t.data, "tabA5");
  const w = await hello(tab);
  tab.close = () => tab.ws.close();
  globalThis.a5 = tab;
  return w.state.events;
})()).map((e) => [e.id, e]));
const a5 = globalThis.a5;
const aliceE = { ...rect("E", now4.E.r.index, { y: 700 }), strokeColor: "#123456" };
const ackAliceE = await batch(a5, [await elEvent(a5.scene, aliceE, baseOf(now4.E))]);
ok(ackAliceE?.type === "ack", "alice changes E (independent of bob's D)");
a5.ws.close();
const afterBlock = await waitFor(async () => {
  const data = await fileContent(alice.token, fileId);
  const els = Object.fromEntries(data.elements.map((el) => [el.id, el]));
  return els.E?.strokeColor === "#123456" ? els : null;
}, 20000);
ok(afterBlock && afterBlock.D.x !== 999, "alice's work saved while bob's (revoked) waits", afterBlock && { E: afterBlock.E.strokeColor, D: afterBlock.D.x });
const ta6 = await ticketFor(alice, fileId);
let a6 = await openTab(alice, fileId, ta6.data, "tabA6");
await hello(a6);
const status = await a6.next((m) => m.type === "status" && m.blocked?.length, 5000);
ok(status?.blocked[0]?.pseudonym === tb.data.pseudonym && status.blocked[0].reason === "token" && status.blocked[0].decidable === false, "editors see bob's changes as not savable (decide after 24 h)", status);
a6.send({ type: "decide", author: tb.data.pseudonym, action: "discard" });
const stillBlocked = await a6.next((m) => m.type === "status", 3000);
ok(stillBlocked?.blocked?.length === 1, "deciding before 24 hours does nothing", stillBlocked?.blocked);

// --- after 24 hours: discard (a resend is refused), accept (saved on behalf) ------------
await post(alice, `/scene/${fileId}/dev-age`, { ms: 25 * 3600_000 });
const decidable = await a6.next((m) => m.type === "status" && m.blocked?.[0]?.decidable, 5000);
ok(decidable, "after 24 hours editors may decide", decidable?.blocked);
a6.send({ type: "decide", author: tb.data.pseudonym, action: "discard" });
const repair = await a6.next((m) => m.type === "events" && m.origin === "repair", 5000);
const repairedD = repair?.events.find((e) => e.id === "D");
ok(repairedD && (await decrypt(a6.scene, "D", repairedD.c)).x !== 999, "discard: D goes back to its state without bob's change, sent as a repair", repair);
const bob2 = await login("bob@example.test");
const tb3 = await ticketFor(bob2, fileId);
const b3 = await openTab(bob2, fileId, tb3.data, "tabB2");
const wb3 = await hello(b3);
ok(wb3?.knownMark >= 1, "bob's tab learns its batch is known", wb3?.knownMark);
const resent = await batch(b3, [await elEvent(b3.scene, bobD, baseOf(now2.D))], { counter: 1 });
ok(resent?.reason === "discarded", "a discarded batch is refused when resent", resent);
const D3 = wb3.state.events.find((e) => e.id === "D");
const ackBob2 = await batch(b3, [await elEvent(b3.scene, { ...(await decrypt(b3.scene, "D", D3.c)), id: "D", y: 4242, version: D3.r.version, versionNonce: D3.r.versionNonce, index: D3.r.index, isDeleted: false }, baseOf(D3))], { counter: 2 });
ok(ackBob2?.type === "ack", "bob changes D again");
await admin("/revoke", { email: "bob@example.test" });
b3.ws.close();
a6.ws.close(); // last tab: the round finds bob unsavable again
await sleep(3000);
const ta8 = await ticketFor(alice, fileId);
a6 = await openTab(alice, fileId, ta8.data, "tabA8");
await hello(a6);
await post(alice, `/scene/${fileId}/dev-age`, { ms: 25 * 3600_000 });
const decidable2 = await a6.next((m) => m.type === "status" && m.blocked?.[0]?.decidable, 5000);
ok(decidable2, "bob blocked again, decidable");
a6.send({ type: "decide", author: tb.data.pseudonym, action: "accept" });
const accepted = await waitFor(async () => {
  const data = await fileContent(alice.token, fileId);
  const D = data.elements.find((el) => el.id === "D");
  return D?.y === 4242 ? data : null;
}, 20000);
ok(accepted && accepted.kurviq.onBehalf.some((entry) => entry.by === ta.data.pseudonym && entry.for === tb.data.pseudonym), "accept: bob's change saved by alice, recorded on behalf of bob", accepted?.kurviq?.onBehalf);
ok(accepted?.kurviq?.authors?.D === tb.data.pseudonym, "the element keeps bob as its author", accepted?.kurviq?.authors?.D);

// --- an agent's change: its own version, pinned and marked (agentRev) -----------------
const w8 = (await fileContent(alice.token, fileId)).elements.find((el) => el.id === "A");
a6.send({ type: "hello", protocol: 1, tab: "tabA8", openToken: "again", revision: null, seq: 0, generation: null });
await a6.next(() => false, 1500);
ok(a6.closed?.code === 1008, "a second hello on one connection closes it (no full state on demand)", a6.closed);
a6 = await openTab(alice, fileId, (await ticketFor(alice, fileId)).data, "tabA8b");
const w8state = await hello(a6);
const A8 = w8state.state.events.find((e) => e.id === "A");
a6.counter = 0;
const agentAck = await batch(a6, [await elEvent(a6.scene, { ...w8, x: 4321, version: A8.r.version, versionNonce: A8.r.versionNonce }, baseOf(A8))], { via: "agent", command: "cmd-1" });
ok(agentAck?.type === "ack", "an agent's change through the tab is accepted");
a6.ws.close();
const marked = await waitFor(async () => {
  const meta = await drive(alice.token, `/files/${fileId}?fields=appProperties,headRevisionId`);
  return meta.data.appProperties?.agentRev ? meta.data : null;
}, 20000);
const revs8 = (await drive(alice.token, `/files/${fileId}/revisions?fields=revisions(id,keepForever)`)).data.revisions;
ok(marked && revs8.find((rev) => rev.id === marked.appProperties.agentRev)?.keepForever, "the agent's version is marked (agentRev) and kept forever", { marked, revs: revs8.slice(-3) });
const ta9 = await ticketFor(alice, fileId);
a6 = await openTab(alice, fileId, ta9.data, "tabA9");
await hello(a6);

// --- trash lifecycle -------------------------------------------------------------------
await admin("/trash", { fileId });
const trashed = await a6.next((m) => m.type === "status" && m.lifecycle === "trashed", 10000);
ok(trashed, "trash in Drive reaches the tab (watch notification)", trashed);
const lifecycleRefused = await batch(a6, [await elEvent(a6.scene, rect("F", "c0"), null)]);
ok(lifecycleRefused?.reason === "lifecycle", "batches to a trashed scene are refused", lifecycleRefused);
await admin("/untrash", { fileId });
const replaced = await a6.next((m) => m.type === "closed", 10000);
ok(replaced?.reason === "replaced", "restored from the trash: tabs reload (new epoch)", replaced);
const ta7 = await ticketFor(alice, fileId);
const a7 = await openTab(alice, fileId, ta7.data, "tabA7");
const wa7 = await hello(a7);
ok(wa7?.mode === "seed" && wa7.epoch === wa.epoch + 1, "after a restore the scene is seeded again in a new epoch", { mode: wa7?.mode, epoch: wa7?.epoch });

// --- sign out everywhere ----------------------------------------------------------------
const head7 = ta7.data.head;
const events7 = (await fileContent(alice.token, fileId)).elements.map((el) => el);
const seed7 = await Promise.all(events7.map((el) => elEvent(a7.scene, el, null)));
a7.send({ type: "seed", scene: { revision: head7.revision, md5: head7.md5, events: seed7 } });
const seeded7 = await a7.next((m) => m.type === "welcome");
const st7 = await a7.next((m) => false, 300);
const A7 = seed7.find((e) => e.id === "A");
const ack7 = await batch(a7, [await elEvent(a7.scene, { ...events7.find((el) => el.id === "A"), x: 777 }, baseOf(A7))]);
ok(seeded7 && ack7?.type === "ack", "alice has an unsaved change (her token is stored)");
const cookieBefore = alice.cookie();
const out = await post(alice, "/auth/logout-all");
ok(out.status === 200 && out.data.scenes >= 1, "sign out everywhere finds the scenes holding her token", out);
const closedAll = await a7.next(() => false, 2000);
ok(a7.closed || a7.inbox.some((m) => m.type === "closed" && m.reason === "access"), "her live connections close", a7.closed);
const afterOut = await fetch(`${B}/scene/${fileId}/ticket`, { method: "POST", headers: { Origin: B, Cookie: cookieBefore, "Content-Type": "application/json" }, body: "{}" });
ok(afterOut.status === 401, "the old session can't get tickets any more", afterOut.status);


// =============================================================================
// part 2: the review fixes, on a second scene
// =============================================================================

const dev = (user, fid, what, body = {}) => post(user, `/scene/${fid}/${what}`, body);
const alice2 = await login("alice@example.test");
const bob3 = await login("bob@example.test");
const carol2 = await login("carol@example.test");

const createScene = async (user, name, elements) => {
  const b = "kq" + Math.random().toString(36).slice(2);
  const res = await drive(user.token, `${F}/upload/drive/v3/files?uploadType=multipart&fields=id,headRevisionId,md5Checksum`, {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${b}` },
    body: `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: `${name}.excalidraw`, mimeType: "application/vnd.excalidraw+json" })}\r\n--${b}\r\nContent-Type: application/vnd.excalidraw+json\r\n\r\n${JSON.stringify({ ...original, elements })}\r\n--${b}--`,
  });
  if (!res.data?.id) console.log("      (scene not created:", res.status, res.text.slice(0, 300), ")");
  return res.data.id;
};
/** ticket, connect, hello; seeds from Drive (with the file's kurviq record) if asked to */
const join = async (user, fid, tabId, helloOpts = {}) => {
  const t = await ticketFor(user, fid);
  if (!t.data?.ticket) {
    console.log(`      (no ticket for ${user.email}: ${JSON.stringify(t)})`);
  }
  const tab = await openTab(user, fid, t.data, tabId);
  tab.ticketAnswer = t.data;
  let w = await hello(tab, helloOpts);
  if (w?.mode === "seed") {
    const data = await fileContent(user.token, fid);
    const events = await Promise.all(data.elements.map((el) => elEvent(tab.scene, el, null)));
    tab.send({ type: "seed", scene: { revision: t.data.head.revision, md5: t.data.head.md5, events }, ...(data.kurviq ? { kurviq: data.kurviq } : {}) });
    await tab.next((m) => m.type === "welcome");
    // one hello per connection: the seeded state comes on a new one
    tab.ws.close();
    return join(user, fid, tabId, helloOpts);
  }
  tab.welcome = w;
  tab.stamps = Object.fromEntries((w?.state?.events ?? []).map((e) => [e.id, baseOf(e)]));
  return tab;
};
const revisionsOf = async (user, fid) =>
  (await drive(user.token, `/files/${fid}/revisions?fields=revisions(id,md5Checksum,keepForever)`)).data.revisions;
const revisionContent = async (user, fid, rev) => JSON.parse((await drive(user.token, `/files/${fid}/revisions/${rev}?alt=media`)).text);
const until = (check, ms = 25000) => waitFor(check, ms, 400);

const file2 = await createScene(alice2, "Review fixes", [rect("P", "a0"), rect("Q", "a1", { x: 200 })]);
await admin("/share", { fileId: file2, email: "bob@example.test", role: "writer" });
await admin("/grant", { fileId: file2, email: "bob@example.test" });
await admin("/share", { fileId: file2, email: "carol@example.test", role: "reader" });
await admin("/grant", { fileId: file2, email: "carol@example.test" });
const t1 = await join(alice2, file2, "r-t1");
ok(t1.welcome?.mode === "state", "scene 2 seeded");
// scene 3 (alice alone): budgets, font ids, expiry; its never-hello connection is checked at the end
const file5 = await createScene(alice2, "Budgets", [rect("B0", "a0")]);
await join(alice2, file5, "r-v0").then((tab) => tab.ws.close()); // seeded
const idleTicket = await ticketFor(alice2, file5);
const idle = await openTab(alice2, file5, idleTicket.data, "r-idle");
const idleOpenedAt = Date.now();

// --- 16. names are never stored in plaintext ----------------------------------------
const stats0 = (await dev(alice2, file2, "dev-stats")).data;
ok(!stats0.metaKeys.includes("driveName") && !stats0.metaKeys.includes("people"), "no scene or person names in storage (memory only)", stats0.metaKeys);

// --- 17. rows written per batch -----------------------------------------------------
await dev(alice2, file2, "dev-stats", { reset: true });
for (let i = 0; i < 20; i++) {
  const ackRow = await batch(t1, [await elEvent(t1.scene, rect(`R${i}`, `b${String(i).padStart(2, "0")}`, { y: 100 + i }), null)]);
  if (ackRow?.type !== "ack") ok(false, "row test batch accepted", ackRow);
}
const statsRows = (await dev(alice2, file2, "dev-stats")).data;
const perBatch = statsRows.rowsWritten / 20;
console.log(`      rowsWritten: ${statsRows.rowsWritten} for 20 batches (incl. the first batch's token, outbox and schedule rows)`);
ok(perBatch <= 1.5, `accepting a batch writes about one row (${perBatch.toFixed(2)} per batch)`, statsRows.rowsWritten);
const costs = statsRows.costs;
console.log(`      costs for 20 batches: ${JSON.stringify({ rowsWritten: costs.rowsWritten, rowsRead: costs.rowsRead, wsIn: costs.wsIn, wsOut: costs.wsOut, handlerMs: costs.handlerMs, alarms: costs.alarms })}`);
ok(costs && costs.wsIn >= 20 && costs.wsOut >= 20 && costs.rowsWritten === statsRows.rowsWritten && costs.handlers.webSocketMessage?.calls >= 20 && costs.fetches["/dev-stats"] >= 1, "dev-stats counts rows, messages, requests and handler time", costs);

// --- 9. replay horizon and a sane `made` ----------------------------------------------
const oldBatch = await batch(t1, [await elEvent(t1.scene, rect("OLD", "c0"), null)], { made: Date.now() - 31 * 24 * 3600_000 });
ok(oldBatch?.reason === "old", "a batch made more than 30 days ago is refused (old)", oldBatch);
t1.counter--;
const noMade = await batch(t1, [await elEvent(t1.scene, rect("OLD", "c0"), null)], { made: "yesterday" });
ok(noMade?.reason === "invalid", "a batch without a valid made is refused", noMade);
t1.counter--;

// --- 8. counter window, assembled size, scene and pending bytes -----------------------------
const far = await batch(t1, [await elEvent(t1.scene, rect("FAR", "c1"), null)], { counter: 1_000_000 });
ok(far?.reason === "limit", "a counter far above the tab's own is refused", far);
const bigTicket = await ticketFor(alice2, file2);
const big = await openTab(alice2, file2, bigTicket.data, "r-big");
await hello(big);
big.ws.send(JSON.stringify({ type: "part", id: "x1", i: 0, total: 200, data: "{" }));
await big.next(() => false, 1500);
ok(big.closed?.code === 1008, "a message announced bigger than the batch limit closes the connection", big.closed);
const imageOf = async (id) =>
  encrypt(t1.scene, id, { id, mimeType: "image/png", dataURL: `data:image/png;base64,${Buffer.alloc(5 * 1024 * 1024, id.length).toString("base64")}`, created: 1 }, "file");
const file1 = await batch(t1, [{ k: "file", id: "img1", base: null, c: await imageOf("img1") }]);
ok(file1?.type === "ack", "a 9 MB image is accepted");
const file2b = await batch(t1, [{ k: "file", id: "img2", base: null, c: await imageOf("img22") }]);
ok(file2b?.reason === "limit" && /PendingBytes/i.test(file2b.detail), "the next 9 MB is refused: unsaved bytes of one account are limited", file2b);
t1.counter--;

// --- 10. the whole reference graph --------------------------------------------------------
const boundUnknown = await batch(t1, [await elEvent(t1.scene, rect("BU", "c2", { boundElements: [{ id: "ghost", type: "text" }] }), null)]);
ok(boundUnknown?.reason === "reference", "an element bound to an unknown element is refused", boundUnknown);
t1.counter--;
const imgNoFile = await batch(t1, [await elEvent(t1.scene, { ...rect("IM", "c3"), type: "image", fileId: "nofile" }, null)]);
ok(imgNoFile?.reason === "reference", "an image without its image data is refused", imgNoFile);
t1.counter--;
const imgFile = await batch(t1, [
  { k: "file", id: "small1", base: null, c: await encrypt(t1.scene, "small1", { id: "small1", mimeType: "image/png", dataURL: "data:image/png;base64,AAAA", created: 1 }, "file") },
  await elEvent(t1.scene, { ...rect("IM", "c3"), type: "image", fileId: "small1" }, null),
]);
ok(imgFile?.type === "ack", "an image with its data in the same batch is accepted", imgFile);
const box = rect("BOX", "c4", { boundElements: [{ id: "LBL", type: "text" }] });
const label = { ...rect("LBL", "c5"), type: "text", containerId: "BOX", text: "hi" };
const ackBox = await batch(t1, [await elEvent(t1.scene, box, null), await elEvent(t1.scene, label, null)]);
ok(ackBox?.type === "ack", "a box with its label");
const delBox = await batch(t1, [await elEvent(t1.scene, { ...box, isDeleted: true }, ackBox.stamps.BOX)]);
ok(delBox?.reason === "reference" && /LBL/.test(delBox.detail), "deleting a box while its label stays alive is refused", delBox);
t1.counter--;

// --- 11. user → agent → user keeps its order in Drive ------------------------------------------
const revsBefore2 = (await revisionsOf(alice2, file2)).length;
await batch(t1, [await elEvent(t1.scene, rect("UX", "d0"), null)]);
await batch(t1, [await elEvent(t1.scene, rect("AY", "d1"), null)], { via: "agent" });
await batch(t1, [await elEvent(t1.scene, rect("UZ", "d2"), null)]);
await dev(alice2, file2, "dev-stats", { reset: true });
t1.ws.close();
const revs2 = await until(async () => {
  const r = await revisionsOf(alice2, file2);
  return r.length >= revsBefore2 + 3 ? r : null;
}, 40000);
ok(revs2, "three versions: user, agent, user", revs2?.length);
const meta2 = await drive(alice2.token, `/files/${file2}?fields=appProperties`);
const agentContent = meta2.data.appProperties?.agentRev ? await revisionContent(alice2, file2, meta2.data.appProperties.agentRev) : null;
const agentIds = new Set((agentContent?.elements ?? []).map((el) => el.id));
ok(agentIds.has("UX") && agentIds.has("AY") && !agentIds.has("UZ"), "the user's edit after the agent's comes after the agent's version", [...agentIds].filter((id) => /^(UX|AY|UZ)$/.test(id)));
const final2 = await fileContent(alice2.token, file2);
ok(final2.files?.img1, "an image no element uses yet is in the file (its batch is receipted as saved)", Object.keys(final2.files ?? {}));
const statsSave = (await dev(alice2, file2, "dev-stats")).data;
ok(statsSave.costs.alarms >= 1 && Object.keys(statsSave.costs.drive).some((kind) => kind.includes("upload")) && statsSave.costs.driveMs > 0, "dev-stats counts alarms and Google calls by kind with their wait", statsSave.costs.drive);
console.log(`      Google calls in the save round: ${JSON.stringify(Object.fromEntries(Object.entries(statsSave.costs.drive).map(([k, v]) => [k, v.calls])))}, handlerMs ${statsSave.costs.handlerMs}`);
console.log(`      rowsWritten: ${statsSave.rowsWritten} for the save round (3 versions, ${20 + 6} batches deleted, snapshot, receipts, tabs)`);

// --- 14. the watch stops when the last connection left --------------------------------------
const stopped = await until(async () => {
  const channels = (await admin("/channels")).channels.filter((c) => c.file_id === file2);
  return channels.length === 0 ? true : null;
}, 20000);
ok(stopped, "the Drive watch is stopped after the last connection left");

// --- 2. a crash after Drive took the upload: recovered from the record, never uploaded twice ------
const t2 = await join(alice2, file2, "r-t2");
const revsC = (await revisionsOf(alice2, file2)).length;
await dev(alice2, file2, "dev-crash", { at: "after-upload" });
const ackCrash = await batch(t2, [await elEvent(t2.scene, rect("CR", "e0"), null)]);
ok(ackCrash?.type === "ack", "a change before the crash");
t2.ws.close();
const recovered = await until(async () => {
  const st = (await dev(alice2, file2, "dev-stats")).data;
  return st.pending === 0 && st.saves.every((sv) => sv.state === "done") ? st : null;
}, 40000);
const revsAfterCrash = await revisionsOf(alice2, file2);
const crashed = await fileContent(alice2.token, file2);
ok(recovered && crashed.elements.some((el) => el.id === "CR") && revsAfterCrash.length === revsC + 1, "after the crash the save is found by its checksum and committed (one version, not two)", { recovered: !!recovered, revs: revsAfterCrash.length - revsC });

// --- 3. an outside write just before our upload, then a crash before the audit: merged afterwards ---
const t3 = await join(alice2, file2, "r-t3");
await dev(alice2, file2, "dev-crash", { at: "after-commit", restart: true, race: { email: "alice@example.test", add: rect("WOUT", "f0", { y: 900 }) } });
await batch(t3, [await elEvent(t3.scene, rect("VIN", "f1"), null)]);
t3.ws.close();
const audited = await until(async () => {
  const data = await fileContent(alice2.token, file2);
  const ids = new Set(data.elements.map((el) => el.id));
  return ids.has("VIN") && ids.has("WOUT") ? data : null;
}, 50000);
ok(audited, "the overwritten outside revision is found by the audit (also after a crash) and merged in", audited ? "both" : { ids: (await fileContent(alice2.token, file2)).elements.map((el) => el.id).slice(-4), stats: (await dev(alice2, file2, "dev-stats")).data, revs: (await admin(`/revisions?fileId=${file2}`)).revisions?.slice(-4).map((r) => r.id) });
ok(audited?.kurviq?.onBehalf?.some((entry) => entry.for === "outside"), "the merged version is recorded as made for an outside change", audited?.kurviq?.onBehalf);
const statsAudit = (await dev(alice2, file2, "dev-stats")).data;
const keptRevs = (await revisionsOf(alice2, file2)).filter((rev) => rev.keepForever).map((rev) => rev.id);
ok(!statsAudit.auditPins?.length && !statsAudit.pins?.some((pin) => pin.kind === "audit") && statsAudit.saves.every((sv) => sv.state === "done"), "the revisions pinned for the audit are let go again; the audit and its repair are done", { auditPins: statsAudit.auditPins, kept: keptRevs.length, saves: statsAudit.saves });

// --- 5 (round 2). a failed upload is retried, not lost ---------------------------------------------
const tf = await join(alice2, file2, "r-tf");
await admin("/faults", { count: 1, status: 429, path: "/upload/" });
await batch(tf, [await elEvent(tf.scene, rect("RETRY", "f2"), null)]);
tf.ws.close();
const retried = await until(async () => ((await fileContent(alice2.token, file2)).elements.some((el) => el.id === "RETRY") ? true : null), 90000);
ok(retried, "an upload Google refused with 429 is retried later (the job is not lost)");

// --- 10 (round 2). an outside deletion of what pending work still uses is not taken --------------------
const to = await join(alice2, file2, "r-to");
const ackS2 = await batch(to, [await elEvent(to.scene, rect("S2", "f3", { y: 1500 }), null)]);
to.ws.close();
await until(async () => ((await fileContent(alice2.token, file2)).elements.some((el) => el.id === "S2") ? true : null), 25000);
const to2 = await join(alice2, file2, "r-to2");
const arrowS2 = { ...rect("A2", "f4"), type: "arrow", points: [[0, 0], [5, 5]], startBinding: { elementId: "S2", focus: 0, gap: 1 } };
ok((await batch(to2, [await elEvent(to2.scene, arrowS2, null)]))?.type === "ack", "a pending arrow bound to S2");
const withoutS2 = await fileContent(alice2.token, file2);
withoutS2.elements = withoutS2.elements.filter((el) => el.id !== "S2");
delete withoutS2.kurviq;
await admin("/write", { email: "alice@example.test", fileId: file2, content: JSON.stringify(withoutS2) });
await to2.next((m) => m.type === "saved", 15000);
to2.ws.close();
const keptS2 = await until(async () => {
  const data = await fileContent(alice2.token, file2);
  const els = Object.fromEntries(data.elements.map((el) => [el.id, el]));
  return els.A2 && data.kurviq ? els : null;
}, 25000);
ok(keptS2?.S2 && keptS2.A2.startBinding?.elementId === "S2", "S2, deleted outside while a pending arrow uses it, is saved again with the arrow", keptS2 && { S2: !!keptS2.S2, binding: keptS2.A2.startBinding });

// --- 9 (round 2). what is saved is what was checked: references come from the readable part --------------
const tr = await join(alice2, file2, "r-tr");
const sneaky = { ...rect("SN", "f5"), type: "arrow", points: [[0, 0], [5, 5]], startBinding: { elementId: "ghost", focus: 0, gap: 1 } };
const sneakyEvent = { k: "el", id: "SN", base: null, r: readableOf({ ...sneaky, startBinding: null }), c: await encrypt(tr.scene, "SN", contentOf(sneaky)) };
ok((await batch(tr, [sneakyEvent]))?.type === "ack", "an arrow whose encrypted binding names an element its readable part doesn't");
tr.ws.close();
const savedSneaky = await until(async () => (await fileContent(alice2.token, file2)).elements.find((el) => el.id === "SN") ?? null, 25000);
ok(savedSneaky && savedSneaky.startBinding === null, "it is saved with the checked (readable) references, no dangling binding", savedSneaky?.startBinding);

// --- 7 (round 2). an invalid change takes what was built on it along; affected tabs are told ------------
const ti = await join(alice2, file2, "r-ti");
const bogus = await batch(ti, [{ k: "file", id: "bogus1", base: null, c: Buffer.alloc(64, 1).toString("base64") }]);
const bi = await join(bob3, file2, "r-bi");
const usesBogus = await batch(bi, [await elEvent(bi.scene, { ...rect("IMB", "f6"), type: "image", fileId: "bogus1" }, null)]);
ok(bogus?.type === "ack" && usesBogus?.type === "ack", "an undecryptable image (alice) and bob's image element using it are accepted at first");
ti.ws.close();
// bob's tab stays open: the regular round (a minute after the first change) finds it
const toldBob = await bi.next((m) => m.type === "refused" && m.counter === usesBogus.counter, 110000);
ok(toldBob?.reason === "invalid", "the save sets both aside: bob's tab is told its batch went too", toldBob ?? (({ costs, pins, ...rest }) => rest)((await dev(alice2, file2, "dev-stats")).data));
bi.ws.close();
const afterInvalid = await until(async () => {
  const st = (await dev(alice2, file2, "dev-stats")).data;
  return st.pending === 0 ? st : null;
}, 40000);
const invalidSaved = await fileContent(alice2.token, file2);
ok(afterInvalid && !invalidSaved.elements.some((el) => el.id === "IMB"), "nothing of it reaches Drive (the repair is saved)", invalidSaved.elements.map((el) => el.id).slice(-3));

// --- 4. discard takes the work built on it along ----------------------------------------------------
const b4 = await join(bob3, file2, "r-b4");
const ackS = await batch(b4, [await elEvent(b4.scene, rect("S", "g0", { y: 1200 }), null)]);
ok(ackS?.type === "ack", "bob adds a shape S");
await admin("/revoke", { email: "bob@example.test" });
b4.ws.close();
const t4 = await join(alice2, file2, "r-t4");
const sNow = t4.welcome.state.events.find((e) => e.id === "S");
const arrow = { ...rect("ARR", "g1"), type: "arrow", points: [[0, 0], [10, 10]], startBinding: { elementId: "S", focus: 0, gap: 1 } };
const ackArrow = await batch(t4, [await elEvent(t4.scene, arrow, null)]);
ok(ackArrow?.type === "ack" && sNow, "alice binds an arrow to bob's S (builds on it)");
t4.ws.close();
await sleep(4000); // the round: bob can't be saved as, alice's arrow waits for him
const t5 = await join(alice2, file2, "r-t5");
await dev(alice2, file2, "dev-age", { ms: 25 * 3600_000 });
await t5.next((m) => m.type === "status" && m.blocked?.[0]?.decidable, 5000);
t5.send({ type: "decide", author: b4.ticketAnswer.pseudonym, action: "discard" });
const repair2 = await t5.next((m) => m.type === "events" && m.origin === "repair", 5000);
const repairedIds = new Set((repair2?.events ?? []).filter((e) => e.r?.isDeleted).map((e) => e.id));
ok(repairedIds.has("S") && repairedIds.has("ARR"), "discarding bob's S also discards alice's arrow built on it", [...repairedIds]);
const stats4 = (await dev(alice2, file2, "dev-stats")).data;
ok(stats4.pending <= 1 && stats4.tokens >= 1, "nothing of the closure is left pending (only the repair), and its author keeps a token", { pending: stats4.pending, tokens: stats4.tokens });
const tabArr = await openTab(alice2, file2, (await ticketFor(alice2, file2)).data, "r-t4");
await hello(tabArr);
const resentArrow = await batch(tabArr, [await elEvent(tabArr.scene, arrow, null)], { counter: ackArrow.counter });
ok(resentArrow?.reason === "discarded", "alice's discarded arrow batch is refused when resent (her tab makes an offline copy)", resentArrow);
tabArr.ws.close();

// --- 15. reseed keeps the file's record: authors, receipts, the save time --------------------
t5.ws.close();
const repairSaved = await until(async () => ((await dev(alice2, file2, "dev-stats")).data.pending === 0 ? true : null), 25000);
ok(repairSaved, "the discard's repair is saved after its author left");
const beforeTrash = await fileContent(alice2.token, file2);
await admin("/trash", { fileId: file2 });
await sleep(1500);
await admin("/untrash", { fileId: file2 });
await sleep(1500);
await dev(alice2, file2, "dev-drop-tabs");
const t6 = await join(alice2, file2, "r-t6");
ok(t6.welcome?.mode === "state" && t6.welcome.receipts?.["r-t1"], "after a reseed the saved receipts are back (from the file)", Object.keys(t6.welcome?.receipts ?? {}));
const p6 = t6.welcome.state.events.find((e) => e.id === "P");
await batch(t6, [await elEvent(t6.scene, { ...(await decrypt(t6.scene, "P", p6.c)), id: "P", x: 55, version: p6.r.version, versionNonce: p6.r.versionNonce, index: p6.r.index, isDeleted: false }, baseOf(p6))]);
t6.ws.close();
const reseeded = await until(async () => {
  const data = await fileContent(alice2.token, file2);
  return data.elements.find((el) => el.id === "P")?.x === 55 ? data : null;
}, 25000);
ok(reseeded && reseeded.kurviq.authors.UX === beforeTrash.kurviq.authors.UX && reseeded.kurviq.receipts["r-t1"], "untouched elements keep their authors and old receipts stay after a reseed", reseeded?.kurviq);
const oldMark = beforeTrash.kurviq.receipts["r-t1"].mark;
const back1 = await openTab(alice2, file2, (await ticketFor(alice2, file2)).data, "r-t1");
const w1 = await hello(back1);
ok(w1?.knownMark >= oldMark, "after lost metadata the tab's counters are known again (from the seeded receipts)", { knownMark: w1?.knownMark, oldMark });
back1.counter = w1.knownMark;
const resent1 = await batch(back1, [await elEvent(back1.scene, rect("R0", "b00"), null)], { counter: 1 });
ok(resent1?.duplicate, "an old counter of that tab is recognised as saved", resent1);
await batch(back1, [await elEvent(back1.scene, rect("NEW1", "h9"), null)]);
back1.ws.close();
const kept1 = await until(async () => {
  const data = await fileContent(alice2.token, file2);
  return data.elements.some((el) => el.id === "NEW1") ? data : null;
}, 25000);
ok(kept1 && kept1.kurviq.receipts["r-t1"].mark > oldMark, "the tab's next save keeps its old receipt and adds the new counter", kept1?.kurviq?.receipts?.["r-t1"]);

// --- 1. "remove": unsharing the watch's maker is checked, never a wipe or a tombstone ---------------------------
const bob5 = await login("bob@example.test");
const file4 = await createScene(alice2, "Unshare", [rect("U1", "a0")]);
await admin("/share", { fileId: file4, email: "bob@example.test", role: "writer" });
await admin("/grant", { fileId: file4, email: "bob@example.test" });
const ub = await join(bob5, file4, "r-ub"); // bob comes first: his access makes the key and the watch
const chB = await until(async () => (await admin("/channels")).channels.find((c) => c.file_id === file4) ?? null, 10000);
ok(chB?.email === "bob@example.test", "bob made the scene's watch", chB?.email);
const ua = await join(alice2, file4, "r-ua");
const ub2 = await openTab(bob5, file4, (await ticketFor(bob5, file4)).data, "r-ub2");
await hello(ub2);
const ackUb = await batch(ub, [await elEvent(ub.scene, rect("BOBS", "a5"), null)]);
ok(ackUb?.type === "ack", "bob has a pending change; alice (the owner) is connected without one");
await admin("/unshare", { fileId: file4, email: "bob@example.test" });
const askOrRenew = await ua.next((m) => m.type === "need-token" || m.type === "renew-now", 15000);
if (askOrRenew?.type === "need-token") {
  await post(alice2, `/scene/${file4}/reconcile`);
  await ua.next((m) => m.type === "renew-now", 10000);
}
const stats4b = (await dev(alice2, file4, "dev-stats")).data;
ok(stats4b.lifecycle.state === "active" && stats4b.pending >= 1, "bob's \"not found\" only means he lost access: nothing wiped, no tombstone, his change kept", { lifecycle: stats4b.lifecycle, pending: stats4b.pending });
ok(!ua.closed, "alice stays connected");
const bobGone = await ub.next((m) => m.type === "closed", 10000);
ok(bobGone?.reason === "access" || ub.closed, "bob, unshared while connected, is closed at once (the scene object checks his access itself)", bobGone ?? ub.closed);
const ub2Gone = await ub2.next((m) => m.type === "closed", 5000);
ok(ub2Gone?.reason === "access" || ub2.closed, "…and so is his other connection (a refusal closes every connection of the account)", ub2Gone ?? ub2.closed);
ub.ws.close();
ua.ws.close();

const t7 = await join(alice2, file2, "r-t7");
const pending7 = await batch(t7, [await elEvent(t7.scene, rect("KEEP", "h0"), null)]);
ok(pending7?.type === "ack", "a pending change of the owner");

// --- 12. keep-local only with Drive's word that nobody else has the file ---------------------------
t7.send({ type: "keep-local" });
const kl1 = await t7.next((m) => m.type === "keep-local", 5000);
ok(kl1?.ok === false && kl1.reason === "shared", "keep-local without the Worker's sharing check is refused", kl1);
const klShared = await post(alice2, `/scene/${file2}/keep-local`);
ok(klShared.status === 409 && klShared.data.code === "shared", "the Worker refuses keep-local for a shared file", klShared);
const file3 = await createScene(alice2, "Private", [rect("Z1", "a0")]);
const u1 = await join(alice2, file3, "r-u1");
const klOk = await post(alice2, `/scene/${file3}/keep-local`);
ok(klOk.status === 200 && klOk.data.ok, "the Worker confirms: owned and not shared", klOk);
u1.send({ type: "keep-local" });
const kl2 = await u1.next((m) => m.type === "keep-local", 5000);
ok(kl2?.ok && kl2.state?.events?.some((e) => e.id === "Z1"), "keep-local hands over the final state", kl2?.ok);
u1.send({ type: "keep-local-done" });
const closedLocal = await u1.next((m) => m.type === "closed", 5000);
ok(closedLocal?.reason === "local", "after keep-local-done the scene is local only", closedLocal);

// --- 5. sign out everywhere also closes connections that hold no stored token; old tickets stop working ---
const c8 = await join(carol2, file2, "r-c8");
const oldTicket = await ticketFor(carol2, file2);
const outCarol = await post(carol2, "/auth/logout-all");
ok(outCarol.status === 200 && outCarol.data.scenes >= 1, "carol (a viewer, no stored token) signs out everywhere", outCarol);
await c8.next(() => false, 1500);
ok(c8.closed || c8.inbox.some((m) => m.type === "closed"), "her open connection closes", c8.closed);
const lateOpen = await openTab(carol2, file2, oldTicket.data, "r-c9").then(() => "opened", () => "refused");
ok(lateOpen === "refused", "a ticket issued before sign out everywhere opens nothing", lateOpen);

// --- 1. a real delete: a tombstone, the content kept (7 days) -------------------------------------------
await admin("/delete", { fileId: file2 });
const gone = await t7.next((m) => m.type === "closed", 15000);
const stats9 = await until(async () => {
  const st = (await dev(alice2, file2, "dev-stats")).data;
  return st.lifecycle.state === "deleted" ? st : null;
}, 20000);
ok(["deleted", "access"].includes(gone?.reason) && stats9?.lifecycle.state === "deleted" && stats9.pending >= 1, "deleted in Drive (the owner's \"not found\"): connections close, a tombstone, pending changes still kept", { gone, lifecycle: stats9?.lifecycle, pending: stats9?.pending });

// scene 3's own tab joins now (proofs last 15 minutes; this run is longer)
const v1 = await join(alice2, file5, "r-v1");

// --- 15 (round 2). font ids: a full namespace is refused, never a loop ---------------------------------------
const fontEvents = (from, count) => Array.from({ length: count }, (_, i) => ({ k: "font", id: `font${from + i}`, base: null, fontId: 2000 + ((from + i) % 7000), c: "f".repeat(24) }));
const fonts1 = await batch(v1, fontEvents(0, 5000));
const fonts2 = await batch(v1, fontEvents(5000, 2000));
const fonts3 = await batch(v1, fontEvents(7000, 1));
ok(fonts1?.type === "ack" && fonts2?.type === "ack" && fonts3?.reason === "font-id", "with every custom font id taken, another font is refused (font-id)", { f1: fonts1?.type, f2: fonts2?.type, f3: fonts3?.reason ?? fonts3?.type });

// --- 12 (round 2). budgets count everything stored, readable metadata too ----------------------------------
const heavy = (i) =>
  Array.from({ length: 100 }, (_, j) => rect(`H${i}_${j}`, `k${String(i).padStart(2, "0")}${String(j).padStart(3, "0")}`, { groupIds: Array.from({ length: 200 }, (_, g) => `g${g}`.padEnd(120, "x")) }));
let heavyRefused = null;
for (let i = 0; i < 12 && !heavyRefused; i++) {
  const answer = await batch(v1, await Promise.all(heavy(i).map((el) => elEvent(v1.scene, el, null))));
  if (answer?.type === "refused") heavyRefused = { i, answer };
}
ok(heavyRefused?.answer.reason === "limit" && heavyRefused.i < 10, "batches heavy in readable metadata (group ids) hit the pending budget", heavyRefused && { i: heavyRefused.i, detail: heavyRefused.answer.detail });
if (heavyRefused) v1.counter--;

// --- 16 (round 2). proofs that run out and connections that never say hello are closed by the sweep -----------
await dev(alice2, file5, "dev-expire", { tab: "r-v1", inMs: 1500 });
const expired = await v1.next((m) => m.type === "closed", 8000);
ok(expired?.reason === "access" || v1.closed?.reason === "access", "a connection whose proof ran out is closed without sending anything", expired ?? v1.closed);
await until(async () => (idle.closed ? true : null), Math.max(1000, 70000 - (Date.now() - idleOpenedAt)));
ok(idle.closed?.code === 4000, "a connection that never said hello is closed after a minute", { closed: idle.closed, after: Date.now() - idleOpenedAt });

// --- index repair: a deleted element's index is still taken ---------------------------------------------
const file6 = await createScene(alice2, "Indices", [rect("K", "a1"), { ...rect("DEL", "a1V"), isDeleted: true }, rect("L", "a2")]);
const w6 = await join(alice2, file6, "r-w6");
const ackN = await batch(w6, [await elEvent(w6.scene, rect("N", "a1"), null)]);
const nIndex = ackN?.repairs?.N;
ok(nIndex && nIndex !== "a1V" && nIndex > "a1" && nIndex < "a1V", "a repaired index never takes a deleted element's (between a1 and the deleted a1V)", ackN);
const ackM = await batch(w6, [await elEvent(w6.scene, rect("M", "a1V"), null)]);
ok(ackM?.repairs?.M && ackM.repairs.M !== "a1V", "a live element sent with a deleted element's index is repaired", ackM);
w6.ws.close();

// --- security review: M1 limits per account, M3 trash only on Drive's word, L1 forged webhooks, L3 key ids, L5 kinds ---
const file7 = await createScene(alice2, "Security", [rect("Q1", "a0")]);
await admin("/share", { fileId: file7, email: "carol@example.test", role: "reader" });
await admin("/grant", { fileId: file7, email: "carol@example.test" });
const carol3 = await login("carol@example.test");
const s7 = await join(alice2, file7, "r-s7");
const viewers = [];
const viewerTabs = [];
for (let i = 0; i < 6; i++) {
  const t = await ticketFor(carol3, file7);
  viewers.push(await openTab(carol3, file7, t.data, `r-cv${i}`).then((tab) => (viewerTabs.push(tab), "open"), () => "refused"));
}
viewerTabs[0].ws.send(JSON.stringify({ type: "part", id: "big1", i: 0, total: 96, data: "" }));
await viewerTabs[0].next(() => false, 1500);
ok(viewerTabs[0].closed?.code === 1008, "a viewer's multipart frame closes its connection (only editors send big messages)", viewerTabs[0].closed);
viewerTabs.forEach((tab) => tab.ws.close());
const unready = await openTab(carol3, file7, (await ticketFor(carol3, file7)).data, "r-cu");
unready.ws.send(JSON.stringify({ type: "part", id: "big2", i: 0, total: 96, data: "" }));
await unready.next(() => false, 1500);
ok(unready.closed?.code === 1008, "…and so does one from a connection that hasn't said hello", unready.closed);
await sleep(1000);
// #3: many at once, still at most 5
const tickets = await Promise.all(Array.from({ length: 9 }, () => ticketFor(carol3, file7)));
const burst = await Promise.all(tickets.map((t, i) => openTab(carol3, file7, t.data, `r-cb${i}`).then((tab) => tab, () => null)));
await sleep(1500);
const openNow = burst.filter((tab) => tab && !tab.closed);
ok(openNow.length <= 5, "nine connections at the same moment: at most five of one account stay open", openNow.length);
burst.forEach((tab) => tab?.ws.close());
ok(viewers.slice(0, 5).every((v) => v === "open") && viewers[5] === "refused", "one account gets at most 5 connections to a scene", viewers);
// M3: a tab's "trash" is only a hint
s7.send({ type: "trash" });
await sleep(2500);
ok((await dev(alice2, file7, "dev-stats")).data.lifecycle.state === "active", "a tab saying trash does not trash the scene while Drive doesn't", (await dev(alice2, file7, "dev-stats")).data.lifecycle);
// L1: a forged notification (wrong secret) never reaches the scene; an unknown scene gets no storage
const ch7 = await until(async () => (await admin("/channels")).channels.find((c) => c.file_id === file7) ?? null, 10000);
await fetch(`${B}/drive/notify`, {
  method: "POST",
  headers: { "X-Goog-Channel-ID": ch7.id, "X-Goog-Channel-Token": `${file7}.forged`, "X-Goog-Resource-ID": ch7.resource_id, "X-Goog-Resource-State": "trash" },
});
await sleep(1000);
ok((await dev(alice2, file7, "dev-stats")).data.lifecycle.state === "active", "a notification with a forged channel secret is dropped by the Worker");
const ghostId = "Ghost" + Math.random().toString(36).slice(2, 14);
await fetch(`${B}/drive/notify`, { method: "POST", headers: { "X-Goog-Channel-ID": "x", "X-Goog-Channel-Token": `${ghostId}.x`, "X-Goog-Resource-State": "update" } });
const ghost = (await dev(alice2, ghostId, "dev-stats")).data;
ok(ghost.unknown === true, "an unknown scene object writes nothing", ghost);
// L5: the kind is bound into the ciphertext: settings encrypted as an element's don't count
const wrongKind = { k: "set", id: "settings", base: baseOf(s7.welcome.state.events.find((e) => e.id === "settings") ?? { v: { v: 1, n: 1 } }), c: await encrypt(s7.scene, "settings", { viewBackgroundColor: "#000000" }, "el") };
const hasSettings = s7.welcome.state.events.find((e) => e.k === "set");
const ackKind = await batch(s7, [hasSettings ? { ...wrongKind, base: baseOf(hasSettings) } : { ...wrongKind, base: null }]);
ok(ackKind?.type === "ack", "settings encrypted under the wrong kind are accepted at first (the DO can't read them)", ackKind);
for (const t of [s7]) t.ws.close();
const kindStats = await until(async () => {
  const st = (await dev(alice2, file7, "dev-stats")).data;
  return st.pending === 0 ? st : null;
}, 25000);
const file7Content = await fileContent(alice2.token, file7);
ok(kindStats && /^invalid:/.test(kindStats.error ?? "") && file7Content.appState.viewBackgroundColor !== "#000000", "…and set aside at the save: they don't decrypt as settings", { error: kindStats?.error, bg: file7Content.appState.viewBackgroundColor });
// L3: a key property whose key id isn't its key's own is not a key
const file8 = await createScene(alice2, "Key check", [rect("K1", "a0")]);
const fakeKey = Buffer.alloc(32, 9).toString("base64");
await drive(alice2.token, `/files/${file8}?fields=id`, { method: "PATCH", json: { appProperties: { kurviqKey: `AAAAAAAAAAAA.${file8}.${fakeKey}` } } });
const t8 = await ticketFor(alice2, file8);
const prop8 = (await drive(alice2.token, `/files/${file8}?fields=appProperties`)).data.appProperties.kurviqKey;
ok(t8.data?.keyId && t8.data.keyId !== "AAAAAAAAAAAA" && prop8.startsWith(`${t8.data.keyId}.`), "a key property with a wrong key id is ignored (a real key is made)", { keyId: t8.data?.keyId, prop: prop8.slice(0, 20) });

// --- #1: receipts in a seed come from Drive, never from the seeding tab ---------------------------------
const file9 = await createScene(alice2, "Forged receipts", [rect("F1", "a0")]);
const ts9 = await ticketFor(alice2, file9);
const seeder = await openTab(alice2, file9, ts9.data, "r-seeder");
const ws9 = await hello(seeder);
const data9 = await fileContent(alice2.token, file9);
seeder.send({
  type: "seed",
  scene: { revision: ts9.data.head.revision, md5: ts9.data.head.md5, events: await Promise.all(data9.elements.map((el) => elEvent(seeder.scene, el, null))) },
  kurviq: { receipts: { "r-victim": { mark: 999, extra: [], at: Date.now() } }, authors: { F1: "pForged00000" } },
});
const seeded9 = await seeder.next((m) => m.type === "welcome", 10000);
ok(ws9?.mode === "seed" && seeded9, "a seed with a forged record is taken (its content)");
const victim = await openTab(alice2, file9, (await ticketFor(alice2, file9)).data, "r-victim");
const wv = await hello(victim);
ok(wv?.knownMark === 0 && !wv.receipts?.["r-victim"], "the forged receipt never reaches the tab's counters or the welcome", { knownMark: wv?.knownMark, receipts: wv?.receipts });
const ackVictim = await batch(victim, [await elEvent(victim.scene, rect("V1", "a5"), null)]);
ok(ackVictim?.type === "ack" && !ackVictim.duplicate, "the victim's batch 1 is stored, not taken for a duplicate", ackVictim);
seeder.ws.close();
victim.ws.close();
const saved9 = await until(async () => {
  const data = await fileContent(alice2.token, file9);
  return data.kurviq ? data : null;
}, 25000);
ok(saved9 && saved9.kurviq.authors.F1 !== "pForged00000", "the forged author attribution is not saved", saved9?.kurviq?.authors);

// --- #7: route bodies are bounded; the cookie is checked before a body is read ------------------------------
const bigBody = JSON.stringify({ tab: "x", pad: "y".repeat(200_000) });
/** a POST on a connection of its own: the server answers without reading such a body, which ends that connection */
const freshPost = (path, headers, body) =>
  new Promise((resolve) => {
    const req = http.request(`${B}${path}`, { method: "POST", agent: false, headers: { ...headers, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", () => resolve(0));
    req.end(body);
  });
// (wrangler's local runtime turns some answers sent before an upload ended into a 503; the edge answers as written)
const tooBig = await freshPost(`/scene/${file9}/renew`, { Origin: B, Cookie: alice2.cookie() }, bigBody);
ok(tooBig === 413 || tooBig === 503, "a 200 KB body to a scene route is refused (413), never parsed", tooBig);
const anonymous = await freshPost(`/scene/${file9}/renew`, { Origin: B }, bigBody);
ok(anonymous === 401 || anonymous === 503, "without a sign-in cookie it is refused (401), its body never parsed", anonymous);
const smallAnonymous = await fetch(`${B}/scene/${file9}/renew`, { method: "POST", headers: { Origin: B, "Content-Type": "application/json" }, body: "{}" });
ok(smallAnonymous.status === 401, "a small request without a cookie: 401", smallAnonymous.status);

// --- retention: everything kept per account has a bound, enforced by jobs ---------------------------------
// scene 2 holds tab rows, discarded batches (alice's arrow), sign-out marks (carol); age them past their bounds
const keptBefore = (await dev(alice2, file2, "dev-stats")).data.kept;
ok(keptBefore.tabs > 0 && keptBefore.forgotten > 0 && keptBefore.confirmed > 0, "before: tab rows, access times and a sign-out mark are kept", keptBefore);
ok(!(await dev(alice2, file2, "dev-stats")).data.metaKeys.includes("pseudonyms"), "no account → pseudonym map is stored");
await dev(alice2, file2, "dev-age", { ms: 31 * 24 * 3600_000, all: true });
const kept31 = (await dev(alice2, file2, "dev-stats")).data.kept;
ok(kept31.tabs === 0 && kept31.discarded === 0 && kept31.doneSaves === 0 && kept31.forgotten > 0 && kept31.confirmed === 0, "after 30 days: tab rows, discarded rows, finished save records and access times are gone; the sign-out mark stays", kept31);
// scene "Unshare": bob's change, blocked since he lost access; discarded 90 days later (nobody accepted it)
const pendingU = (await dev(alice2, file4, "dev-stats")).data;
ok(pendingU.pending >= 1 && Object.keys(pendingU.blocked).length === 1, "before: bob's blocked change is kept", { pending: pendingU.pending, blocked: pendingU.blocked });
ok(Object.values(pendingU.blocked).every((info) => info.reason === "access"), "he is blocked because he lost access (his changes can't be accepted, only discarded)", pendingU.blocked);
await dev(alice2, file4, "dev-age", { ms: 6 * 24 * 3600_000, all: true });
ok((await dev(alice2, file4, "dev-stats")).data.pending >= 1, "after 6 days it is still kept (editors see it and may discard it)");
await dev(alice2, file4, "dev-age", { ms: 2 * 24 * 3600_000, all: true });
const pending8 = (await dev(alice2, file4, "dev-stats")).data;
ok(pending8.pending === 0 && !Object.keys(pending8.blocked).length, "7 days after he lost access it is discarded (other reasons: 90 days)", { pending: pending8.pending, blocked: pending8.blocked });
await dev(alice2, file4, "dev-age", { ms: 31 * 24 * 3600_000, all: true });
ok((await dev(alice2, file4, "dev-stats")).data.kept.discarded === 0, "its discard record goes 30 days after the change was made");
await dev(alice2, file2, "dev-age", { ms: 370 * 24 * 3600_000, all: true });
const kept401 = (await dev(alice2, file2, "dev-stats")).data.kept;
ok(kept401.forgotten === 0, "after 400 days the sign-out mark is gone too", kept401);
const sched = (await dev(alice2, file2, "dev-stats")).data.schedule.map((job) => job.kind);
const left401 = (await dev(alice2, file2, "dev-stats")).data;
ok(sched.includes("retention") === left401.pending + left401.kept.tabs + left401.kept.discarded > 0 || sched.includes("trash-expire"), "the daily retention job stays planned only while something is left (here: the tombstone's change, deleted by trash-expire)", { sched, pending: left401.pending });
// the account guard: connected and token entries run out; the sign-out epoch after 400 days
const guardFresh = (await dev(alice2, file2, "dev-account-age", { ms: 0 })).data;
const guard2h = (await dev(alice2, file2, "dev-account-age", { ms: 2 * 3600_000 })).data;
ok(guard2h.connected === 0, "account guard: connected-scene entries run out an hour after the last renewal", { guardFresh, guard2h });
const guard6h = (await dev(alice2, file2, "dev-account-age", { ms: 4 * 3600_000 })).data;
ok(guard6h.scenes === 0, "account guard: stored-token entries run out 5 hours after the last one", guard6h);
const guardOld = (await dev(alice2, file2, "dev-account-age", { ms: 401 * 24 * 3600_000 })).data;
ok(guardOld.epoch === 0 && !guardOld.sub, "account guard: the sign-out epoch and the account id are gone after 400 days", guardOld);

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
