// The pen of one Drive scene, decided in memory (docs/relay/CONCEPT.md): who
// is connected, who holds the pen (the one person who may edit), who asks
// for it. Pure logic without sockets or timers, so the relay object
// (./relay.ts) and the tests drive it the same way: every call returns the
// messages to send. Calls come one at a time, so of two claims exactly one
// wins.
//
// Payloads (scene changes, catch-up, pointers, commenters' operations) are
// end-to-end encrypted by the tabs: they are forwarded as they are, never
// read. Nothing here is ever written anywhere.

export type RelayRole = "edit" | "comment" | "read";

/** what the Worker checked and sealed into the ticket (never what a tab claims) */
export type RelayClaims = {
  /** the person's display name */
  name: string;
  /** their color (pointers, the bar) */
  color: string;
  role: RelayRole;
  /** the same account in several tabs (sceneComments.mjs authorKey of the email) */
  who: string;
  /** their email: comments made through the holder's tab are recorded on their behalf */
  email?: string;
};

type Person = RelayClaims & { id: string; seenAt: number };

export type Out = { to: string; msg: Record<string, unknown> };

/** the holder idle this long: others may take the pen over */
export const IDLE_TAKEOVER_MS = 5 * 60_000;
/** no sign of life this long: the participant is gone */
export const SILENT_DROP_MS = 2 * 60_000;
/** the most people on one scene (and tabs of one account) */
export const MAX_PEOPLE = 50;
export const MAX_TABS_PER_ACCOUNT = 10;
/** one forwarded message (the tabs split bigger payloads into parts) */
export const MAX_BODY = 900_000;

/** payload kinds only the holder sends (to everyone, or to one tab with `to`) */
const HOLDER_KINDS = new Set(["change", "catchup", "saved", "key", "result"]);
/** payload kinds everyone sends, to the holder */
const TO_HOLDER_KINDS = new Set(["catchup-req"]);

const REQ_RE = /^[\w-]{1,64}$/;

const publicOf = (person: Person) => ({ id: person.id, name: person.name, color: person.color, role: person.role });

export class RelayRoom {
  private readonly people = new Map<string, Person>();
  private holder: string | null = null;
  private holderActiveAt = 0;
  private readonly asking = new Set<string>();
  /** the idle flag last announced (a change is announced by the sweep) */
  private idleShown = false;

  get size() {
    return this.people.size;
  }

  holderId() {
    return this.holder;
  }

  /** a new connection; null: refused (too many) */
  join(id: string, claims: RelayClaims, now: number): Out[] | null {
    if (this.people.size >= MAX_PEOPLE || [...this.people.values()].filter((person) => person.who === claims.who).length >= MAX_TABS_PER_ACCOUNT) {
      return null;
    }
    this.people.set(id, { ...claims, id, seenAt: now });
    return [{ to: id, msg: { t: "welcome", you: id, role: claims.role } }, ...this.stateToAll(now)];
  }

  /** a connection closed (or was dropped): a holder leaving frees the pen at once */
  leave(id: string, now: number): Out[] {
    if (!this.people.delete(id)) {
      return [];
    }
    this.asking.delete(id);
    if (this.holder === id) {
      this.holder = null;
    }
    return this.stateToAll(now);
  }

  /** the participants silent for 2 minutes (the caller closes their sockets and calls leave) */
  silent(now: number) {
    return [...this.people.values()].filter((person) => now - person.seenAt >= SILENT_DROP_MS).map((person) => person.id);
  }

  /** the holder became idle (or active again) since the last announcement: everyone hears */
  sweep(now: number): Out[] {
    return this.idle(now) === this.idleShown ? [] : this.stateToAll(now);
  }

  receive(id: string, msg: any, now: number): Out[] {
    const person = this.people.get(id);
    if (!person || !msg || typeof msg !== "object") {
      return [];
    }
    person.seenAt = now;
    switch (msg.t) {
      case "ping":
        return [{ to: id, msg: { t: "pong" } }];
      case "claim":
        return this.claim(person, now);
      case "ask":
        return this.ask(person, now);
      case "decline":
        return this.decline(person, msg.to);
      case "handover":
        return this.handover(person, msg.to, now);
      case "takeover":
        return this.takeover(person, now);
      case "release":
        return this.release(person, now);
      case "active":
        return this.active(person, now);
      case "send":
        return this.forward(person, msg);
      default:
        return [{ to: id, msg: { t: "error", error: "unknown message" } }];
    }
  }

  private idle(now: number) {
    return this.holder !== null && now - this.holderActiveAt >= IDLE_TAKEOVER_MS;
  }

  private stateMsg(now: number) {
    const holder = this.holder ? this.people.get(this.holder) : undefined;
    return {
      t: "state",
      holder: holder ? { id: holder.id, name: holder.name, color: holder.color, who: holder.who } : null,
      idle: this.idle(now),
      people: [...this.people.values()].map(publicOf),
      asking: [...this.asking],
    };
  }

  private stateToAll(now: number): Out[] {
    this.idleShown = this.idle(now);
    const msg = this.stateMsg(now);
    return [...this.people.keys()].map((to) => ({ to, msg }));
  }

  private refuse(person: Person, action: string, why: string): Out[] {
    return [{ to: person.id, msg: { t: "refused", action, why } }];
  }

  private claim(person: Person, now: number): Out[] {
    if (person.role !== "edit") {
      return this.refuse(person, "claim", "not-editor");
    }
    if (this.holder === person.id) {
      return [];
    }
    if (this.holder !== null) {
      return this.refuse(person, "claim", "held");
    }
    return this.give(person, now);
  }

  private give(person: Person, now: number): Out[] {
    this.holder = person.id;
    this.holderActiveAt = now;
    this.asking.delete(person.id);
    return this.stateToAll(now);
  }

  private ask(person: Person, now: number): Out[] {
    if (person.role !== "edit") {
      return this.refuse(person, "ask", "not-editor");
    }
    if (this.holder === null) {
      return this.give(person, now);
    }
    if (this.holder === person.id) {
      return [];
    }
    this.asking.add(person.id);
    return [{ to: this.holder, msg: { t: "asked", by: publicOf(person) } }, ...this.stateToAll(now)];
  }

  private decline(person: Person, to: unknown): Out[] {
    if (this.holder !== person.id || typeof to !== "string" || !this.asking.delete(to)) {
      return [];
    }
    return [{ to, msg: { t: "declined", by: person.name } }];
  }

  /** the holder saved (its tab did, before sending this) and hands the pen to someone who may edit */
  private handover(person: Person, to: unknown, now: number): Out[] {
    const next = typeof to === "string" ? this.people.get(to) : undefined;
    if (this.holder !== person.id || !next || next.role !== "edit" || next.id === person.id) {
      return this.refuse(person, "handover", "not-possible");
    }
    return [{ to: next.id, msg: { t: "granted", from: person.name } }, ...this.give(next, now)];
  }

  /** allowed when nobody holds the pen, the holder is idle 5 minutes, or it is the same account's other tab */
  private takeover(person: Person, now: number): Out[] {
    if (person.role !== "edit") {
      return this.refuse(person, "takeover", "not-editor");
    }
    const previous = this.holder ? this.people.get(this.holder) : undefined;
    if (previous?.id === person.id) {
      return [];
    }
    if (previous && !this.idle(now) && previous.who !== person.who) {
      return this.refuse(person, "takeover", "not-idle");
    }
    const out = this.give(person, now);
    return previous ? [{ to: previous.id, msg: { t: "taken", by: person.name } }, ...out] : out;
  }

  private release(person: Person, now: number): Out[] {
    if (this.holder !== person.id) {
      return [];
    }
    this.holder = null;
    return this.stateToAll(now);
  }

  private active(person: Person, now: number): Out[] {
    if (this.holder !== person.id) {
      return [];
    }
    this.holderActiveAt = now;
    return this.sweep(now);
  }

  /** an encrypted payload, forwarded as it is with the sender's checked identity */
  private forward(person: Person, msg: any): Out[] {
    const { kind, body } = msg;
    if (typeof kind !== "string" || typeof body !== "string" || body.length > MAX_BODY) {
      return this.refuse(person, "send", "bad-message");
    }
    const req = typeof msg.req === "string" && REQ_RE.test(msg.req) ? msg.req : undefined;
    const part = Number.isSafeInteger(msg.part) && Number.isSafeInteger(msg.parts) ? { part: msg.part, parts: msg.parts } : {};
    const from: Record<string, unknown> = publicOf(person);
    const out = (to: string): Out => ({ to, msg: { t: "msg", kind, from, body, ...(req ? { req } : {}), ...part } });
    if (HOLDER_KINDS.has(kind)) {
      return this.fromHolder(person, msg.to, out);
    }
    if (kind === "pointer") {
      return this.others(person.id).map(out);
    }
    if (TO_HOLDER_KINDS.has(kind) || kind === "ops") {
      return this.toHolder(person, kind, out, from, req);
    }
    return this.refuse(person, "send", "bad-kind");
  }

  /** the holder's payloads: to one tab (`to`), or to everyone else */
  private fromHolder(person: Person, to: unknown, out: (to: string) => Out): Out[] {
    if (this.holder !== person.id) {
      return this.refuse(person, "send", "not-holder");
    }
    if (typeof to === "string") {
      return this.people.has(to) ? [out(to)] : [];
    }
    return this.others(person.id).map(out);
  }

  private toHolder(person: Person, kind: string, out: (to: string) => Out, from: Record<string, unknown>, req: string | undefined): Out[] {
    if (kind === "ops") {
      if (person.role === "read") {
        return this.refuse(person, "send", "not-commenter");
      }
      // the holder records the comments on their behalf: who they are comes from the ticket
      from.key = person.who;
      if (person.email) {
        from.email = person.email;
      }
    }
    if (this.holder === null || this.holder === person.id) {
      return [{ to: person.id, msg: { t: "no-editor", kind, ...(req ? { req } : {}) } }];
    }
    return [out(this.holder)];
  }

  private others(id: string) {
    return [...this.people.keys()].filter((to) => to !== id);
  }
}
