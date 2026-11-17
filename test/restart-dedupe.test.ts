import { describe, expect, it } from "vitest";
import { pollOnce } from "../src/poller.js";
import { dispatchIdFor, type AgentTurnInput, type RunAgentTurn } from "../src/processor.js";
import { makeHarness } from "./helpers/harness.js";
import { makeMessage } from "./helpers/memory.js";
import { createAgentTurnRunner } from "../src/agent-turn.js";
import { makeTurnHost } from "./helpers/turn-host.js";

/**
 * Stand-in for OpenClaw's dispatch: a message id it already admitted is skipped as a duplicate
 * (empty result, as in dispatch-from-config `skipDuplicate`), and that memory survives the
 * plugin's own restart because it lives in the session store, not in the plugin.
 */
function core() {
  const admitted = new Set<string>();
  const dispatched: AgentTurnInput[] = [];
  const run: RunAgentTurn = async (input) => {
    dispatched.push(input);
    if (admitted.has(input.dispatchId)) return null;
    admitted.add(input.dispatchId);
    return { text: `answer to ${input.messageId}` };
  };
  return { admitted, dispatched, run };
}

describe("exactly one reply after a crash mid-turn", () => {
  it("the first dispatch keeps the plain message id and counts itself before it runs", async () => {
    const c = core();
    const h = makeHarness({
      runAgentTurn: async (input) => {
        const item = await h.ledger.get(input.messageId);
        expect(item).toMatchObject({ state: "processing", dispatchAttempts: 1 });
        return c.run(input);
      }
    });
    await pollOnce(h.api, 1001, h.ledger);
    const m = h.api.add(makeMessage());
    await pollOnce(h.api, 1001, h.ledger);
    await h.runtime.drain();
    expect(c.dispatched.map((d) => d.dispatchId)).toEqual([m.id]);
    expect(h.api.replies).toHaveLength(1);
  });

  it("re-runs an item left processing under a fresh dispatch id, so core does not skip it, and sends one reply", async () => {
    const c = core();
    const h = makeHarness({ runAgentTurn: c.run });
    await pollOnce(h.api, 1001, h.ledger);
    const m = h.api.add(makeMessage());
    // the gateway died 14 s into the turn: core admitted the message, the item stayed `processing`
    c.admitted.add(m.id);
    await h.ledger.enqueue(m.id, "poll");
    await h.ledger.update(m.id, { state: "processing", conversationKey: m.id, dispatchAttempts: 1 });
    await h.runtime.drain();
    expect(c.dispatched).toHaveLength(1);
    expect(c.dispatched[0]!.dispatchId).not.toBe(m.id);
    expect(c.dispatched[0]!.dispatchId).toBe(dispatchIdFor(m.id, 1));
    expect(c.dispatched[0]!.messageId).toBe(m.id);
    expect(h.api.replies).toHaveLength(1);
    expect(h.api.replies[0]!.params.text).toBe(`answer to ${m.id}`);
    expect(await h.ledger.get(m.id)).toMatchObject({ state: "done" });
    // nothing more is sent on another pass
    await h.runtime.drain();
    expect(h.api.replies).toHaveLength(1);
  });

  it("a turn that threw is retried under a new id as well", async () => {
    const c = core();
    let calls = 0;
    const now = { t: 1_000_000 };
    const h = makeHarness({
      now: () => now.t,
      runAgentTurn: async (input) => {
        if (calls++ === 0) {
          c.admitted.add(input.dispatchId);
          throw new Error("model down");
        }
        return c.run(input);
      }
    });
    await pollOnce(h.api, 1001, h.ledger);
    const m = h.api.add(makeMessage());
    await pollOnce(h.api, 1001, h.ledger);
    await h.runtime.drain();
    now.t += 10 * 60_000;
    await h.processor.process(m.id);
    expect(h.api.replies).toHaveLength(1);
    expect(h.api.replies[0]!.params.text).toBe(`answer to ${m.id}`);
  });

  it("live timeline (Retest 4b): core recovery holds the session, the dispatch returns empty, the queued turn delivers later; one reply, no no-reply drop", async () => {
    // core: while restart recovery owns the session a dispatch is skipped as busy (empty result, no run)
    // and its turn is queued; the queued turn runs after recovery and delivers to the old callback.
    let recovering = true;
    const dispatches: string[] = [];
    const queuedDeliveries: Array<() => Promise<void>> = [];
    const host = makeTurnHost(async (p) => {
      const plan = p as any;
      dispatches.push(plan.ctxPayload.MessageSid);
      if (recovering) {
        queuedDeliveries.push(async () => {
          plan.replyOptions.onQueuedFollowupAdmitted?.();
          await plan.delivery.deliver({ text: "queued answer, delivered late" });
        });
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      }
      plan.replyOptions.onAgentRunStart("run-2");
      await plan.delivery.deliver({ text: "answer after recovery" });
    });
    const now = { t: 1_000_000 };
    const h = makeHarness({ now: () => now.t, runAgentTurn: createAgentTurnRunner({ cfg: {}, accountId: "default", host, onError: () => {} }) });
    await pollOnce(h.api, 1001, h.ledger);
    const m = h.api.add(makeMessage());
    await h.ledger.enqueue(m.id, "poll");
    await h.ledger.update(m.id, { state: "processing", conversationKey: m.id, dispatchAttempts: 1 });
    await h.runtime.drain();
    // the plugin's dispatch came back empty while the session was busy: nothing dropped, nothing sent
    expect(await h.ledger.get(m.id)).toMatchObject({ state: "processing", notRunAttempts: 1 });
    expect(h.api.replies).toHaveLength(0);
    // the queued turn delivers after the plugin stopped collecting: goes nowhere
    recovering = false;
    for (const late of queuedDeliveries) await late();
    expect(h.api.replies).toHaveLength(0);
    // retry later, session idle: the turn runs and the one reply goes out
    now.t += 10 * 60_000;
    await h.processor.process(m.id);
    expect(dispatches).toEqual([dispatchIdFor(m.id, 1), dispatchIdFor(m.id, 2)]);
    expect(h.api.replies).toHaveLength(1);
    expect(h.api.replies[0]!.params.text).toBe("answer after recovery");
    expect(await h.ledger.get(m.id)).toMatchObject({ state: "done" });
    await h.runtime.drain();
    expect(h.api.replies).toHaveLength(1);
  });

  it("recovery outlasting several backoff steps (10 min busy): still one reply, not failed; a session busy past the window fails", async () => {
    let busyUntil = 0;
    const now = { t: 1_000_000 };
    busyUntil = now.t + 10 * 60_000;
    const host = makeTurnHost(async (p) => {
      const plan = p as any;
      if (now.t < busyUntil) return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      plan.replyOptions.onAgentRunStart("run");
      await plan.delivery.deliver({ text: "answer after long recovery" });
      plan.replyOptions.onAgentRunTerminalOutcome?.({ status: "completed" });
    });
    const h = makeHarness({ now: () => now.t, runAgentTurn: createAgentTurnRunner({ cfg: {}, accountId: "default", host, onError: () => {} }) });
    await pollOnce(h.api, 1001, h.ledger);
    const m = h.api.add(makeMessage());
    await h.ledger.enqueue(m.id, "poll");
    await h.ledger.update(m.id, { state: "processing", conversationKey: m.id, dispatchAttempts: 1 });
    for (let i = 0; i < 12 && h.api.replies.length === 0; i++) {
      await h.processor.process(m.id);
      const item = await h.ledger.get(m.id);
      expect(item?.state).not.toBe("failed");
      if (item?.retryAt) now.t = Math.max(now.t, item.retryAt);
    }
    expect(h.api.replies).toHaveLength(1);
    expect(await h.ledger.get(m.id)).toMatchObject({ state: "done" });

    // a session that never frees up: failed once the window is over, with its own reason
    const h2 = makeHarness({ now: () => now.t, runAgentTurn: createAgentTurnRunner({ cfg: {}, accountId: "default", host: makeTurnHost(async () => ({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } })), onError: () => {} }) });
    await pollOnce(h2.api, 1001, h2.ledger);
    const m2 = h2.api.add(makeMessage());
    await h2.ledger.enqueue(m2.id, "poll");
    await h2.ledger.update(m2.id, { state: "processing", conversationKey: m2.id, dispatchAttempts: 1 });
    for (let i = 0; i < 40; i++) {
      await h2.processor.process(m2.id);
      const item = await h2.ledger.get(m2.id);
      if (item?.state === "failed") break;
      now.t = Math.max(now.t, item?.retryAt ?? now.t);
    }
    expect(await h2.ledger.get(m2.id)).toMatchObject({ state: "failed", reason: "session-busy-timeout" });
    expect(h2.api.replies).toHaveLength(0);
  });

  it("queued follow-up admitted before the dispatch returns, delivery after: retried, exactly one reply, no no-reply drop", async () => {
    let recovering = true;
    const dispatches: string[] = [];
    const late: Array<() => Promise<void>> = [];
    const host = makeTurnHost(async (p) => {
      const plan = p as any;
      dispatches.push(plan.ctxPayload.MessageSid);
      if (recovering) {
        // admission is reported during the dispatch, the queued turn's output arrives after it returned
        plan.replyOptions.onQueuedFollowupAdmitted?.("run-q");
        late.push(() => plan.delivery.deliver({ text: "queued answer, delivered late" }));
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      }
      plan.replyOptions.onAgentRunStart("run-2");
      await plan.delivery.deliver({ text: "answer after recovery" });
    });
    const now = { t: 1_000_000 };
    const h = makeHarness({ now: () => now.t, runAgentTurn: createAgentTurnRunner({ cfg: {}, accountId: "default", host, onError: () => {} }) });
    await pollOnce(h.api, 1001, h.ledger);
    const m = h.api.add(makeMessage());
    await h.ledger.enqueue(m.id, "poll");
    await h.ledger.update(m.id, { state: "processing", conversationKey: m.id, dispatchAttempts: 1 });
    await h.runtime.drain();
    expect(await h.ledger.get(m.id)).toMatchObject({ state: "processing", notRunAttempts: 1 });
    recovering = false;
    for (const f of late) await f();
    expect(h.api.replies).toHaveLength(0);
    now.t += 10 * 60_000;
    await h.processor.process(m.id);
    expect(h.api.replies).toHaveLength(1);
    expect(h.api.replies[0]!.params.text).toBe("answer after recovery");
    expect(await h.ledger.get(m.id)).toMatchObject({ state: "done" });
  });
});
