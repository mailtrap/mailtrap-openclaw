import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { buildChannelInboundEventContext, createChannelInboundEnvelopeBuilderAsync, dispatchChannelInboundTurn } from "openclaw/plugin-sdk/channel-inbound";
import { createChannelMessageReplyPipeline } from "openclaw/plugin-sdk/channel-outbound";
import { normalizeOutboundReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { buildAgentSessionKey, resolveAgentRoute, resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import { getMediaDir } from "openclaw/plugin-sdk/media-runtime";
import { saveInboundMedia } from "./media-save.js";
import { defaultDownload } from "./attachments.js";
import { runAccount } from "./account-runner.js";
import { createAgentTurnRunner, type TurnHost } from "./agent-turn.js";
import { resolveEmailToolPolicy } from "./tool-policy.js";
import { createInboundApi } from "./mailtrap-api.js";
import { createOpenStore, getHostApi, toLogger } from "./openclaw-host.js";
import { CHANNEL_ID, isConfigured, listAccountIds, resolveAccount, type ResolvedAccount } from "./config.js";

/** The real OpenClaw functions behind the turn runner's ports. */
const turnHost: TurnHost = {
  resolveAgentRoute: (p) => resolveAgentRoute(p as never),
  buildAgentSessionKey: (p) => buildAgentSessionKey(p as never),
  resolveThreadSessionKeys: (p) => resolveThreadSessionKeys(p),
  createEnvelopeBuilder: (p) => createChannelInboundEnvelopeBuilderAsync(p as never) as never,
  buildContext: (p) => buildChannelInboundEventContext(p as never) as never,
  createReplyPipeline: (p) => createChannelMessageReplyPipeline(p as never) as never,
  normalizeReplyPayload: (p) => normalizeOutboundReplyPayload(p as never) as never,
  dispatchTurn: (plan) => dispatchChannelInboundTurn(plan as never)
};

export const mailtrapChannelPlugin = createChatChannelPlugin<ResolvedAccount>({
  base: {
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: "Mailtrap",
      selectionLabel: "Mailtrap (email)",
      docsPath: "/channels/mailtrap",
      blurb: "Email the agent at a Mailtrap Inbound address; it replies in the same conversation."
    },
    // Not consulted for direct messages; the before_tool_call hook (tool-policy.ts) is what denies tools on email turns.
    groups: { resolveToolPolicy: () => resolveEmailToolPolicy() },
    gateway: {
      async startAccount(ctx) {
        const log = toLogger(ctx.log, `[mailtrap/${ctx.accountId}] `);
        const host = getHostApi();
        await runAccount(
          ctx.account,
          ctx.abortSignal,
          {
            createApi: createInboundApi,
            openStore: createOpenStore(host),
            attachments: {
              download: defaultDownload,
              save: (buf, info) => saveInboundMedia(buf, info),
              mediaRoots: [getMediaDir()]
            },
            runAgentTurn: createAgentTurnRunner({
              cfg: ctx.cfg,
              accountId: ctx.accountId,
              host: turnHost,
              onError: (msg, err) => log.error(`${msg}: ${String(err)}`)
            })
          },
          log
        );
      }
    },
    config: {
      listAccountIds: (cfg) => listAccountIds(cfg),
      resolveAccount: (cfg, accountId) => resolveAccount(cfg, accountId),
      isEnabled: (account: ResolvedAccount) => account.enabled,
      isConfigured: (account: ResolvedAccount) => isConfigured(account),
      inspectAccount(cfg, accountId) {
        const account = resolveAccount(cfg, accountId);
        return {
          enabled: account.enabled,
          configured: isConfigured(account),
          tokenStatus: account.apiToken ? "available" : "missing"
        };
      }
    }
  }
});
