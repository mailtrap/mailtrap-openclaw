import { isAllowed, parseAddress, type ParsedAddress } from "./address.js";
import type { InboundMessage } from "./types.js";

/** `transient`: the check could not run (network, DNS); the message is retried instead of dropped. */
export type AuthResult = { ok: true } | { ok: false; reason: string; transient?: boolean };

/** Layer 2 (DKIM). Injected so tests and the allowUnauthenticated switch can replace it. */
export type Authenticator = (message: InboundMessage, sender: ParsedAddress) => Promise<AuthResult>;

export type SenderVerdict = { ok: true; sender: ParsedAddress } | { ok: false; reason: string; transient?: boolean };

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
  return { ok: true, sender };
}
