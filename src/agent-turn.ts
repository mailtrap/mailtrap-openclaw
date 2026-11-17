import { TurnNotRunError, type RunAgentTurn } from "./processor.js";

export const CHANNEL = "mailtrap";

/** What the agent delivered; `deliver` is called once per reply payload. */
export interface DeliveredPayload {
  text?: string;
  mediaUrls?: string[];
  mediaUrl?: string;
}

/**
 * The OpenClaw plugin-SDK functions the turn needs, injected so tests can run the
 * real routing functions with a fake dispatcher. Typed loosely on purpose: the
 * host types are large and only these shapes are used.
 */
export interface TurnHost {
  resolveAgentRoute(p: { cfg: unknown; channel: string; accountId: string; peer: { kind: "direct"; id: string } }): { agentId: string; accountId?: string };
  buildAgentSessionKey(p: {
    agentId: string;
    channel: string;
    accountId: string;
    peer: { kind: "direct"; id: string };
    dmScope: "per-account-channel-peer";
    identityLinks?: unknown;
  }): string;
  resolveThreadSessionKeys(p: { baseSessionKey: string; threadId: string }): { sessionKey: string; parentSessionKey?: string };
  createEnvelopeBuilder(p: { cfg: unknown; route: { agentId: string; sessionKey: string } }): Promise<(input: { channel: string; from: string; body: string; timestamp?: number }) => string>;
  buildContext(p: Record<string, unknown>): Record<string, unknown>;
  createReplyPipeline(p: { cfg: unknown; agentId: string; channel: string; accountId: string }): Record<string, unknown> & { onModelSelected?: unknown };
  normalizeReplyPayload(payload: unknown): DeliveredPayload;
  dispatchTurn(plan: Record<string, unknown>): Promise<unknown>;
}

export interface AgentTurnOptions {
  cfg: unknown;
  accountId: string;
  host: TurnHost;
  onError: (msg: string, err: unknown) => void;
}

/**
 * Session key of one email conversation. The agent id
 * comes from core routing on the user's untouched config. The base key is built
 * with `per-account-channel-peer` whatever `session.dmScope` says (the default
 * `main` would merge every email into the owner's main session), honouring the
 * user's identity links; the conversation key is the thread suffix:
 * `agent:<id>:mailtrap:<account>:direct:<sender>:thread:<conversation>`.
 */
export function emailSessionKey(
  host: Pick<TurnHost, "resolveAgentRoute" | "buildAgentSessionKey" | "resolveThreadSessionKeys">,
  cfg: unknown,
  accountId: string,
  sender: string,
  conversationKey: string
): { agentId: string; routeAccountId: string; sessionKey: string } {
  const peer = { kind: "direct" as const, id: sender };
  const route = host.resolveAgentRoute({ cfg, channel: CHANNEL, accountId, peer });
  const base = host.buildAgentSessionKey({
    agentId: route.agentId,
    channel: CHANNEL,
    accountId,
    peer,
    dmScope: "per-account-channel-peer",
    identityLinks: (cfg as { session?: { identityLinks?: unknown } } | undefined)?.session?.identityLinks
  });
  const { sessionKey } = host.resolveThreadSessionKeys({ baseSessionKey: base, threadId: conversationKey });
  return { agentId: route.agentId, routeAccountId: route.accountId ?? accountId, sessionKey };
}

/**
 * Runs one email through the OpenClaw agent as a direct message from the sender,
 * in the session of its conversation. It sets what `dispatchInboundDirectDm` set:
 * non-command turn, inbound access authorized, envelope body, direct chat context,
 * route peer, originating channel/target, media context, record and dispatch
 * error hooks, and the reply pipeline. The agent's deliveries are collected here
 * and sent by the processor, which owns the sending/done bookkeeping.
 */
export function createAgentTurnRunner(opts: AgentTurnOptions): RunAgentTurn {
  const { host, cfg, accountId } = opts;
  return async (input) => {
    const texts: string[] = [];
    const media: Array<{ path: string; filename: string }> = [];
    let dispatchError: unknown;
    // Empty output is real silence only when core reported a run that reached its terminal
    // outcome before the dispatch returned. A run that started (or a queued follow-up that was
    // admitted) without a terminal outcome is still going and will deliver later; a dispatch
    // with no run at all (session busy) has produced nothing yet.
    let runStarted = false;
    let runFinished = false;
    const markStarted = () => {
      runStarted = true;
    };
    const markFinished = () => {
      runStarted = true;
      runFinished = true;
    };

    const sender = input.sender.email;
    const { agentId, routeAccountId, sessionKey } = emailSessionKey(host, cfg, accountId, sender, input.conversationKey);
    const label = input.subject ? `${sender}: ${input.subject}` : sender;
    const rawBody = input.subject ? `Subject: ${input.subject}\n\n${input.body}` : input.body;
    const timestamp = Date.parse(input.receivedAt) || undefined;

    const buildEnvelope = await host.createEnvelopeBuilder({ cfg, route: { agentId, sessionKey } });
    const body = buildEnvelope({ channel: "Mailtrap", from: label, body: rawBody, timestamp });
    const ctxPayload = host.buildContext({
      channel: CHANNEL,
      accountId: routeAccountId,
      messageId: input.dispatchId,
      messageIdFull: input.dispatchId,
      timestamp,
      from: sender,
      sender: { id: sender, name: label },
      conversation: { kind: "direct", id: sender, routePeer: { kind: "direct", id: sender }, label },
      route: { agentId, accountId: routeAccountId, routeSessionKey: sessionKey, dispatchSessionKey: sessionKey },
      reply: { to: input.inboxAddress, originatingTo: sender },
      message: { body, bodyForAgent: rawBody, rawBody, commandBody: rawBody },
      // Email is never a command surface, and this event already passed the sender check.
      access: { commands: { authorized: false } },
      extra: {
        NativeDirectUserId: sender,
        OriginatingChannel: CHANNEL,
        ...(input.media.length
          ? {
              MediaPath: input.media[0]!.path,
              MediaPaths: input.media.map((m) => m.path),
              MediaType: input.media[0]!.contentType,
              MediaTypes: input.media.map((m) => m.contentType ?? "application/octet-stream")
            }
          : {})
      }
    });

    const { onModelSelected, ...replyPipeline } = host.createReplyPipeline({ cfg, agentId, channel: CHANNEL, accountId: routeAccountId });
    await host.dispatchTurn({
      cfg,
      channel: CHANNEL,
      accountId: routeAccountId,
      route: { agentId, sessionKey },
      ctxPayload,
      record: { onRecordError: (err: unknown) => opts.onError("session record failed", err) },
      delivery: {
        deliver: async (payload: unknown) => {
          const p = host.normalizeReplyPayload(payload);
          if (p.text?.trim()) texts.push(p.text.trim());
          for (const url of [...(p.mediaUrls ?? []), ...(p.mediaUrl ? [p.mediaUrl] : [])]) {
            if (media.some((m) => m.path === url)) continue;
            media.push({ path: url, filename: url.split(/[\\/]/).pop() || "attachment" });
          }
        },
        onError: (err: unknown, info: { kind: string }) => {
          dispatchError = err;
          opts.onError(`dispatch failed (${info.kind})`, err);
        }
      },
      replyPipeline,
      replyOptions: { onModelSelected, onAgentRunStart: markStarted, onPreparedAgentRunStart: markStarted, onAgentRunTerminalOutcome: markFinished }
    });
    if (dispatchError) throw dispatchError instanceof Error ? dispatchError : new Error(String(dispatchError));
    if (texts.length === 0 && media.length === 0) {
      // Core's busy-session result (`reply-operation-active`, dispatch-from-config:2896-2909) has the
      // same shape as a silent model turn. Only a run that finished before return makes empty mean "no reply".
      if (!runStarted || !runFinished) throw new TurnNotRunError();
      return null;
    }
    return { text: texts.join("\n\n"), media };
  };
}
