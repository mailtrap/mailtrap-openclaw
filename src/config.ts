import type { InboxInfo } from "./types.js";

export const CHANNEL_ID = "mailtrap";
export const DEFAULT_ACCOUNT_ID = "default";
export const HOSTED_INBOX_DOMAIN = "inbound-mailtrap.io";

export const DEFAULT_MEDIA_MAX_MB = 20;
export const DEFAULT_OUTBOUND_MAX_MB = 10;
export const DEFAULT_POLL_INTERVAL_SEC = 30;
export const MIN_POLL_INTERVAL_SEC = 5;

export interface MailtrapAccountConfig {
  enabled?: boolean;
  /** Token the channel itself uses. Reading Inbound and replying; see the README for scope advice. */
  apiToken?: string;
  inboxId?: number;
  /** Exact addresses and `@domain` entries. Default deny. */
  allowFrom?: string[];
  /** Reply `from` address. Required on custom-domain inboxes, rejected on hosted ones. */
  from?: string;
  mediaMaxMb?: number;
  outboundMaxMb?: number;
  /** Testing only: skips the DKIM check. The allowlist still applies. */
  allowUnauthenticated?: boolean;
  pollIntervalSec?: number;
}

export interface MailtrapChannelConfig extends MailtrapAccountConfig {
  accounts?: Record<string, MailtrapAccountConfig>;
}

export interface ResolvedAccount {
  accountId: string;
  enabled: boolean;
  apiToken: string | undefined;
  inboxId: number | undefined;
  allowFrom: string[];
  from: string | undefined;
  mediaMaxBytes: number;
  outboundMaxBytes: number;
  allowUnauthenticated: boolean;
  pollIntervalMs: number;
}

export class ConfigError extends Error {}

/** Empty id means `default`. Ids are case-insensitive. */
export function normalizeAccountId(id: string | null | undefined): string {
  const v = (id ?? "").trim().toLowerCase();
  return v === "" ? DEFAULT_ACCOUNT_ID : v;
}

export function readChannelSection(cfg: unknown): MailtrapChannelConfig {
  const channels = (cfg as { channels?: Record<string, unknown> } | undefined)?.channels;
  const section = channels?.[CHANNEL_ID];
  return section && typeof section === "object" ? (section as MailtrapChannelConfig) : {};
}

function topLevelConfigured(section: MailtrapChannelConfig): boolean {
  return section.inboxId !== undefined || section.apiToken !== undefined;
}

export function listAccountIds(cfg: unknown): string[] {
  const section = readChannelSection(cfg);
  const ids = new Set<string>();
  if (topLevelConfigured(section)) ids.add(DEFAULT_ACCOUNT_ID);
  for (const id of Object.keys(section.accounts ?? {})) ids.add(normalizeAccountId(id));
  return ids.size > 0 ? [...ids] : [DEFAULT_ACCOUNT_ID];
}

function findNamedAccount(section: MailtrapChannelConfig, accountId: string): MailtrapAccountConfig | undefined {
  for (const [key, value] of Object.entries(section.accounts ?? {})) {
    if (normalizeAccountId(key) === accountId) return value;
  }
  return undefined;
}

/**
 * Account settings. The default account is the top level of `channels.mailtrap`
 * (overridden by `accounts.default` if present). Other accounts read only their
 * own entry: token, inbox, allowlist and `from` are never inherited, so one
 * account can't silently reuse another's inbox or senders. Only the numeric
 * tuning knobs inherit from the top level.
 */
export function resolveAccount(cfg: unknown, accountId?: string | null): ResolvedAccount {
  const id = normalizeAccountId(accountId);
  const section = readChannelSection(cfg);
  const named = findNamedAccount(section, id);
  const own: MailtrapAccountConfig = id === DEFAULT_ACCOUNT_ID ? { ...section, ...(named ?? {}) } : (named ?? {});
  const pick = <K extends keyof MailtrapAccountConfig>(k: K): MailtrapAccountConfig[K] => own[k] ?? section[k];

  const mediaMb = positive(pick("mediaMaxMb"), DEFAULT_MEDIA_MAX_MB);
  const outMb = positive(pick("outboundMaxMb"), DEFAULT_OUTBOUND_MAX_MB);
  const pollSec = Math.max(MIN_POLL_INTERVAL_SEC, positive(pick("pollIntervalSec"), DEFAULT_POLL_INTERVAL_SEC));
  return {
    accountId: id,
    enabled: own.enabled !== false && section.enabled !== false,
    apiToken: nonEmpty(own.apiToken),
    inboxId: typeof own.inboxId === "number" && Number.isInteger(own.inboxId) ? own.inboxId : undefined,
    allowFrom: (own.allowFrom ?? []).map((s) => String(s).trim().toLowerCase()).filter(Boolean),
    from: nonEmpty(own.from)?.toLowerCase(),
    mediaMaxBytes: Math.floor(mediaMb * 1024 * 1024),
    outboundMaxBytes: Math.floor(outMb * 1024 * 1024),
    allowUnauthenticated: own.allowUnauthenticated === true,
    pollIntervalMs: pollSec * 1000
  };
}

export function isConfigured(account: ResolvedAccount): boolean {
  return Boolean(account.apiToken && account.inboxId !== undefined);
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function positive(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}

export type InboxKind = "hosted" | "custom-domain";

export function addressDomain(address: string): string {
  const at = address.lastIndexOf("@");
  return at < 0 ? "" : address.slice(at + 1).trim().toLowerCase().replace(/>$/, "");
}

/**
 * Inbox type detection. The Inbound API has no explicit "hosted"
 * flag the channel can rely on, so the inbox's own address decides: Mailtrap
 * hosted inboxes always live on `inbound-mailtrap.io`; a custom-domain inbox
 * is a catch-all `*@yourdomain`, so its address domain is the sending domain.
 */
export function detectInboxKind(inbox: Pick<InboxInfo, "address">): InboxKind {
  return addressDomain(inbox.address) === HOSTED_INBOX_DOMAIN ? "hosted" : "custom-domain";
}

export interface ReplyIdentity {
  kind: InboxKind;
  inboxAddress: string;
  /** Domain the replies' RFC Message-IDs are most likely on. */
  domain: string;
  /** Value for the `from` field of `reply`; undefined on hosted inboxes (Mailtrap rejects it there). */
  from: { email: string } | undefined;
}

/** Throws ConfigError when the configured `from` contradicts the inbox type. */
export function resolveReplyIdentity(inbox: InboxInfo, configuredFrom: string | undefined): ReplyIdentity {
  const kind = detectInboxKind(inbox);
  const domain = addressDomain(inbox.address);
  if (kind === "hosted") {
    // Hosted inboxes answer 400 to any `from`. Ignoring a configured value
    // silently would hide a misconfiguration, so refuse it.
    if (configuredFrom) {
      throw new ConfigError(
        `Inbox ${inbox.id} is a Mailtrap-hosted inbox; Mailtrap rejects a custom "from" there. Remove "from" from the account config.`
      );
    }
    return { kind, inboxAddress: inbox.address, domain, from: undefined };
  }
  if (!configuredFrom) {
    throw new ConfigError(
      `Inbox ${inbox.id} is on the custom domain ${domain}; set "from" to an address on ${domain}.`
    );
  }
  if (addressDomain(configuredFrom) !== domain) {
    throw new ConfigError(`"from" (${configuredFrom}) must be an address on ${domain}, the domain of inbox ${inbox.id}.`);
  }
  return { kind, inboxAddress: inbox.address, domain, from: { email: configuredFrom } };
}

const accountProperties = {
  enabled: { type: "boolean" },
  apiToken: { type: "string" },
  inboxId: { type: "integer", minimum: 1 },
  allowFrom: { type: "array", items: { type: "string" } },
  from: { type: "string" },
  mediaMaxMb: { type: "number", exclusiveMinimum: 0 },
  outboundMaxMb: { type: "number", exclusiveMinimum: 0 },
  allowUnauthenticated: { type: "boolean" },
  pollIntervalSec: { type: "number", minimum: MIN_POLL_INTERVAL_SEC }
} as const;

/** JSON schema for `channels.mailtrap`. The manifest's channelConfigs copy is checked against this in tests. */
export const channelConfigSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...accountProperties,
    accounts: {
      type: "object",
      additionalProperties: { type: "object", additionalProperties: false, properties: accountProperties }
    }
  }
} as const;

export const channelUiHints = {
  apiToken: { label: "Mailtrap API token (Inbound)", sensitive: true },
  inboxId: { label: "Inbound inbox ID" },
  allowFrom: { label: "Allowed senders (addresses or @domain)" },
  from: { label: "Reply from address (custom-domain inboxes only)" },
  allowUnauthenticated: { label: "Skip DKIM check (testing only)" }
} as const;
