import { describe, expect, it } from "vitest";
import { guardToolCall, normalizeToolName } from "../src/tool-policy.js";

const key = "agent:main:mailtrap:default:direct:alex@example.test:thread:conv1";
const email = { sessionKey: key };
const blocked = (toolName: string, ctx: Parameters<typeof guardToolCall>[1] = email) => expect(guardToolCall({ toolName }, ctx), toolName).toMatchObject({ block: true });
const allowed = (toolName: string, ctx: Parameters<typeof guardToolCall>[1] = email) => expect(guardToolCall({ toolName }, ctx), toolName).toBeUndefined();

describe("tool deny under the Codex harness", () => {
  it("normalizes mcp__ prefix, server key and -/_", () => {
    expect(normalizeToolName("mcp__mailtrap__send_email")).toBe("send_email");
    expect(normalizeToolName("mailtrap__send-email")).toBe("send_email");
    expect(normalizeToolName("MCP__Mailtrap__Send-Email")).toBe("send_email");
  });

  it("blocks the Codex spelling of the send tools on an email turn", () => {
    for (const t of ["mcp__mailtrap__send_email", "mcp__mailtrap__reply_to_inbound_message", "mcp__mailtrap__forward_inbound_message", "mcp__mailtrap__batch_send_bulk_email", "mailtrap__send_email"]) blocked(t);
  });

  it("blocks the Codex spawn and cross-conversation tools", () => {
    for (const t of ["spawn_agent", "send_input", "send_message", "followup_task", "resume_agent", "conversations_send", "conversations_turn", "conversations_list", "sessions_send", "sessions_spawn", "sessions"]) blocked(t);
  });

  it("leaves read tools and other sessions alone", () => {
    allowed("mcp__mailtrap__list_templates");
    allowed("mcp__mailtrap__send_sandbox_email");
    allowed("exec");
    blocked("mcp__mailtrap__send_email", { requester: { channel: "mailtrap" } });
    allowed("mcp__mailtrap__send_email", { sessionKey: "agent:main:main", requester: { channel: "telegram" } });
    allowed("spawn_agent", {});
  });

  describe("shell and control-plane tools (re-audit 16.11.2026)", () => {
    const run = (toolName: string, params: unknown, ctx: Parameters<typeof guardToolCall>[1] = email) => guardToolCall({ toolName, params }, ctx);
    const curl = "curl -X POST https://send.api.mailtrap.io/api/send -H \"Authorization: Bearer $MAILTRAP_API_TOKEN\"";

    it("blocks a shell command under any harness spelling", () => {
      for (const t of ["exec", "gateway_exec", "exec_command", "shell", "shell_command", "local_shell", "bash", "Exec"]) {
        expect(run(t, { command: curl }), t).toMatchObject({ block: true });
        expect(run(t, { cmd: curl }), t).toMatchObject({ block: true });
      }
      expect(run("shell", { command: ["bash", "-lc", curl] })).toMatchObject({ block: true });
      expect(run("exec", { command: "ls" }, { requester: { channel: "mailtrap" } })).toMatchObject({ block: true });
    });

    it("leaves Codex Code Mode exec (no shell command) to the per-call checks", () => {
      expect(run("exec", { value: "await tools.mcp__mailtrap__list_templates({})" })).toBeUndefined();
      expect(run("exec", "await tools.message({ text: 'hi' })")).toBeUndefined();
      expect(run("exec", { command: "" })).toBeUndefined();
    });

    it("blocks process control and control-plane tools", () => {
      for (const t of ["process", "gateway_process", "write_stdin", "cron", "gateway", "openclaw", "nodes"]) blocked(t);
    });

    it("leaves shells and control-plane tools alone outside email turns", () => {
      const other = { sessionKey: "agent:main:main", requester: { channel: "telegram" } };
      expect(run("exec", { command: curl }, other)).toBeUndefined();
      expect(run("cron", { action: "add" }, other)).toBeUndefined();
    });
  });

  describe("message tool", () => {
    const call = (params: unknown, ctx: Parameters<typeof guardToolCall>[1] = email) => guardToolCall({ toolName: "message", params }, ctx);

    it("is never denied outright", () => {
      expect(call({ action: "send", text: "hi" })).toBeUndefined();
      expect(call(undefined)).toBeUndefined();
      expect(call({ action: "send", text: "hi" }, { requester: { channel: "mailtrap" } })).toBeUndefined();
    });

    it("accepts this conversation's own routing", () => {
      expect(call({ action: "send", channel: "mailtrap", target: "Alex@Example.test", accountId: "default", text: "x" })).toBeUndefined();
      expect(call({ action: "send", targets: ["alex@example.test"], text: "x" })).toBeUndefined();
    });

    it("blocks another channel, target, account or conversation", () => {
      expect(call({ action: "send", channel: "telegram", target: "123", text: "x" })).toMatchObject({ block: true });
      expect(call({ action: "send", target: "someone@example.test", text: "x" })).toMatchObject({ block: true });
      expect(call({ action: "send", to: "someone@example.test", text: "x" })).toMatchObject({ block: true });
      expect(call({ action: "send", channelId: "C123", text: "x" })).toMatchObject({ block: true });
      expect(call({ action: "send", targets: ["alex@example.test", "b@example.test"], text: "x" })).toMatchObject({ block: true });
      expect(call({ action: "send", targets: "alex@example.test", text: "x" })).toMatchObject({ block: true });
      expect(call({ action: "send", accountId: "other", text: "x" })).toMatchObject({ block: true });
      expect(call({ action: "send", conversationRef: "conv:abc", text: "x" })).toMatchObject({ block: true });
      expect(call({ action: "broadcast", text: "x" })).toMatchObject({ block: true });
      expect(call({ action: "send", channel: "mailtrap", target: { id: "x" }, text: "x" })).toMatchObject({ block: true });
    });

    it("blocks any explicit target when the peer is unknown", () => {
      expect(call({ action: "send", target: "alex@example.test" }, { requester: { channel: "mailtrap" } })).toMatchObject({ block: true });
    });

    it("is untouched in other channels' turns", () => {
      expect(call({ action: "send", channel: "telegram", target: "1" }, { sessionKey: "agent:main:main", requester: { channel: "telegram" } })).toBeUndefined();
    });
  });
});
