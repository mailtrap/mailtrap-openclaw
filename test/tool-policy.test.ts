import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mailtrapChannelPlugin } from "../src/channel.js";
import { DENIED_CROSS_SESSION_TOOLS, DENIED_MCP_TOOLS, MCP_SERVER_KEY, deniedToolNames, guardToolCall, isEmailSessionKey } from "../src/tool-policy.js";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { emailSessionKey } from "../src/agent-turn.js";
import { realTurnHost } from "./helpers/turn-host.js";
import { readFileSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The real tool names, from the pinned mcp-mailtrap started through the plugin's own launcher. */
function realTools(): string[] {
  const input = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" }
  ].map((m) => JSON.stringify(m)).join("\n") + "\n";
  const out = execFileSync("node", [join(root, "bin", "mailtrap-mcp.mjs")], {
    input,
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, MAILTRAP_API_TOKEN: "test-token", MAILTRAP_ACCOUNT_ID: "1", HOME: "/nonexistent" },
    stdio: ["pipe", "pipe", "ignore"]
  });
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === 2) return msg.result.tools.map((t: { name: string }) => t.name);
  }
  throw new Error("no tools/list answer");
}

describe("email-turn tool deny", () => {
  const tools = realTools();

  it("uses the manifest's MCP server key as the prefix", () => {
    const manifest = JSON.parse(readFileSync(join(root, "openclaw.plugin.json"), "utf8"));
    expect(Object.keys(manifest.mcpServers)).toContain(MCP_SERVER_KEY);
  });

  it("denies only tools that really exist in the pinned mcp-mailtrap", () => {
    for (const name of DENIED_MCP_TOOLS) expect(tools, `${name} is not a real tool`).toContain(name);
  });

  it("denies every real tool whose name sends, forwards or replies (so a new tool can't slip through)", () => {
    const risky = tools.filter((t) => /(^|-)(send|forward|reply)(-|$)/.test(t) && !/sandbox-email$/.test(t) && !/^(list|get|delete)-/.test(t));
    expect(risky.length).toBeGreaterThanOrEqual(7);
    for (const t of risky) expect(DENIED_MCP_TOOLS as readonly string[], `${t} must be denied`).toContain(t);
  });

  it("leaves reading, templates and Sandbox testing tools available", () => {
    const allowed = ["list-inbound-messages", "get-inbound-message", "list-templates", "get-template", "send-sandbox-email", "get-sandbox-messages"];
    for (const t of allowed) {
      expect(tools).toContain(t);
      expect(deniedToolNames()).not.toContain(`mailtrap__${t}`);
    }
  });

  it("is returned by the channel's group tool policy as OpenClaw-facing names", () => {
    const policy = (mailtrapChannelPlugin as unknown as { groups: { resolveToolPolicy: (c: unknown) => { deny: string[] } } }).groups.resolveToolPolicy({ cfg: {}, senderPolicyMode: "never" });
    expect(policy.deny).toContain("mailtrap__send-email");
    expect(policy.deny).toContain("mailtrap__reply-to-inbound-message");
    expect(policy.deny).toContain("mailtrap__forward-inbound-message");
    expect(policy.deny).toContain("mailtrap__batch-send-transactional-email");
    expect(policy.deny).toEqual(deniedToolNames());
  });

  it("blocks the send tools in an email-triggered turn but not in other channels' turns", () => {
    expect(guardToolCall({ toolName: "mailtrap__send-email" }, { channelId: "mailtrap" })).toMatchObject({ block: true });
    expect(guardToolCall({ toolName: "mailtrap__list-templates" }, { channelId: "mailtrap" })).toBeUndefined();
    expect(guardToolCall({ toolName: "mailtrap__send-email" }, { channelId: "telegram" })).toBeUndefined();
    expect(guardToolCall({ toolName: "mailtrap__send-email" }, {})).toBeUndefined();
  });
});

describe("tool deny on email turns with the real session key", () => {
  const key = emailSessionKey(realTurnHost, {}, "default", "alex@example.test", "conv-1").sessionKey;

  it("blocks when OpenClaw supplies the sender address as channelId, as it does for direct messages", () => {
    const ctx = { channelId: "alex@example.test", sessionKey: key };
    expect(isEmailSessionKey(key)).toBe(true);
    expect(guardToolCall({ toolName: "mailtrap__send-email" }, ctx)).toMatchObject({ block: true });
    expect(guardToolCall({ toolName: "mailtrap__forward-inbound-message" }, ctx)).toMatchObject({ block: true });
    expect(guardToolCall({ toolName: "mailtrap__list-templates" }, ctx)).toBeUndefined();
  });

  it("leaves other channels' sessions alone", () => {
    const main = resolveAgentRoute({ cfg: {} as never, channel: "telegram", accountId: "default", peer: { kind: "direct", id: "1" } }).sessionKey;
    expect(isEmailSessionKey(main)).toBe(false);
    expect(guardToolCall({ toolName: "mailtrap__send-email" }, { channelId: "1", sessionKey: main })).toBeUndefined();
    expect(guardToolCall({ toolName: "mailtrap__send-email" }, {})).toBeUndefined();
  });
});

describe("sub-agent spawn on email turns", () => {
  const emailKey = "agent:main:mailtrap:default:direct:conv-1";
  const childKey = "agent:main:subagent:3f2a7c1e-0000-4000-8000-000000000000";
  it("blocks sessions_spawn and subagents on an email session", () => {
    for (const toolName of ["sessions_spawn", "subagents"]) {
      expect(guardToolCall({ toolName }, { channelId: "alex@example.test", sessionKey: emailKey })).toMatchObject({ block: true });
    }
  });
  it("leaves them alone outside email sessions", () => {
    expect(guardToolCall({ toolName: "sessions_spawn" }, { channelId: "telegram", sessionKey: "agent:main:main" })).toBeUndefined();
  });
  it("a child key is not an email key, so the spawn itself has to be blocked", () => {
    expect(isEmailSessionKey(childKey)).toBe(false);
  });
});

describe("cross-session tools on email turns", () => {
  it("blocks sessions_send/history/search/list on an email session only", () => {
    expect([...DENIED_CROSS_SESSION_TOOLS].sort()).toEqual(["sessions_history", "sessions_list", "sessions_search", "sessions_send"]);
    for (const toolName of DENIED_CROSS_SESSION_TOOLS) {
      expect(guardToolCall({ toolName }, { channelId: "alex@example.test", sessionKey: "agent:main:mailtrap:default:direct:c1" })).toMatchObject({ block: true });
      expect(guardToolCall({ toolName }, { channelId: "telegram", sessionKey: "agent:main:main" })).toBeUndefined();
    }
  });
});

describe("tool deny on email turns: either match blocks", () => {
  const send = { toolName: "mailtrap__send-email" };
  it("blocks on the requester channel alone", () => {
    expect(guardToolCall(send, { sessionKey: "agent:main:main", requester: { channel: "mailtrap" } })).toMatchObject({ block: true });
    expect(guardToolCall(send, { requester: { channel: "mailtrap" } })).toMatchObject({ block: true });
  });
  it("blocks on the session key alone", () => {
    expect(guardToolCall(send, { sessionKey: "agent:main:mailtrap:default:direct:a@x.test:thread:1", requester: { channel: "telegram" } })).toMatchObject({ block: true });
    expect(guardToolCall(send, { sessionKey: "agent:main:mailtrap:default:direct:a@x.test:thread:1" })).toMatchObject({ block: true });
  });
  it("lets other channels through", () => {
    expect(guardToolCall(send, { sessionKey: "agent:main:main", requester: { channel: "telegram" } })).toBeUndefined();
  });
});
