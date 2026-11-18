// Shapes of the Mailtrap Inbound API that the channel uses, and the ports the
// channel core depends on. The core never imports the Mailtrap SDK or the
// OpenClaw SDK directly; src/mailtrap-api.ts and src/openclaw-host.ts adapt
// them, which keeps every behaviour testable without a network.

export interface InboundAttachment {
  attachment_id: string;
  size: number | null;
  filename: string | null;
  content_type: string | null;
  content_disposition: "attachment" | "inline" | null;
  content_id: string | null;
  download_url?: string | null;
  download_url_expires_at?: string | null;
}

export interface InboundMessage {
  id: string;
  inbox_id: number;
  from: string | null;
  to: string[];
  cc: string[];
  reply_to: string | null;
  subject: string | null;
  rfc_message_id: string | null;
  in_reply_to: string | null;
  references: string[];
  received_at: string;
  thread_id: string | null;
  attachments: InboundAttachment[];
  text_body?: string | null;
  html_body?: string | null;
  raw_message_url?: string | null;
  raw_message_expires_at?: string | null;
}

export interface MessagesPage {
  data: InboundMessage[];
  total_count: number;
  last_id: string | null;
}

export interface ThreadMessage {
  id: string;
  direction: "inbound" | "outbound";
  rfc_message_id: string | null;
  in_reply_to: string | null;
  created_at: string;
}

export interface InboundThread {
  id: string;
  messages: ThreadMessage[];
}

export interface InboxInfo {
  id: number;
  name: string;
  address: string;
}

export interface ReplyAttachment {
  content: string; // base64
  filename: string;
  type?: string;
  disposition?: "attachment" | "inline";
  content_id?: string;
}

export interface ReplyParams {
  from?: { email: string; name?: string };
  text?: string;
  html?: string;
  attachments?: ReplyAttachment[];
}

export interface WebhookInfo {
  id: number;
  url: string;
  active: boolean;
  webhook_type: string;
  inbound_inbox_id?: number | null;
}

/** Everything the channel needs from Mailtrap. Only `reply` ever sends mail. */
export interface InboundApi {
  getInbox(inboxId: number): Promise<InboxInfo>;
  listMessages(inboxId: number, lastId?: string): Promise<MessagesPage>;
  getMessage(inboxId: number, messageId: string): Promise<InboundMessage>;
  getThread(inboxId: number, threadId: string): Promise<InboundThread>;
  reply(inboxId: number, messageId: string, params: ReplyParams): Promise<{ message_ids: string[] }>;
}

/** Webhook management; needs the broad account token, so it is never part of the channel runtime. */
export interface WebhookAdmin {
  list(): Promise<WebhookInfo[]>;
  create(params: { url: string; inboxId: number }): Promise<WebhookInfo & { signing_secret: string }>;
  update(id: number, params: { url: string }): Promise<WebhookInfo>;
  delete(id: number): Promise<void>;
}

/** Plugin-scoped durable key-value store (api.runtime.state.openKeyedStoreV2). */
export interface KeyedStore<T> {
  register(key: string, value: T): Promise<void>;
  registerIfAbsent(key: string, value: T): Promise<boolean>;
  lookup(key: string): Promise<T | undefined>;
  delete(key: string): Promise<void>;
  entries(): Promise<Array<{ key: string; value: T }>>;
}

export type OpenStore = <T>(namespace: string, opts: { ttlMs?: number }) => KeyedStore<T>;

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
