import { CHANNEL_ID } from "./config.js";

/** Key of the MCP server in openclaw.plugin.json. OpenClaw exposes its tools as `<key>__<tool>`. */
export const MCP_SERVER_KEY = "mailtrap";

/**
 * Tools of mcp-mailtrap that can send, forward or reply to real recipients, or
 * set up something that does. Email-triggered turns may not call them:
 * the channel is reply-only, and the only reply path is the
 * channel's own `reply` call. Reading, templates and Sandbox (testing) tools
 * stay available. Names are checked against the server's real `tools/list`
 * in test/tool-policy.test.ts.
 */
export const DENIED_MCP_TOOLS = [
  // sending
  "send-email",
  "batch-send-transactional-email",
  "batch-send-bulk-email",
  // Inbound reply / forward
  "reply-to-inbound-message",
  "reply-all-to-inbound-message",
  "forward-inbound-message",
  // Sandbox forward goes to real addresses
  "forward-sandbox-message",
  // hardening beyond the send tools: these cause mail to real recipients later or elsewhere
  "start-email-campaign",
  "schedule-email-campaign",
  "create-inbound-forward-rule",
  "update-inbound-forward-rule",
  "send-domain-setup-instructions"
] as const;

export function deniedToolNames(): string[] {
  return DENIED_MCP_TOOLS.map((t) => `${MCP_SERVER_KEY}__${t}`);
}

/** Shape returned to OpenClaw's `group.resolveToolPolicy`. OpenClaw does not consult it for direct messages, so email turns rely on `guardToolCall`; kept for group-style routes. */
export function resolveEmailToolPolicy(): { deny: string[] } {
  return { deny: deniedToolNames() };
}

/**
 * Routes that start a child session. The child's key is `agent:<id>:subagent:<uuid>`,
 * so it no longer looks like an email session and the guard could not see it; and
 * OpenClaw's own sub-agent deny list doesn't cover MCP tools. Blocking the spawn
 * on email turns keeps the reply-only rule from being sidestepped. Names are the
 * ones OpenClaw registers (`sessions_spawn`, `subagents`).
 */
export const DENIED_SPAWN_TOOLS = ["sessions_spawn", "subagents"] as const;

/**
 * Cross-session reach: with OpenClaw's default `tools.sessions.visibility: all`, an email turn
 * could message (`sessions_send`) or read (`sessions_history`, `sessions_search`, `sessions_list`)
 * the main session, whose key is not an email key, where the send tools are not guarded.
 */
export const DENIED_CROSS_SESSION_TOOLS = ["sessions_send", "sessions_history", "sessions_search", "sessions_list"] as const;

/**
 * Codex-harness names. Under the Codex harness the agent also sees Codex's own sub-agent tools and
 * OpenClaw's conversation tools (docs/concepts/session-tool.md in the OpenClaw package):
 * `spawn_agent` starts a child session whose key no longer looks like an email session,
 * `send_input`/`send_message`/`followup_task`/`resume_agent` drive other agents, `conversations_send`
 * and `conversations_turn` send to any external conversation, and `sessions` patches or deletes
 * other sessions.
 */
export const DENIED_CODEX_TOOLS = [
  "spawn_agent",
  "send_input",
  "send_message",
  "followup_task",
  "resume_agent",
  "conversations_list",
  "conversations_send",
  "conversations_turn",
  "sessions"
] as const;

/**
 * Control-plane tools, denied on email turns as OpenClaw advises for any surface that handles
 * untrusted content (docs/gateway/security/tool-permissions.md): `cron` schedules a job that runs
 * later in a session that is not an email session, where the send tools are not guarded;
 * `gateway` reads config (secrets); `openclaw` requests config and lifecycle changes, which could
 * turn this guard off; `nodes` runs commands on paired devices (`system.run`).
 */
export const DENIED_CONTROL_TOOLS = ["cron", "gateway", "openclaw", "nodes"] as const;

/**
 * Tools that keep driving a shell process; denied outright, since the shell itself is denied.
 * OpenClaw's `process` and `gateway_process`, Codex's `write_stdin`.
 */
export const DENIED_PROCESS_TOOLS = ["process", "gateway_process", "write_stdin"] as const;

/**
 * Shell tools. A shell inherits the gateway's environment, including `MAILTRAP_API_TOKEN`, so a
 * shell command could call the Send API directly (the bundled sending-emails skill shows the
 * `curl`). They are denied when the call carries a shell command (`command`, or Codex's `cmd`).
 * Names: OpenClaw `exec`/`gateway_exec`, and the Codex native shell (`exec_command`, which the
 * native hook relay reports as `exec`; `shell`, `shell_command`, `local_shell`, `bash`; see
 * NATIVE_SHELL_APPROVAL_TOOLS in OpenClaw's native-hook-relay). A call without a command is left
 * alone: under Codex `exec` is also Code Mode, whose nested `tools.*` calls reach this guard one
 * by one (confirmed live 10.11.2026).
 */
export const SHELL_TOOLS = ["exec", "gateway_exec", "exec_command", "shell", "shell_command", "local_shell", "bash"] as const;

const shellTools = new Set(SHELL_TOOLS.map((t) => normalizeToolName(t)));

function carriesShellCommand(params: unknown): boolean {
  if (!params || typeof params !== "object" || Array.isArray(params)) return false;
  const p = params as Record<string, unknown>;
  const given = (v: unknown) => (typeof v === "string" && v.trim() !== "") || (Array.isArray(v) && v.length > 0);
  return given(p.command) || given(p.cmd);
}

/**
 * Canonical form of a tool name, so one rule covers every harness spelling: lower case, a leading
 * `mcp__` (Codex passes MCP names as `mcp__<server>__<tool>`) and the `mailtrap__` server key
 * (OpenClaw's own form is `mailtrap__<tool>`) stripped, and `-` equal to `_`.
 */
export function normalizeToolName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^mcp__/, "")
    .replace(new RegExp(`^${MCP_SERVER_KEY}__`), "")
    .replace(/-/g, "_");
}

const denied = new Set(
  [
    ...DENIED_MCP_TOOLS,
    ...DENIED_SPAWN_TOOLS,
    ...DENIED_CROSS_SESSION_TOOLS,
    ...DENIED_CODEX_TOOLS,
    ...DENIED_CONTROL_TOOLS,
    ...DENIED_PROCESS_TOOLS
  ].map(normalizeToolName)
);

/** True for a tool the email turn may not call, under any harness spelling. */
export function isDeniedToolName(name: string): boolean {
  return denied.has(normalizeToolName(name));
}

/**
 * True for the session key of an email conversation. The agent turn runs under
 * `agent:<id>:mailtrap:<account>:direct:<sender>:thread:<conversation>` (built in
 * agent-turn.ts), and OpenClaw passes `sessionKey` to `before_tool_call`.
 * `ctx.channelId` can't be used: for a direct message OpenClaw fills it with the
 * conversation target (the sender's address), not the channel name.
 */
export function isEmailSessionKey(sessionKey: string | undefined): boolean {
  return /^agent:[^:]+:mailtrap:/i.test(sessionKey ?? "");
}

/** `{account, peer}` of an email session key, or undefined when it is not one. */
function emailKeyParts(sessionKey: string | undefined): { account: string; peer: string } | undefined {
  const m = /^agent:[^:]+:mailtrap:([^:]+):direct:([^:]+)(?::|$)/i.exec(sessionKey ?? "");
  return m ? { account: m[1]!.toLowerCase(), peer: m[2]!.toLowerCase() } : undefined;
}

const sameValue = (v: unknown, want: string | undefined): boolean => typeof v === "string" && want !== undefined && v.trim().toLowerCase() === want;

/**
 * The `message` tool is the agent's reply path, so it is never denied. It can also address another
 * conversation or channel, so on an email turn it is held to the current one: a call may carry no
 * routing fields (the host then uses this turn's conversation) or fields that name this channel,
 * account and sender; anything else, and `broadcast`, is blocked. Routing fields are `channel`,
 * `target`, `targets`, `to`, `channelId`, `accountId` and `conversationRef` (OpenClaw's message
 * tool schema: buildRoutingSchema and requireExplicitMessageTarget, dist/openclaw-tools-*.mjs).
 * Without an email session key (host only gave `requester.channel`) the peer is unknown, so any
 * explicit routing is blocked.
 */
function messageEscapesConversation(params: unknown, sessionKey: string | undefined): boolean {
  const p = params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
  if (typeof p.action === "string" && p.action.trim().toLowerCase() === "broadcast") return true;
  const key = emailKeyParts(sessionKey);
  const present = (v: unknown) => v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "");
  if (present(p.channel) && !sameValue(p.channel, CHANNEL_ID)) return true;
  if (present(p.accountId) && !sameValue(p.accountId, key?.account)) return true;
  if (present(p.conversationRef)) return true;
  for (const field of ["target", "to", "channelId"] as const) {
    if (present(p[field]) && !sameValue(p[field], key?.peer)) return true;
  }
  if (present(p.targets)) {
    if (!Array.isArray(p.targets) || !p.targets.every((t) => sameValue(t, key?.peer))) return true;
  }
  return false;
}

/**
 * `before_tool_call` guard: in any turn that came in through this channel it blocks the denied
 * tools (matched by normalized name, see `normalizeToolName`) and any `message` call aimed at
 * another conversation. Either match identifies an email turn: the email session key, or the
 * host's `ctx.requester.channel` (set for message turns); a `channelId` equal to the channel name
 * is kept as a harmless third.
 */
export function guardToolCall(
  event: { toolName: string; params?: unknown },
  ctx: { channelId?: string; sessionKey?: string; requester?: { channel?: string } }
): { block: true; blockReason: string } | undefined {
  if (!isEmailSessionKey(ctx.sessionKey) && ctx.requester?.channel !== CHANNEL_ID && ctx.channelId !== CHANNEL_ID) return undefined;
  if (normalizeToolName(event.toolName) === "message") {
    if (!messageEscapesConversation(event.params, ctx.sessionKey)) return undefined;
    return { block: true, blockReason: "Mailtrap email turns may use the message tool only for this conversation: leave out channel, target and other routing fields." };
  }
  if (shellTools.has(normalizeToolName(event.toolName)) && carriesShellCommand(event.params)) {
    return { block: true, blockReason: "Mailtrap email turns can't run shell commands: a shell could send email around the reply-only rule. Answer in your reply text instead." };
  }
  if (!isDeniedToolName(event.toolName)) return undefined;
  return { block: true, blockReason: "Mailtrap email turns are reply-only: sending, forwarding, replying, scheduling, changing config and spawning sub-agents by tool is disabled. Answer in your reply text instead." };
}
