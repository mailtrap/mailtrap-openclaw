import { resolveReplyIdentity } from "../../src/config.js";
import { Ledger } from "../../src/ledger.js";
import { Processor, type AgentTurnInput, type RunAgentTurn } from "../../src/processor.js";
import { AccountRuntime } from "../../src/runtime.js";
import type { Authenticator } from "../../src/sender-check.js";
import { silentLogger } from "../../src/types.js";
import { FakeInbound, memoryOpenStore } from "./memory.js";

export interface HarnessOptions {
  allowFrom?: string[];
  authenticate?: Authenticator;
  runAgentTurn?: RunAgentTurn;
  openStore?: ReturnType<typeof memoryOpenStore>;
  api?: FakeInbound;
  /** Use a custom-domain inbox and send replies from this address. */
  customFrom?: string;
  inbound?: ConstructorParameters<typeof Processor>[0]["inbound"];
  now?: () => number;
  outbound?: ConstructorParameters<typeof Processor>[0]["outbound"];
}

export function makeHarness(opts: HarnessOptions = {}) {
  const api = opts.api ?? new FakeInbound();
  const openStore = opts.openStore ?? memoryOpenStore();
  const ledger = new Ledger(openStore, "default");
  const turns: AgentTurnInput[] = [];
  const runAgentTurn: RunAgentTurn =
    opts.runAgentTurn ??
    (async (input) => {
      turns.push(input);
      return { text: `echo: ${input.body}` };
    });
  if (opts.customFrom) api.inbox = { id: 1001, name: "t", address: "*@mail.example.test" };
  const identity = resolveReplyIdentity(api.inbox, opts.customFrom);
  const processor = new Processor({
    accountId: "default",
    inboxId: 1001,
    api,
    ledger,
    identity,
    allowFrom: opts.allowFrom ?? ["alex@example.test"],
    authenticate: opts.authenticate ?? (async () => ({ ok: true })),
    runAgentTurn,
    inbound: opts.inbound,
    outbound: opts.outbound,
    now: opts.now,
    log: silentLogger
  });
  const runtime = new AccountRuntime({ api, inboxId: 1001, ledger, processor, pollIntervalMs: 60_000, log: silentLogger });
  return { api, openStore, ledger, processor, runtime, turns, identity };
}
