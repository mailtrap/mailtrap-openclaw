import { dkimVerify } from "mailauth";
import { getAlignment } from "mailauth/lib/tools";
import { httpStatus } from "./http-status.js";
import { domainOf, parseAddress } from "./address.js";
import type { Authenticator } from "./sender-check.js";
import type { InboundApi, InboundMessage } from "./types.js";

export type DnsResolver = (name: string, rr: string) => Promise<unknown>;
export type RawFetcher = (url: string) => Promise<Buffer>;

export const MAX_RAW_BYTES = 40 * 1024 * 1024;
/** Deadline for the whole raw download, body included, so a stalled server can't block the drain. */
export const RAW_DOWNLOAD_TIMEOUT_MS = 120_000;
/** Re-get the message for a fresh URL when the old one expires within this window. */
const EXPIRY_SLACK_MS = 60_000;

export interface DkimDeps {
  api: InboundApi;
  inboxId: number;
  fetchRaw?: RawFetcher;
  resolver?: DnsResolver;
  now?: () => number;
}

/** Downloads the raw message with a deadline and a streamed size cap. Only https URLs are accepted. */
export const defaultFetchRaw: RawFetcher = async (url) => {
  if (!url.startsWith("https://")) throw new Error("raw message URL is not https");
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(RAW_DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw Object.assign(new Error(`raw message download failed: ${res.status}`), { statusCode: res.status });
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_RAW_BYTES) throw new Error("raw message too large");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > MAX_RAW_BYTES) throw new Error("raw message too large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

/**
 * Network failures, 5xx, 408 and 429 mean the download may work later. A refused
 * URL (403/404/410 even after a refresh), a non-https URL or an oversize file will not.
 */
function isTransientDownloadError(err: unknown): boolean {
  const code = (err as { statusCode?: number }).statusCode;
  if (typeof code === "number") return code >= 500 || code === 408 || code === 429;
  const status = httpStatus(err);
  if (status !== undefined) return status >= 500 || status === 408 || status === 429;
  const msg = err instanceof Error ? err.message : "";
  return !/not https|too large|no raw message URL/.test(msg);
}

function isExpired(msg: InboundMessage, now: number): boolean {
  if (!msg.raw_message_url) return true;
  if (!msg.raw_message_expires_at) return false;
  return Date.parse(msg.raw_message_expires_at) - now < EXPIRY_SLACK_MS;
}

/**
 * Layer 2 of the sender check. Mailtrap Inbound exposes no
 * Authentication-Results, so the plugin verifies the sender's DKIM signature
 * itself from the raw message. It requires a passing signature whose
 * signing domain is aligned (relaxed: same organizational domain) with the
 * From domain, and a raw From that matches the sender the API reported.
 */
export function createDkimAuthenticator(deps: DkimDeps): Authenticator {
  const fetchRaw = deps.fetchRaw ?? defaultFetchRaw;
  const now = deps.now ?? Date.now;

  async function download(message: InboundMessage): Promise<Buffer> {
    let current = message;
    // The URL lives about an hour; ask the API for a fresh one when it is
    // missing, expired or about to expire, and once more if the download is refused.
    if (isExpired(current, now())) current = await deps.api.getMessage(deps.inboxId, message.id);
    if (!current.raw_message_url) throw new Error("no raw message URL");
    try {
      return await fetchRaw(current.raw_message_url);
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      if (code !== 403 && code !== 404 && code !== 410) throw err;
      const fresh = await deps.api.getMessage(deps.inboxId, message.id);
      if (!fresh.raw_message_url || fresh.raw_message_url === current.raw_message_url) throw err;
      return fetchRaw(fresh.raw_message_url);
    }
  }

  return async (message, sender) => {
    let raw: Buffer;
    try {
      raw = await download(message);
    } catch (err) {
      return { ok: false, reason: "dkim-raw-unavailable", ...(isTransientDownloadError(err) ? { transient: true } : {}) };
    }

    let result;
    try {
      result = await dkimVerify(raw, deps.resolver ? { resolver: deps.resolver as never } : {});
    } catch {
      return { ok: false, reason: "dkim-error" };
    }

    if (result.fromFields !== 1 || !result.headerFrom?.length) return { ok: false, reason: "dkim-bad-from" };
    const rawFrom = parseAddress(result.headerFrom[0]);
    if (!rawFrom || rawFrom.email !== sender.email) return { ok: false, reason: "dkim-from-mismatch" };

    const fromDomain = domainOf(sender.email);
    const passes = result.results.filter((r) => r.status?.result === "pass" && !(r.status as { underSized?: unknown }).underSized && typeof r.signingDomain === "string");
    // Relaxed alignment: the signing domain and the From domain share an organizational domain.
    if (passes.some((r) => getAlignment(fromDomain, r.signingDomain as string, false))) return { ok: true };
    // DNS lookups that failed temporarily (SERVFAIL, timeout) come back as `temperror`: that check did not run,
    // and it may be the aligned one even when another signature passed or partly passed.
    if (result.results.some((r) => r.status?.result === "temperror")) return { ok: false, reason: "dkim-dns-temperror", transient: true };
    // A signature covering only part of the body (l= tag) leaves the rest unauthenticated: not a pass.
    if (passes.length === 0 && result.results.some((r) => r.status?.result === "pass" && (r.status as { underSized?: unknown }).underSized)) return { ok: false, reason: "dkim-partial-body" };
    if (passes.length > 0) return { ok: false, reason: "dkim-misaligned" };
    const unsigned = result.results.every((r) => r.status?.result === "none");
    return { ok: false, reason: unsigned ? "dkim-missing" : "dkim-fail" };
  };
}

/** `allowUnauthenticated: true` (testing only) replaces layer 2 with a pass. */
export const unauthenticated: Authenticator = async () => ({ ok: true });
