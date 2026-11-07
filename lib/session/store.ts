// In-memory session store. The demo runs as a single long-lived Node process
// (next start, or a Render web service), so memory is enough; the interface
// is small on purpose so it can move to Redis or Postgres later.
//
// Every mutation of a session goes through withLock(), which serializes work
// per session: a chat turn's tool calls, the customer's confirm click and the
// PayPal return can never interleave on the same session.

import { randomBytes, randomUUID } from "node:crypto";
import { emptyCart, emptyDetails } from "../cart";
import type { FeedItem, Session, TraceEntry } from "./types";

export const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
export const MAX_SESSIONS = 500;
const MAX_TRACE = 200;

export class SessionNotFoundError extends Error {
  constructor() {
    super("session not found");
    this.name = "SessionNotFoundError";
  }
}

export interface SessionStore {
  create(now?: number): Session;
  get(id: string): Session | undefined;
  /** Runs fn with exclusive access to the session. Throws SessionNotFoundError if it does not exist. */
  withLock<T>(id: string, fn: (s: Session) => Promise<T> | T): Promise<T>;
  findByOrderId(orderId: string): Session | undefined;
  all(): Session[];
  nextOrderNumber(): string;
}

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private orderCounter = 1000;

  constructor(private readonly clock: () => number = Date.now) {}

  create(now = this.clock()): Session {
    this.sweep(now);
    const s: Session = {
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      stage: "browsing",
      cart: emptyCart(),
      details: emptyDetails(),
      quotes: [],
      payments: [],
      history: [],
      feed: [],
      pendingEvents: [],
      trace: [],
      turns: 0,
      claudeCalls: 0,
      handoff: false,
      orderNumber: null,
    };
    this.sessions.set(s.id, s);
    return s;
  }

  get(id: string): Session | undefined {
    const s = this.sessions.get(id);
    if (s && this.clock() - s.updatedAt > SESSION_TTL_MS) {
      this.sessions.delete(id);
      return undefined;
    }
    return s;
  }

  async withLock<T>(id: string, fn: (s: Session) => Promise<T> | T): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((r) => (release = r));
    const chained = previous.then(() => current);
    this.locks.set(id, chained);
    await previous;
    try {
      const s = this.get(id);
      if (!s) throw new SessionNotFoundError();
      const result = await fn(s);
      s.updatedAt = this.clock();
      return result;
    } finally {
      release();
      if (this.locks.get(id) === chained) this.locks.delete(id);
    }
  }

  findByOrderId(orderId: string): Session | undefined {
    for (const s of this.sessions.values()) {
      if (s.payments.some((p) => p.orderId === orderId)) return s;
    }
    return undefined;
  }

  all(): Session[] {
    return [...this.sessions.values()];
  }

  nextOrderNumber(): string {
    this.orderCounter += 1;
    return `TC-${this.orderCounter}`;
  }

  /** Drops expired sessions and, past the cap, the oldest ones. */
  private sweep(now: number): void {
    for (const [id, s] of this.sessions) {
      if (now - s.updatedAt > SESSION_TTL_MS) this.sessions.delete(id);
    }
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.updatedAt - b.updatedAt);
      for (const s of oldest.slice(0, this.sessions.size - MAX_SESSIONS + 1)) this.sessions.delete(s.id);
    }
  }
}

// ─── Small helpers used by the agent and the checkout service ──────────────

export function shortId(prefix: string): string {
  // Crockford-ish base32 without look-alike characters.
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  const bytes = randomBytes(8);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `${prefix}-${out}`;
}

let feedCounter = 0;

/** Distributes Omit over the union, so each feed kind keeps its own fields. */
type NewFeedItem = FeedItem extends infer F ? (F extends FeedItem ? Omit<F, "id" | "at"> : never) : never;

export function pushFeed(s: Session, item: NewFeedItem, now = Date.now()): FeedItem {
  feedCounter += 1;
  const full = { ...item, id: `f${feedCounter}`, at: now } as FeedItem;
  s.feed.push(full);
  return full;
}

let traceCounter = 0;

export function pushTrace(s: Session, entry: Omit<TraceEntry, "id" | "at" | "turn">, now = Date.now()): void {
  traceCounter += 1;
  s.trace.push({ ...entry, id: `t${traceCounter}`, at: now, turn: s.turns });
  if (s.trace.length > MAX_TRACE) s.trace.splice(0, s.trace.length - MAX_TRACE);
}
