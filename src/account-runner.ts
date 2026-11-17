import { isConfigured, resolveReplyIdentity, type ResolvedAccount } from "./config.js";
import { createDkimAuthenticator, unauthenticated } from "./dkim.js";
import { Ledger } from "./ledger.js";
import { Processor, type RunAgentTurn } from "./processor.js";
import { AccountRuntime } from "./runtime.js";
import type { InboundApi, Logger, OpenStore } from "./types.js";

export interface AccountRunnerDeps {
  createApi: (token: string) => InboundApi;
  openStore: OpenStore;
  runAgentTurn: RunAgentTurn;
  /** Attachment I/O; omitted in tests that don't exercise attachments. */
  attachments?: {
    download: (url: string, maxBytes: number) => Promise<Buffer>;
    save: (buf: Buffer, info: { filename: string; contentType?: string; maxBytes: number }) => Promise<{ path: string; contentType?: string }>;
    mediaRoots: string[];
  };
}

/** A started account; the webhook route and CLI look these up by account id. */
export interface RunningAccount {
  accountId: string;
  inboxId: number;
  ledger: Ledger;
  runtime: AccountRuntime;
  processor: Processor;
}

const running = new Map<string, RunningAccount>();

export function getRunningAccount(accountId: string): RunningAccount | undefined {
  return running.get(accountId);
}

export function allRunningAccounts(): RunningAccount[] {
  return [...running.values()];
}

/**
 * Starts one account and resolves when it is stopped. Throws before polling
 * if the account is misconfigured or its inbox can't be read, so the gateway
 * reports the account as failed instead of silently doing nothing.
 */
export async function runAccount(account: ResolvedAccount, signal: AbortSignal, deps: AccountRunnerDeps, log: Logger): Promise<void> {
  if (!account.enabled) return;
  if (!isConfigured(account)) throw new Error(`mailtrap account "${account.accountId}" needs apiToken and inboxId`);
  const inboxId = account.inboxId as number;
  const api = deps.createApi(account.apiToken as string);
  const inbox = await api.getInbox(inboxId);
  const identity = resolveReplyIdentity(inbox, account.from);

  if (account.allowUnauthenticated) {
    log.warn("mailtrap: allowUnauthenticated is on. DKIM is NOT checked; use this for testing only", { account: account.accountId });
  }
  if (account.allowFrom.length === 0) {
    log.warn("mailtrap: allowFrom is empty, so every message will be dropped", { account: account.accountId });
  }

  const ledger = new Ledger(deps.openStore, account.accountId);
  const processor = new Processor({
    accountId: account.accountId,
    inboxId,
    api,
    ledger,
    identity,
    allowFrom: account.allowFrom,
    authenticate: account.allowUnauthenticated ? unauthenticated : createDkimAuthenticator({ api, inboxId }),
    runAgentTurn: deps.runAgentTurn,
    ...(deps.attachments
      ? {
          inbound: { maxBytes: account.mediaMaxBytes, download: deps.attachments.download, save: deps.attachments.save },
          outbound: { roots: deps.attachments.mediaRoots, maxBytes: account.outboundMaxBytes }
        }
      : {}),
    log
  });
  const runtime = new AccountRuntime({ api, inboxId, ledger, processor, pollIntervalMs: account.pollIntervalMs, log });
  running.get(account.accountId)?.runtime.stop();
  const entry: RunningAccount = { accountId: account.accountId, inboxId, ledger, runtime, processor };
  running.set(account.accountId, entry);

  void runtime.start(signal);
  await new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
  await runtime.stop();
  if (running.get(account.accountId) === entry) running.delete(account.accountId);
}
