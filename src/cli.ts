import { createWebhookAdmin } from "./mailtrap-api.js";
import { isConfigured, resolveAccount } from "./config.js";
import { Ledger } from "./ledger.js";
import { createOpenStore, type HostApi } from "./openclaw-host.js";
import type { OpenStore, WebhookAdmin } from "./types.js";
import { connectWebhook, disconnectWebhook } from "./webhook-cli.js";

export interface WebhookCommandDeps {
  cfg: unknown;
  env: Record<string, string | undefined>;
  openStore: OpenStore;
  createAdmin?: (token: string, accountId: number) => WebhookAdmin;
}

export interface WebhookCommandOptions {
  account?: string;
  url?: string;
  replace?: boolean;
}

/** Runs `webhook connect|disconnect` and returns the lines to print. Throws a readable Error on misuse. */
export async function runWebhookCommand(action: "connect" | "disconnect", opts: WebhookCommandOptions, deps: WebhookCommandDeps): Promise<string[]> {
  const account = resolveAccount(deps.cfg, opts.account);
  if (!isConfigured(account)) {
    throw new Error(`Mailtrap account "${account.accountId}" is not configured (needs apiToken and inboxId under channels.mailtrap).`);
  }
  // Managing webhooks needs the broad account token, not the channel's own token.
  const token = deps.env.MAILTRAP_API_TOKEN?.trim();
  const mailtrapAccountId = Number(deps.env.MAILTRAP_ACCOUNT_ID);
  if (!token || !Number.isInteger(mailtrapAccountId) || mailtrapAccountId <= 0) {
    throw new Error("Set MAILTRAP_API_TOKEN (an account-level token) and MAILTRAP_ACCOUNT_ID in the environment to manage webhooks.");
  }
  const admin = (deps.createAdmin ?? createWebhookAdmin)(token, mailtrapAccountId);
  const ledger = new Ledger(deps.openStore, account.accountId);

  if (action === "disconnect") {
    const r = await disconnectWebhook({ admin, ledger });
    return [r.deleted ? `Webhook removed for account "${account.accountId}". The channel is polling again.` : `No webhook is connected for account "${account.accountId}".`];
  }
  if (!opts.url) throw new Error("--url <public https URL of this gateway> is required.");
  const r = await connectWebhook({ admin, ledger, accountId: account.accountId, inboxId: account.inboxId as number, publicUrl: opts.url, replace: opts.replace });
  return [
    `Webhook ${r.action} (id ${r.webhookId}) for inbox ${account.inboxId}.`,
    `Mailtrap will call ${r.url}`,
    "The signing secret is stored in the plugin's state. The channel now uses the webhook, with a catch-up poll at start and every 10 minutes."
  ];
}

interface CommandLike {
  command(name: string): CommandLike;
  description(text: string): CommandLike;
  option(flags: string, description: string): CommandLike;
  action(fn: (opts: WebhookCommandOptions) => Promise<void> | void): CommandLike;
}

export function registerMailtrapCli(program: CommandLike, deps: () => WebhookCommandDeps, print: (line: string) => void): void {
  const root = program.command("mailtrap").description("Mailtrap email channel");
  const webhook = root.command("webhook").description("Receive inbound mail by webhook instead of polling");
  for (const action of ["connect", "disconnect"] as const) {
    const cmd = webhook.command(action).description(action === "connect" ? "Create or update the Inbound webhook for this inbox" : "Delete the Inbound webhook and go back to polling");
    cmd.option("--account <id>", "channel account id (default: default)");
    if (action === "connect") {
      cmd.option("--url <url>", "public https URL of this gateway");
      cmd.option("--replace", "delete and recreate an existing webhook this plugin did not create");
    }
    cmd.action(async (opts) => {
      for (const line of await runWebhookCommand(action, opts, deps())) print(line);
    });
  }
}

export function cliDeps(api: HostApi, cfg: unknown): WebhookCommandDeps {
  return { cfg, env: process.env, openStore: createOpenStore(api) };
}
