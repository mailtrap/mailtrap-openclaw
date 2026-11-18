import type { InboundApi, InboundMessage, InboundThread, KeyedStore, MessagesPage, OpenStore, ReplyParams } from "../../src/types.js";

export class MemoryStore<T> implements KeyedStore<T> {
  data = new Map<string, T>();
  async register(key: string, value: T) {
    this.data.set(key, structuredClone(value));
  }
  async registerIfAbsent(key: string, value: T) {
    if (this.data.has(key)) return false;
    this.data.set(key, structuredClone(value));
    return true;
  }
  async lookup(key: string) {
    const v = this.data.get(key);
    return v === undefined ? undefined : structuredClone(v);
  }
  async delete(key: string) {
    this.data.delete(key);
  }
  async entries() {
    return [...this.data.entries()].map(([key, value]) => ({ key, value: structuredClone(value) }));
  }
}

/** Stores survive "restarts": reopening a namespace returns the same data. */
export function memoryOpenStore(): OpenStore & { stores: Map<string, MemoryStore<unknown>> } {
  const stores = new Map<string, MemoryStore<unknown>>();
  const open = (<T>(ns: string) => {
    if (!stores.has(ns)) stores.set(ns, new MemoryStore<unknown>());
    return stores.get(ns) as unknown as MemoryStore<T>;
  }) as OpenStore & { stores: Map<string, MemoryStore<unknown>> };
  open.stores = stores;
  return open;
}

let counter = 1_000;
export function makeMessage(over: Partial<InboundMessage> = {}): InboundMessage {
  const n = ++counter;
  return {
    id: String(1_000_000_000_000_000_000n + BigInt(n)),
    inbox_id: 1001,
    from: "Alex Example <alex@example.test>",
    to: ["agent-test@inbound-mailtrap.io"],
    cc: [],
    reply_to: null,
    subject: "Hello",
    rfc_message_id: `<synthetic-${n}@mail.example.test>`,
    in_reply_to: null,
    references: [],
    received_at: new Date(Date.UTC(2026, 10, 9, 12, 0, 0) + n * 1000).toISOString(),
    thread_id: `thread-${n}`,
    attachments: [],
    text_body: "What time is it?",
    html_body: null,
    raw_message_url: "https://raw.example.test/redacted",
    raw_message_expires_at: new Date(Date.UTC(2026, 10, 9, 13, 0, 0)).toISOString(),
    ...over
  };
}

/** A scriptable in-memory Mailtrap Inbound. `reply` is the only call that "sends". */
export class FakeInbound implements InboundApi {
  messages: InboundMessage[] = [];
  threads = new Map<string, InboundThread>();
  replies: Array<{ messageId: string; params: ReplyParams }> = [];
  calls: string[] = [];
  inbox = { id: 1001, name: "t", address: "agent-test@inbound-mailtrap.io" };
  replyImpl: ((messageId: string, params: ReplyParams) => Promise<{ message_ids: string[] }>) | undefined;
  getThreadImpl: ((threadId: string) => Promise<InboundThread>) | undefined;
  getMessageImpl: ((id: string) => Promise<InboundMessage>) | undefined;
  pageSize = 100;

  add(m: InboundMessage) {
    this.messages.push(m);
    return m;
  }
  async getInbox() {
    this.calls.push("getInbox");
    return this.inbox;
  }
  async listMessages(_inbox: number, lastId?: string): Promise<MessagesPage> {
    this.calls.push(`list:${lastId ?? ""}`);
    const sorted = [...this.messages].reverse(); // newest first = most recently added first
    const start = lastId ? sorted.findIndex((m) => m.id === lastId) + 1 : 0;
    const page = sorted.slice(start, start + this.pageSize);
    return { data: page, total_count: sorted.length, last_id: page.length ? page[page.length - 1]!.id : null };
  }
  async getMessage(_inbox: number, id: string) {
    this.calls.push(`get:${id}`);
    if (this.getMessageImpl) return this.getMessageImpl(id);
    const m = this.messages.find((x) => x.id === id);
    if (!m) throw Object.assign(new Error("not found"), { statusCode: 404 });
    return structuredClone(m);
  }
  async getThread(_inbox: number, threadId: string) {
    this.calls.push(`thread:${threadId}`);
    if (this.getThreadImpl) return this.getThreadImpl(threadId);
    const t = this.threads.get(threadId);
    if (!t) throw Object.assign(new Error("not found"), { statusCode: 404 });
    return structuredClone(t);
  }
  async reply(_inbox: number, messageId: string, params: ReplyParams) {
    this.calls.push(`reply:${messageId}`);
    if (this.replyImpl) return this.replyImpl(messageId, params);
    this.replies.push({ messageId, params });
    return { message_ids: [`00000000-0000-4000-8000-${String(this.replies.length).padStart(12, "0")}`] };
  }
}
