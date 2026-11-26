import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentTurnRunner, emailSessionKey, type TurnHost } from "../src/agent-turn.js";
import { pollOnce } from "../src/poller.js";
import { TURN_ADMISSION_WAIT_MS, TURN_OUTCOME_WAIT_MS, TurnAbortedError, TurnNotRunError, TurnOutcomeUnknownError } from "../src/processor.js";
import { guardToolCall, isEmailSessionKey } from "../src/tool-policy.js";
import { makeHarness } from "./helpers/harness.js";
import { makeMessage } from "./helpers/memory.js";
import { makeTurnHost, realTurnHost } from "./helpers/turn-host.js";

const input = {
  accountId: "default",
  conversationKey: "conv-1",
  messageId: "m1",
  dispatchId: "m1",
  sender: { email: "alex@example.test", name: "Alex" },
  subject: "Hi",
  body: "Body",
  receivedAt: "2026-11-09T12:00:00.000Z",
  inboxAddress: "agent-test@inbound-mailtrap.io",
  media: []
};
/** A turn that ran and said nothing: core reports the run through replyOptions. */
const ranSilently = (p: Record<string, any>) => p.replyOptions.onAgentRunTerminalOutcome("completed");
/** Core's busy-session result (dispatch-from-config:2896-2909): the same shape as a silent turn. */
const busy = { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
/** Lets pending promise callbacks run; timers are faked, setImmediate is not. */
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};
const fakeTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
const key = (cfg: unknown, account = "default", sender = "alex@example.test", conv = "conv-1") => emailSessionKey(realTurnHost, cfg, account, sender, conv).sessionKey;

describe("session key, real routing functions", () => {
  it("has the documented shape on an empty config", () => {
    expect(key({})).toBe("agent:main:mailtrap:default:direct:alex@example.test:thread:conv-1");
  });
  it("stays an email key under dmScope main, never the main session", () => {
    const k = key({ session: { dmScope: "main" } });
    expect(k).toBe("agent:main:mailtrap:default:direct:alex@example.test:thread:conv-1");
    expect(isEmailSessionKey(k)).toBe(true);
  });
  it("honours identityLinks for the sender but keeps the conversation suffix and the email prefix", () => {
    const cfg = { session: { dmScope: "main", identityLinks: { owner: ["mailtrap:alex@example.test"] } } };
    const k = key(cfg);
    expect(k).toBe("agent:main:mailtrap:default:direct:owner:thread:conv-1");
    expect(isEmailSessionKey(k)).toBe(true);
  });
  it("separates conversations, accounts and senders", () => {
    const keys = [key({}), key({}, "default", "alex@example.test", "conv-2"), key({}, "work"), key({}, "default", "sam@example.test")];
    expect(new Set(keys).size).toBe(4);
  });
  it("does not touch the user's config", () => {
    const cfg = { session: { dmScope: "main", identityLinks: { owner: ["mailtrap:alex@example.test"] } } };
    const before = JSON.stringify(cfg);
    key(cfg);
    expect(JSON.stringify(cfg)).toBe(before);
  });
});

describe("agent turn runner", () => {
  it("collects a file given in both mediaUrls and mediaUrl once", async () => {
    const stored = "/media/mailtrap/summary---0b9e8c3e-6f1d-4c52-9a7e-1d2f3a4b5c6d.txt";
    const host = makeTurnHost(async (p) => {
      await (p as any).delivery.deliver({ text: "see file", mediaUrls: [stored], mediaUrl: stored });
    });
    const reply = await createAgentTurnRunner({ cfg: {}, accountId: "default", host, onError: () => {} })(input);
    expect(reply!.media).toEqual([{ path: stored, filename: "summary---0b9e8c3e-6f1d-4c52-9a7e-1d2f3a4b5c6d.txt" }]);
  });

  it("dispatches a non-command direct turn carrying what dispatchInboundDirectDm set, and collects deliveries", async () => {
    let plan: Record<string, any> | undefined;
    const host = makeTurnHost(async (p) => {
      plan = p;
      await (p as any).delivery.deliver({ text: "one" });
      await (p as any).delivery.deliver({ text: "two", mediaUrls: ["/media/a.png"] });
    });
    const run = createAgentTurnRunner({ cfg: {}, accountId: "default", host, onError: () => {} });
    const reply = await run({ ...input, media: [{ path: "/media/in.pdf", filename: "in.pdf", contentType: "application/pdf" }] });
    const key = "agent:main:mailtrap:default:direct:alex@example.test:thread:conv-1";
    expect(plan).toMatchObject({ channel: "mailtrap", accountId: "default", route: { agentId: "main", sessionKey: key } });
    expect(plan!.ctxPayload).toMatchObject({
      SessionKey: key,
      From: "alex@example.test",
      To: "agent-test@inbound-mailtrap.io",
      ChatType: "direct",
      SenderId: "alex@example.test",
      ConversationRoutePeerId: "alex@example.test",
      OriginatingChannel: "mailtrap",
      OriginatingTo: "alex@example.test",
      NativeDirectUserId: "alex@example.test",
      CommandAuthorized: false,
      InboundAccessAuthorized: true,
      ConversationRouteContextObserved: true,
      RawBody: "Subject: Hi\n\nBody",
      BodyForAgent: "Subject: Hi\n\nBody",
      Body: "[Mailtrap] alex@example.test: Hi: Subject: Hi\n\nBody",
      MessageSid: "m1",
      // OpenClaw folds the legacy Media* keys into `media` facts when it finalizes the context.
      media: [expect.objectContaining({ path: "/media/in.pdf", contentType: "application/pdf" })]
    });
    expect(plan!.record.onRecordError).toBeTypeOf("function");
    expect(plan!.replyPipeline).toEqual({ marker: "pipeline" });
    expect(reply).toEqual({ text: "one\n\ntwo", media: [{ path: "/media/a.png", filename: "a.png" }] });
  });

  it("sends the dispatch id, not the Mailtrap id, as MessageSid so a re-run is not skipped as a duplicate", async () => {
    const run = async (dispatchId: string) => {
      const seen: Record<string, any> = {};
      const base = makeTurnHost(async (p) => (Object.assign(seen, p), ranSilently(p)));
      const built: Array<Record<string, any>> = [];
      const host = { ...base, buildContext: (p: any) => (built.push(p), base.buildContext(p)) };
      await createAgentTurnRunner({ cfg: {}, accountId: "default", host, onError: () => {} })({ ...input, messageId: "m1", dispatchId });
      return { plan: seen, built: built[0]! };
    };
    const first = await run("m1");
    const retry = await run("m1:retry-1");
    expect(retry.built).toMatchObject({ messageId: "m1:retry-1", messageIdFull: "m1:retry-1" });
    expect(retry.plan.ctxPayload).toMatchObject({ MessageSid: "m1:retry-1", MessageSidFull: "m1:retry-1" });
    expect(first.plan.ctxPayload.MessageSid).toBe("m1");
    expect(retry.plan.route.sessionKey).toBe(first.plan.route.sessionKey);
    expect(retry.plan.ctxPayload.SessionKey).toBe(first.plan.ctxPayload.SessionKey);
  });

  it("never lets the media context overwrite the session key", async () => {
    let plan: Record<string, any> | undefined;
    const run = createAgentTurnRunner({ cfg: {}, accountId: "default", host: makeTurnHost(async (p) => ((plan = p), ranSilently(p))), onError: () => {} });
    await run({ ...input, media: [{ path: "/m/x", filename: "x", contentType: "image/png" }] });
    expect(plan!.ctxPayload.SessionKey).toBe(plan!.route.sessionKey);
  });

  it("returns null when the agent said nothing and throws when dispatch failed", async () => {
    expect(await createAgentTurnRunner({ cfg: {}, accountId: "d", onError: () => {}, host: makeTurnHost(async (p) => ranSilently(p)) })(input)).toBeNull();
    await expect(
      createAgentTurnRunner({ cfg: {}, accountId: "d", onError: () => {}, host: makeTurnHost(async (p) => (p as any).delivery.onError(new Error("model down"), { kind: "final" })) })(input)
    ).rejects.toThrow("model down");
  });

  it("busy session: a dispatch that returns with no run and no payloads is not a no-reply (core result shape of dispatch-from-config:2896-2909)", async () => {
    fakeTimers();
    try {
      const host = makeTurnHost(async () => busy);
      const outcome = createAgentTurnRunner({ cfg: {}, accountId: "d", onError: () => {}, host })(input).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(TURN_ADMISSION_WAIT_MS);
      expect(await outcome).toBeInstanceOf(TurnNotRunError);
      // no wait leaves a timer behind
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an inline run that finished before the dispatch returned answers at once, with its payloads or as silence", async () => {
    fakeTimers();
    try {
      const mk = (fn: (p: any) => Promise<unknown>) => createAgentTurnRunner({ cfg: {}, accountId: "d", onError: () => {}, host: makeTurnHost(async (p) => fn(p)) });
      const reply = mk(async (p) => {
        p.replyOptions.onAgentRunStart("run-1");
        await p.delivery.deliver({ text: "inline" });
        p.replyOptions.onAgentRunTerminalOutcome("completed");
      })(input);
      const silent = mk(async (p) => {
        p.replyOptions.onAgentRunStart("run-1");
        p.replyOptions.onAgentRunTerminalOutcome("completed");
      })(input);
      // no timer is advanced: neither waits
      expect(await reply).toEqual({ text: "inline", media: [] });
      expect(await silent).toBeNull();
      // no wait leaves a timer behind
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a run that started without a terminal outcome waits for a queued follow-up, and is retried when none is admitted", async () => {
    fakeTimers();
    try {
      for (const hook of ["onAgentRunStart", "onPreparedAgentRunStart"]) {
        const host = makeTurnHost(async (p) => ((p as any).replyOptions[hook]("run-1"), busy));
        let settled = false;
        const outcome = createAgentTurnRunner({ cfg: {}, accountId: "d", onError: () => {}, host })(input)
          .catch((e: unknown) => e)
          .finally(() => (settled = true));
        await vi.advanceTimersByTimeAsync(TURN_ADMISSION_WAIT_MS - 1);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await outcome).toBeInstanceOf(TurnNotRunError);
      }
      // no wait leaves a timer behind
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a signal already aborted when a wait starts ends the turn at once: aborted before an admission, interrupted after one", async () => {
    fakeTimers();
    try {
      const signal = AbortSignal.abort();
      for (const admitDuringDispatch of [false, true]) {
        const host = makeTurnHost(async (p) => (admitDuringDispatch && (p as any).replyOptions.onQueuedFollowupAdmitted(), busy));
        const err = await createAgentTurnRunner({ cfg: {}, accountId: "d", onError: () => {}, host })({ ...input, signal }).catch((e: unknown) => e);
        if (admitDuringDispatch) expect(err).toMatchObject({ name: "TurnOutcomeUnknownError", reason: "turn-interrupted" });
        else expect(err).toBeInstanceOf(TurnAbortedError);
        expect(vi.getTimerCount()).toBe(0);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("the key the turn runs under is blocked by the tool guard", async () => {
    let sk = "";
    await createAgentTurnRunner({ cfg: { session: { dmScope: "main" } }, accountId: "default", onError: () => {}, host: makeTurnHost(async (p) => ((sk = (p as any).route.sessionKey), ranSilently(p))) })(input);
    expect(guardToolCall({ toolName: "mailtrap__send-email" }, { channelId: "alex@example.test", sessionKey: sk })).toMatchObject({ block: true });
  });
});

describe("a turn queued behind an active run", () => {
  afterEach(() => {
    // every resolve, timeout and abort path clears its timer
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  /** The account pipeline with a real turn runner over a fake dispatch; each dispatch's plan is kept for late events. */
  async function setup(dispatch: (plan: any) => unknown = () => busy) {
    fakeTimers();
    const plans: any[] = [];
    const host: TurnHost = makeTurnHost(async (p) => {
      plans.push(p);
      return dispatch(p);
    });
    const h = makeHarness({ runAgentTurn: createAgentTurnRunner({ cfg: {}, accountId: "default", host, onError: () => {} }) });
    await pollOnce(h.api, 1001, h.ledger);
    const m = h.api.add(makeMessage());
    await pollOnce(h.api, 1001, h.ledger);
    const drained = h.runtime.drain();
    await flush();
    expect(plans).toHaveLength(1);
    return { h, m, plans, drained, ro: plans[0]!.replyOptions, delivery: plans[0]!.delivery };
  }

  it("busy return, admitted later, delivers, settles: one reply, one dispatch, done", async () => {
    const { h, m, plans, drained, ro, delivery } = await setup();
    await vi.advanceTimersByTimeAsync(60_000);
    await ro.onQueuedFollowupAdmitted();
    await vi.advanceTimersByTimeAsync(TURN_ADMISSION_WAIT_MS);
    ro.onAgentRunStart("run-q");
    await delivery.deliver({ text: "late answer" });
    // the terminal outcome comes before the follow-up's final payloads are delivered; it is not the end
    ro.onAgentRunTerminalOutcome("completed");
    await flush();
    expect(h.api.replies).toHaveLength(0);
    await delivery.deliver({ text: "final part" });
    await ro.onQueuedFollowupSettled();
    await drained;
    expect(plans).toHaveLength(1);
    expect(h.api.replies.map((r) => r.params.text)).toEqual(["late answer\n\nfinal part"]);
    expect(await h.ledger.get(m.id)).toMatchObject({ state: "done" });
  });

  it("admitted but never settled: failed as turn-outcome-timeout, nothing sent, never dispatched again", async () => {
    const { h, m, plans, drained, ro } = await setup();
    await ro.onQueuedFollowupAdmitted();
    await vi.advanceTimersByTimeAsync(TURN_OUTCOME_WAIT_MS - 1);
    expect((await h.ledger.get(m.id))?.state).toBe("processing");
    await vi.advanceTimersByTimeAsync(1);
    await drained;
    expect(await h.ledger.get(m.id)).toMatchObject({ state: "failed", reason: "turn-outcome-timeout" });
    await h.runtime.drain();
    expect(plans).toHaveLength(1);
    expect(h.api.replies).toHaveLength(0);
  });

  it("busy return, never admitted: retried later as not run, as before", async () => {
    const { h, m, drained } = await setup();
    await vi.advanceTimersByTimeAsync(TURN_ADMISSION_WAIT_MS);
    await drained;
    const item = await h.ledger.get(m.id);
    expect(item).toMatchObject({ state: "processing", notRunAttempts: 1 });
    expect(item?.retryAt).toBeTypeOf("number");
    expect(h.api.replies).toHaveLength(0);
  });

  it("admitted during the dispatch: goes straight to waiting for the settle, then replies", async () => {
    const { h, m, plans, drained, ro, delivery } = await setup((p) => (p.replyOptions.onQueuedFollowupAdmitted(), busy));
    await vi.advanceTimersByTimeAsync(TURN_ADMISSION_WAIT_MS + 1);
    expect((await h.ledger.get(m.id))?.notRunAttempts).toBeUndefined();
    await delivery.deliver({ text: "queued answer" });
    await ro.onQueuedFollowupSettled();
    await drained;
    expect(plans).toHaveLength(1);
    expect(h.api.replies.map((r) => r.params.text)).toEqual(["queued answer"]);
    expect(await h.ledger.get(m.id)).toMatchObject({ state: "done" });
  });

  it("admitted, completed and settled with nothing to say: a real silence", async () => {
    const { h, m, drained, ro } = await setup();
    await ro.onQueuedFollowupAdmitted();
    ro.onAgentRunTerminalOutcome("completed");
    await ro.onQueuedFollowupSettled();
    await drained;
    expect(await h.ledger.get(m.id)).toMatchObject({ state: "dropped", reason: "no-reply" });
  });

  it("settled after a failed outcome with nothing delivered: failed, not dropped as no reply (core may run it again)", async () => {
    const { h, m, plans, drained, ro } = await setup();
    await ro.onQueuedFollowupAdmitted();
    ro.onAgentRunTerminalOutcome("failed");
    await ro.onQueuedFollowupSettled();
    await drained;
    expect(await h.ledger.get(m.id)).toMatchObject({ state: "failed", reason: "turn-outcome-unknown" });
    expect(plans).toHaveLength(1);
    expect(h.api.replies).toHaveLength(0);
  });

  it("settled with no terminal outcome after the admission: failed, not dropped as no reply", async () => {
    const { h, m, drained, ro } = await setup();
    await ro.onQueuedFollowupAdmitted();
    await ro.onQueuedFollowupSettled();
    await drained;
    expect(await h.ledger.get(m.id)).toMatchObject({ state: "failed", reason: "turn-outcome-unknown" });
    expect(h.api.replies).toHaveLength(0);
  });

  for (const admittedDuringDispatch of [false, true]) {
    it(`abort during the settle wait, admitted ${admittedDuringDispatch ? "during the dispatch" : "after it returned"}: interrupted, never dispatched again`, async () => {
      fakeTimers();
      const abort = new AbortController();
      let dispatches = 0;
      let ro: any;
      const host = makeTurnHost(async (p) => {
        dispatches++;
        ro = (p as any).replyOptions;
        if (admittedDuringDispatch) ro.onQueuedFollowupAdmitted();
        return busy;
      });
      const outcome = createAgentTurnRunner({ cfg: {}, accountId: "d", onError: () => {}, host })({ ...input, signal: abort.signal }).catch((e: unknown) => e);
      await flush();
      if (!admittedDuringDispatch) await ro.onQueuedFollowupAdmitted();
      await vi.advanceTimersByTimeAsync(60_000);
      abort.abort();
      const err = await outcome;
      expect(err).toBeInstanceOf(TurnOutcomeUnknownError);
      expect(err).toMatchObject({ reason: "turn-interrupted" });
      expect(dispatches).toBe(1);
    });
  }

  it("stop during the admission wait returns promptly and leaves the item processing, counters unchanged", async () => {
    const { h, m, drained } = await setup();
    const before = await h.ledger.get(m.id);
    let stopped = false;
    const stop = h.runtime.stop().then(() => (stopped = true));
    await flush();
    expect(stopped).toBe(true);
    await stop;
    await drained;
    const after = await h.ledger.get(m.id);
    expect(after).toEqual(before);
    expect(after).toMatchObject({ state: "processing", dispatchAttempts: 1 });
    expect(after?.notRunAttempts).toBeUndefined();
    expect(after?.turnAttempts).toBeUndefined();
    expect(h.api.replies).toHaveLength(0);
  });

  it("stop during the settle wait returns promptly and fails the item as turn-interrupted, counters unchanged", async () => {
    const { h, m, drained, ro } = await setup();
    await ro.onQueuedFollowupAdmitted();
    let stopped = false;
    const stop = h.runtime.stop().then(() => (stopped = true));
    await flush();
    expect(stopped).toBe(true);
    await stop;
    await drained;
    const after = await h.ledger.get(m.id);
    expect(after).toMatchObject({ state: "failed", reason: "turn-interrupted", dispatchAttempts: 1 });
    expect(after?.notRunAttempts).toBeUndefined();
    expect(after?.turnAttempts).toBeUndefined();
    expect(h.api.replies).toHaveLength(0);
  });
});
