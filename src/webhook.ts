import { verifyWebhookSignature } from "mailtrap";
import type { Ledger } from "./ledger.js";

export const WEBHOOK_PATH = "/mailtrap/webhook";
export const WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
export const SIGNATURE_HEADER = "mailtrap-signature";

export interface WebhookTarget {
  accountId: string;
  inboxId: number;
  ledger: Ledger;
}

export interface WebhookResult {
  status: number;
  body: string;
  /** True when at least one new message id was persisted and the caller should start draining. */
  enqueued: boolean;
}

interface WebhookEvent {
  event?: unknown;
  event_id?: unknown;
  inbox_id?: unknown;
  message_id?: unknown;
}

/** Full URL Mailtrap should call for an account: `<public base>/mailtrap/webhook/<accountId>`. */
export function webhookUrlFor(publicUrl: string, accountId: string): string {
  const u = new URL(publicUrl);
  if (u.protocol !== "https:") throw new Error("the webhook URL must be https");
  if (u.pathname.replace(/\/+$/, "").includes(WEBHOOK_PATH)) return u.toString();
  u.pathname = `${u.pathname.replace(/\/+$/, "")}${WEBHOOK_PATH}/${accountId}`;
  return u.toString();
}

/** Account id from a request path such as `/mailtrap/webhook/support`; `default` without a suffix. */
export function accountIdFromPath(pathname: string): string {
  const rest = pathname.startsWith(WEBHOOK_PATH) ? pathname.slice(WEBHOOK_PATH.length) : "";
  const id = decodeURIComponent(rest.replace(/^\/+|\/+$/g, "")).toLowerCase();
  return id === "" ? "default" : id;
}

/**
 * Webhook ingress: verify the signature over the raw body,
 * persist each message id in the ledger, answer 200. The message itself is
 * fetched and processed later by the account runtime, never in this request.
 * A forged or unsigned request changes nothing.
 */
export async function handleWebhook(rawBody: string, signature: string | undefined, target: WebhookTarget | undefined): Promise<WebhookResult> {
  if (!target) return { status: 503, body: "account not running", enqueued: false };
  const hook = await target.ledger.getWebhook();
  if (!hook) return { status: 404, body: "webhook not enabled", enqueued: false };
  if (!signature || !verifyWebhookSignature(rawBody, signature, hook.secret)) {
    return { status: 401, body: "bad signature", enqueued: false };
  }
  let payload: { events?: unknown };
  try {
    payload = JSON.parse(rawBody) as { events?: unknown };
  } catch {
    return { status: 400, body: "invalid json", enqueued: false };
  }
  const events = Array.isArray(payload.events) ? (payload.events as WebhookEvent[]) : [];
  let enqueued = false;
  for (const e of events) {
    if (e.event !== "inbound.message_received" || typeof e.message_id !== "string" || e.message_id === "") continue;
    if (e.inbox_id !== undefined && Number(e.inbox_id) !== target.inboxId) continue;
    if (await target.ledger.enqueue(e.message_id, "webhook")) enqueued = true;
  }
  return { status: 200, body: "ok", enqueued };
}
