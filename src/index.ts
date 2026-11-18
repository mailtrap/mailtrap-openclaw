import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { readRequestBodyWithLimit, runDetachedWebhookWork } from "openclaw/plugin-sdk/webhook-request-guards";
import { mailtrapChannelPlugin } from "./channel.js";
import { cliDeps, registerMailtrapCli } from "./cli.js";
import { setHostApi, type HostApi } from "./openclaw-host.js";
import { guardToolCall } from "./tool-policy.js";
import { WEBHOOK_PATH } from "./webhook.js";
import { createWebhookRouteHandler } from "./webhook-route.js";

export default defineChannelPluginEntry({
  id: "mailtrap",
  name: "Mailtrap",
  description:
    "Mailtrap skills, MCP server and an email channel: send email, use templates, manage contacts, read Inbound and Sandbox inboxes, and let people email the agent.",
  plugin: mailtrapChannelPlugin,
  registerCliMetadata(api) {
    api.registerCli(
      ({ program, config }) => {
        registerMailtrapCli(
          program as never,
          () => cliDeps(api as unknown as HostApi, config),
          (line) => console.log(line)
        );
      },
      { descriptors: [{ name: "mailtrap", description: "Mailtrap email channel", hasSubcommands: true }] }
    );
  },
  registerFull(api) {
    setHostApi(api as unknown as HostApi);
    // The deny layer for email turns: OpenClaw skips group.resolveToolPolicy for direct messages, so this hook is the one that works.
    api.on("before_tool_call", (event, ctx) => guardToolCall(event, ctx));
    api.registerHttpRoute({
      path: WEBHOOK_PATH,
      auth: "plugin", // the Mailtrap-Signature header is checked in handleWebhook
      match: "prefix",
      handler: createWebhookRouteHandler({
        readBody: (req, opts) => readRequestBodyWithLimit(req, opts),
        runDetached: (work) => runDetachedWebhookWork(work)
      })
    });
  }
});
