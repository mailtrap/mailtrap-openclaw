import { isAllowed, parseAddress, type ParsedAddress } from "./address.js";
import type { InboundMessage } from "./types.js";

/** Top-level message headers: lowercase names, unfolded values, every occurrence of a repeated header. */
export type MessageHeaders = Record<string, string[]>;

/**
 * `transient`: the check could not run (network, DNS); the message is retried instead of dropped.
 * `headers`: the message's headers, as the check read them; the automatic-mail guard runs on them.
 */
export type AuthResult = { ok: true; headers: MessageHeaders } | { ok: false; reason: string; transient?: boolean };

/** Layer 2 (DKIM). Injected so tests and the allowUnauthenticated switch can replace it. */
export type Authenticator = (message: InboundMessage, sender: ParsedAddress) => Promise<AuthResult>;

export type SenderVerdict = { ok: true; sender: ParsedAddress; headers: MessageHeaders } | { ok: false; reason: string; transient?: boolean };

/**
 * A message must pass both layers: the allowlist, then DKIM
 * aligned with the From domain. The first failure drops the message; nothing
 * is replied or bounced.
 */
export async function checkSender(
  message: InboundMessage,
  allowFrom: readonly string[],
  authenticate: Authenticator
): Promise<SenderVerdict> {
  const sender = parseAddress(message.from);
  if (!sender) return { ok: false, reason: "no-sender-address" };
  if (!isAllowed(sender.email, allowFrom)) return { ok: false, reason: "not-allowlisted" };
  const auth = await authenticate(message, sender);
  if (!auth.ok) return { ok: false, reason: auth.reason, ...(auth.transient ? { transient: true } : {}) };
  return { ok: true, sender, headers: auth.headers };
}

/** The first token of a header value, lowercased: RFC 5322 comments removed, cut at `;`, whitespace or a line break. */
function firstToken(value: string): string {
  let v = value;
  let prev: string;
  do {
    prev = v;
    v = v.replace(/\([^()]*\)/g, " ");
  } while (v !== prev);
  return v.trim().split(/[;\s]/)[0]!.toLowerCase();
}

/**
 * Mail that must not get an automatic answer (RFC 3834): `Auto-Submitted` other than `no`,
 * `Precedence: bulk|junk|list`, or an `X-Autoreply` / `X-Autorespond` header. Answering an
 * out-of-office or another agent would start a reply loop.
 */
export function isAutomatic(headers: MessageHeaders | undefined): boolean {
  if (!headers) return false;
  const values = (name: string) => (headers[name] ?? []).map(firstToken);
  if (values("auto-submitted").some((v) => v !== "no")) return true;
  if (values("precedence").some((v) => v === "bulk" || v === "junk" || v === "list")) return true;
  return headers["x-autoreply"] !== undefined || headers["x-autorespond"] !== undefined;
}
