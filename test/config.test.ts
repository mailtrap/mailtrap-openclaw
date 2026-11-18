import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mailtrapChannelPlugin } from "../src/channel.js";
import {
  ConfigError,
  channelConfigSchema,
  channelUiHints,
  detectInboxKind,
  isConfigured,
  listAccountIds,
  normalizeAccountId,
  resolveAccount,
  resolveReplyIdentity
} from "../src/config.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "openclaw.plugin.json"), "utf8"));

const cfg = (section: unknown) => ({ channels: { mailtrap: section } });
const hosted = { id: 1001, name: "t", address: "agent-test@inbound-mailtrap.io" };
const custom = { id: 1002, name: "t", address: "*@mail.example.test" };

describe("manifest", () => {
  it("declares the channel and keeps channelConfigs in sync with the runtime schema", () => {
    expect(manifest.channels).toEqual(["mailtrap"]);
    expect(manifest.channelConfigs.mailtrap.schema).toEqual(JSON.parse(JSON.stringify(channelConfigSchema)));
    expect(manifest.channelConfigs.mailtrap.uiHints).toEqual(channelUiHints);
    expect(manifest.channelConfigs.mailtrap.uiHints.apiToken.sensitive).toBe(true);
  });
});

describe("account ids", () => {
  it("treats an empty id as default and ignores case", () => {
    expect(normalizeAccountId("")).toBe("default");
    expect(normalizeAccountId(undefined)).toBe("default");
    expect(normalizeAccountId(" Support ")).toBe("support");
  });

  it("lists the default account for top-level config plus named accounts", () => {
    expect(listAccountIds(cfg({ inboxId: 1, apiToken: "t", accounts: { support: { inboxId: 2 } } })).sort()).toEqual(["default", "support"]);
    expect(listAccountIds(cfg({ accounts: { A: { inboxId: 2 } } }))).toEqual(["a"]);
    expect(listAccountIds({})).toEqual(["default"]);
  });
});

describe("resolveAccount", () => {
  const full = cfg({
    apiToken: "tok-default",
    inboxId: 11,
    allowFrom: ["Alex@Example.test", "@corp.example.test"],
    mediaMaxMb: 5,
    accounts: { support: { apiToken: "tok-support", inboxId: 22, allowFrom: ["a@b.test"] } }
  });

  it("reads the default account from the top level, normalising the allowlist", () => {
    const a = resolveAccount(full, undefined);
    expect(a).toMatchObject({ accountId: "default", apiToken: "tok-default", inboxId: 11, enabled: true, allowUnauthenticated: false });
    expect(a.allowFrom).toEqual(["alex@example.test", "@corp.example.test"]);
    expect(a.mediaMaxBytes).toBe(5 * 1024 * 1024);
    expect(isConfigured(a)).toBe(true);
  });

  it("keeps named accounts separate: no token, inbox, allowlist or from is inherited", () => {
    const s = resolveAccount(full, "support");
    expect(s).toMatchObject({ apiToken: "tok-support", inboxId: 22, allowFrom: ["a@b.test"] });
    expect(s.mediaMaxBytes).toBe(5 * 1024 * 1024); // tuning knobs inherit
    const other = resolveAccount(full, "unknown");
    expect(other.apiToken).toBeUndefined();
    expect(other.allowFrom).toEqual([]);
    expect(isConfigured(other)).toBe(false);
  });

  it("applies defaults and clamps the poll interval", () => {
    const a = resolveAccount(cfg({ apiToken: "t", inboxId: 1, pollIntervalSec: 1 }), "default");
    expect(a.mediaMaxBytes).toBe(20 * 1024 * 1024);
    expect(a.pollIntervalMs).toBe(5000);
    expect(resolveAccount(cfg({ apiToken: "t", inboxId: 1 }), "default").pollIntervalMs).toBe(30_000);
    expect(resolveAccount(cfg({ apiToken: "t", inboxId: 1, pollIntervalSec: 10_000_000 }), "default").pollIntervalMs).toBe(86_400_000);
  });

  it("is disabled by either the section or the account", () => {
    expect(resolveAccount(cfg({ enabled: false, apiToken: "t", inboxId: 1 }), "default").enabled).toBe(false);
    expect(resolveAccount(cfg({ accounts: { x: { enabled: false } } }), "x").enabled).toBe(false);
  });

  it("is exposed through the channel plugin config adapter", () => {
    const c = full as never;
    expect(mailtrapChannelPlugin.config.listAccountIds(c).sort()).toEqual(["default", "support"]);
    expect(mailtrapChannelPlugin.config.inspectAccount?.(c, "support")).toMatchObject({ configured: true, tokenStatus: "available" });
    expect(mailtrapChannelPlugin.config.inspectAccount?.({} as never, undefined)).toMatchObject({ configured: false, tokenStatus: "missing" });
  });
});

describe("inbox type detection and reply identity", () => {
  it("detects hosted and custom-domain inboxes from the inbox address", () => {
    expect(detectInboxKind(hosted)).toBe("hosted");
    expect(detectInboxKind(custom)).toBe("custom-domain");
  });

  it("sends no `from` on a hosted inbox and refuses a configured one", () => {
    expect(resolveReplyIdentity(hosted, undefined)).toMatchObject({ kind: "hosted", from: undefined });
    expect(() => resolveReplyIdentity(hosted, "x@mail.example.test")).toThrow(ConfigError);
  });

  it("requires a `from` on the inbox's own domain for a custom-domain inbox", () => {
    expect(() => resolveReplyIdentity(custom, undefined)).toThrow(/set "from"/);
    expect(() => resolveReplyIdentity(custom, "x@other.test")).toThrow(/must be an address on mail.example.test/);
    expect(resolveReplyIdentity(custom, "agent@mail.example.test")).toMatchObject({
      kind: "custom-domain",
      domain: "mail.example.test",
      from: { email: "agent@mail.example.test" }
    });
  });
});
