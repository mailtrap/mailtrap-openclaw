import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import { buildAgentSessionKey, resolveAgentRoute, resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import type { TurnHost } from "../../src/agent-turn.js";

/** Real OpenClaw routing and context building; envelope, pipeline and dispatch are faked. */
export function makeTurnHost(dispatchTurn: TurnHost["dispatchTurn"]): TurnHost {
  return {
    resolveAgentRoute: (p) => resolveAgentRoute(p as never),
    buildAgentSessionKey: (p) => buildAgentSessionKey(p as never),
    resolveThreadSessionKeys: (p) => resolveThreadSessionKeys(p),
    createEnvelopeBuilder: async () => (i) => `[${i.channel}] ${i.from}: ${i.body}`,
    buildContext: (p) => buildChannelInboundEventContext(p as never) as never,
    createReplyPipeline: () => ({ onModelSelected: () => {}, marker: "pipeline" }),
    normalizeReplyPayload: (p) => p as never,
    dispatchTurn
  };
}

export const realTurnHost = makeTurnHost(async () => undefined);
