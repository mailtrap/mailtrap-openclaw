import type { KeyedStore, OpenStore } from "./types.js";

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Item lifecycle:
 *   queued -> processing -> sending -> done
 *                 \-> dropped (sender check failed, own mail, nothing to say)
 *   processing -> failed (session busy too long, agent turn failed, reply too large)
 *   sending -> failed (reply refused permanently, or retries exhausted)
 * `sending` is written before `reply` is called; it is what crash recovery looks for.
 */
export type ItemState = "queued" | "processing" | "sending" | "done" | "dropped" | "failed";

export interface PendingReply {
  text: string;
  media: Array<{ path: string; filename: string; type?: string }>;
}

export interface LedgerItem {
  id: string;
  state: ItemState;
  source: "poll" | "webhook";
  enqueuedAt: number;
  updatedAt: number;
  attempts: number;
  reason?: string;
  threadId?: string | null;
  inboundRfcId?: string | null;
  inboundReceivedAt?: string;
  conversationKey?: string;
  reply?: PendingReply;
  sendStartedAt?: number;
  sendAttempts?: number;
  /** Failed agent turns, and the time before which the next one must not start. */
  authAttempts?: number;
  turnAttempts?: number;
  /** Dispatches that ran no turn (session busy), and when the first one happened; bounded by a time window, not the paid-turn cap. */
  notRunAttempts?: number;
  notRunSince?: number;
  /** Agent dispatches started for this item; written before each one, so a crash mid-turn is counted. */
  dispatchAttempts?: number;
  retryAt?: number;
  sentMessageIds?: string[];
}

export interface AttachmentNote {
  filename: string;
  reason: string;
}

/** Newest message seen when the cursor last moved. Ids are opaque, so recency is judged by received_at. */
export interface Cursor {
  id: string;
  receivedAt: string;
}

export const EPOCH_CURSOR: Cursor = { id: "", receivedAt: "1970-01-01T00:00:00.000Z" };

const CURSOR = "cursor";
const WEBHOOK = "webhook";

/** Compare numeric-string ids (Mailtrap ids are 19-digit decimals) without float loss. */
export function compareIds(a: string, b: string): number {
  try {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  } catch {
    return a < b ? -1 : a > b ? 1 : 0;
  }
}

/**
 * The durable per-account ledger. Items and session links expire (a week and a
 * month); the cursor and the webhook secret live in a retained namespace that
 * never expires.
 */
export class Ledger {
  private items: KeyedStore<LedgerItem>;
  private sessions: KeyedStore<string>;
  private meta: KeyedStore<unknown>;

  constructor(openStore: OpenStore, accountId: string, private now: () => number = Date.now) {
    this.items = openStore<LedgerItem>(`items-${accountId}`, { ttlMs: WEEK_MS });
    this.sessions = openStore<string>(`sessions-${accountId}`, { ttlMs: SESSION_TTL_MS });
    this.meta = openStore<unknown>(`meta-${accountId}`, {});
  }

  /** Atomically records a message id; false when it is already known. */
  async enqueue(id: string, source: "poll" | "webhook"): Promise<boolean> {
    const t = this.now();
    return this.items.registerIfAbsent(`m:${id}`, { id, state: "queued", source, enqueuedAt: t, updatedAt: t, attempts: 0 });
  }

  async get(id: string): Promise<LedgerItem | undefined> {
    return this.items.lookup(`m:${id}`);
  }

  async update(id: string, patch: Partial<LedgerItem>): Promise<LedgerItem> {
    const cur = await this.get(id);
    if (!cur) throw new Error(`ledger item ${id} not found`);
    const next: LedgerItem = { ...cur, ...patch, id, updatedAt: this.now() };
    await this.items.register(`m:${id}`, next);
    return next;
  }

  async inStates(...states: ItemState[]): Promise<LedgerItem[]> {
    const all = await this.items.entries();
    return all
      .map((e) => e.value)
      .filter((v) => states.includes(v.state))
      .sort((a, b) => a.enqueuedAt - b.enqueuedAt || compareIds(a.id, b.id));
  }

  async getCursor(): Promise<Cursor | undefined> {
    return (await this.meta.lookup(CURSOR)) as Cursor | undefined;
  }

  async setCursor(cursor: Cursor): Promise<void> {
    await this.meta.register(CURSOR, cursor);
  }

  /** Records a message the channel must never answer (it was in the inbox before the first start). */
  async enqueueIgnored(id: string, reason: string): Promise<void> {
    const t = this.now();
    await this.items.registerIfAbsent(`m:${id}`, { id, state: "dropped", reason, source: "poll", enqueuedAt: t, updatedAt: t, attempts: 0 });
  }

  async getWebhook(): Promise<{ secret: string; id?: number; url?: string } | undefined> {
    const v = (await this.meta.lookup(WEBHOOK)) as { secret: string; id?: number; url?: string } | undefined;
    return v?.secret ? v : undefined;
  }

  async setWebhook(value: { secret: string; id?: number; url?: string }): Promise<void> {
    await this.meta.register(WEBHOOK, value);
  }

  async clearWebhook(): Promise<void> {
    await this.meta.delete(WEBHOOK);
  }

  /** Links RFC Message-IDs and Mailtrap thread ids to a conversation key. */
  async linkConversation(conversationKey: string, refs: Array<string | null | undefined>): Promise<void> {
    for (const ref of refs) {
      if (ref) await this.sessions.register(normalizeRef(ref), conversationKey);
    }
  }

  async findConversation(refs: Array<string | null | undefined>): Promise<string | undefined> {
    for (const ref of refs) {
      if (!ref) continue;
      const hit = await this.sessions.lookup(normalizeRef(ref));
      if (hit) return hit;
    }
    return undefined;
  }
}

export function normalizeRef(ref: string): string {
  return ref.trim();
}

export function threadRef(threadId: string): string {
  return `thread:${threadId}`;
}
