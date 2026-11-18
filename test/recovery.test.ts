import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { Ledger } from "../src/ledger.js";
import { pollOnce } from "../src/poller.js";
import type { InboundThread } from "../src/types.js";
import { makeHarness } from "./helpers/harness.js";
import { makeMessage, memoryOpenStore, type FakeInbound } from "./helpers/memory.js";

const fixture = (name: string) => JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", name), "utf8"));

/** Leaves an item exactly as a crash between "mark sending" and "reply returned" would. */
async function crashedMidReply(h: ReturnType<typeof makeHarness>, over: Partial<ReturnType<typeof makeMessage>> = {}) {
  await pollOnce(h.api, 1001, h.ledger);
  const m = h.api.add(makeMessage(over));
  await h.ledger.enqueue(m.id, "poll");
  await h.ledger.update(m.id, {
    state: "sending",
    conversationKey: m.id,
    threadId: m.thread_id,
    inboundRfcId: m.rfc_message_id,
    inboundReceivedAt: m.received_at,
    reply: { text: "the answer", media: [] },
    sendStartedAt: Date.now()
  });
  return m;
}

/** An outbound reply in the inbound message's thread; like live data, its `in_reply_to` is the inbound Message-ID. */
const outboundIn = (api: FakeInbound, inbound: { thread_id: string | null; rfc_message_id: string }, over: Record<string, unknown> = {}) =>
  api.threads.set(inbound.thread_id!, {
    id: inbound.thread_id!,
    messages: [{ id: "00000000-0000-4000-8000-0000000000aa", direction: "outbound", rfc_message_id: "<00000000-0000-4000-8000-0000000000aa@inbound-mailtrap.io>", in_reply_to: inbound.rfc_message_id, created_at: "2026-11-09T23:00:00.000Z", ...over }]
  } as InboundThread);

describe("crash safety", () => {
  it("marks the item done without resending when the thread already has the outbound reply", async () => {
    const h = makeHarness();
    const m = await crashedMidReply(h);
    outboundIn(h.api, m);
    await h.runtime.drain();
    expect(h.api.replies).toHaveLength(0);
    expect(await h.ledger.get(m.id)).toMatchObject({ state: "done", sentMessageIds: ["00000000-0000-4000-8000-0000000000aa"] });
  });

  it("does not resend when closing the item fails after the reply was found in the thread", async () => {
    const h = makeHarness();
    const m = await crashedMidReply(h);
    outboundIn(h.api, m);
    vi.spyOn(h.processor, "complete").mockRejectedValueOnce(new Error("store write failed"));
    await expect(h.processor.reconcile(m.id)).rejects.toThrow("store write failed");
    expect(h.api.replies).toHaveLength(0);
    expect((await h.ledger.get(m.id))?.state).toBe("sending");
    expect(await h.processor.reconcile(m.id)).toBe("done");
    expect(h.api.replies).toHaveLength(0);
  });

  it("records the outbound Message-ID it found so a follow-up still joins the session", async () => {
    const h = makeHarness();
    const m = await crashedMidReply(h);
    outboundIn(h.api, m);
    await h.runtime.drain();
    const follow = h.api.add(makeMessage({ in_reply_to: "<00000000-0000-4000-8000-0000000000aa@inbound-mailtrap.io>" }));
    await pollOnce(h.api, 1001, h.ledger);
    await h.runtime.drain();
    expect((await h.ledger.get(follow.id))?.conversationKey).toBe(m.id);
  });

  it("resends when the thread has no outbound message after the inbound one", async () => {
    const h = makeHarness();
    const m = await crashedMidReply(h);
    h.api.threads.set(m.thread_id!, { id: m.thread_id!, messages: [{ id: m.id, direction: "inbound", rfc_message_id: m.rfc_message_id, in_reply_to: null, created_at: m.received_at }] });
    await h.runtime.drain();
    expect(h.api.replies).toHaveLength(1);
    expect(h.api.replies[0]!.params.text).toBe("the answer");
    expect((await h.ledger.get(m.id))?.state).toBe("done");
  });

  it("does not mistake an outbound that answers another message for this reply", async () => {
    const h = makeHarness();
    const m = await crashedMidReply(h);
    outboundIn(h.api, m, { in_reply_to: "<some-other-message@example.test>" });
    await h.runtime.drain();
    expect(h.api.replies).toHaveLength(1);
  });

  it("two inbound messages in one thread each get their own reply: the first one's reply does not close the second", async () => {
    const h = makeHarness();
    const first = await crashedMidReply(h, { id: "m-first", rfc_message_id: "<first@example.test>", received_at: "2026-11-09T12:00:00.000Z" });
    // the thread holds the reply to the first message, created after the second one arrived
    const second = h.api.add(makeMessage({ id: "m-second", thread_id: first.thread_id, rfc_message_id: "<second@example.test>", received_at: "2026-11-09T12:05:00.000Z" }));
    await h.ledger.enqueue(second.id, "poll");
    await h.ledger.update(second.id, { state: "sending", conversationKey: first.id, threadId: second.thread_id, inboundRfcId: second.rfc_message_id, inboundReceivedAt: second.received_at, reply: { text: "second answer", media: [] }, sendStartedAt: Date.now() });
    outboundIn(h.api, first, { created_at: "2026-11-09T12:10:00.000Z" });
    await h.runtime.drain();
    expect((await h.ledger.get(first.id))?.state).toBe("done");
    expect(h.api.replies.map((r) => [r.messageId, r.params.text])).toEqual([[second.id, "second answer"]]);
    expect((await h.ledger.get(second.id))?.state).toBe("done");
  });

  it("falls back to resending when the thread can't be read (404 or network)", async () => {
    const h = makeHarness();
    const m = await crashedMidReply(h);
    h.api.getThreadImpl = async () => {
      throw new Error("ECONNRESET");
    };
    await h.runtime.drain();
    expect(h.api.replies).toHaveLength(1);
    expect((await h.ledger.get(m.id))?.state).toBe("done");
  });

  it("resends when the item has no thread id at all", async () => {
    const h = makeHarness();
    const m = await crashedMidReply(h, { thread_id: null });
    await h.ledger.update(m.id, { threadId: null });
    await h.runtime.drain();
    expect(h.api.replies).toHaveLength(1);
  });

  it("finishes an item whose reply call returned ids but never reached `done`", async () => {
    const h = makeHarness();
    const m = await crashedMidReply(h);
    await h.ledger.update(m.id, { sentMessageIds: ["u-1"] });
    await h.runtime.drain();
    expect(h.api.replies).toHaveLength(0);
    expect(await h.ledger.get(m.id)).toMatchObject({ state: "done", sentMessageIds: ["u-1"] });
  });

  it("survives a real restart: a new runtime on the same store reconciles the item", async () => {
    const openStore = memoryOpenStore();
    const before = makeHarness({ openStore });
    const m = await crashedMidReply(before);
    const after = makeHarness({ openStore, api: before.api });
    expect(await new Ledger(openStore, "default").get(m.id)).toMatchObject({ state: "sending" });
    outboundIn(after.api, m);
    await after.runtime.start();
    await after.runtime.stop();
    expect(after.api.replies).toHaveLength(0);
    expect((await after.ledger.get(m.id))?.state).toBe("done");
  });

  it("a crash mid-reply in the real flow: reply throws a network error, then the next pass finds the reply in the thread", async () => {
    let clock = Date.now();
    const h = makeHarness({ now: () => clock });
    await pollOnce(h.api, 1001, h.ledger);
    const m = h.api.add(makeMessage());
    h.api.replyImpl = async () => {
      throw new Error("socket hang up");
    };
    await pollOnce(h.api, 1001, h.ledger);
    await h.runtime.drain();
    expect(await h.ledger.get(m.id)).toMatchObject({ state: "sending", sendAttempts: 1 });
    outboundIn(h.api, m); // the request had in fact been accepted
    clock += 61_000;
    await h.runtime.drain();
    expect((await h.ledger.get(m.id))?.state).toBe("done");
    expect(h.api.calls.filter((c) => c.startsWith("reply:"))).toHaveLength(1);
  });

  it("gives up after the send attempt cap, with backoff between tries", async () => {
    let clock = Date.UTC(2026, 10, 9, 12, 0);
    const h = makeHarness({ now: () => clock });
    await pollOnce(h.api, 1001, h.ledger);
    const m = h.api.add(makeMessage());
    h.api.replyImpl = async () => {
      throw new Error("socket hang up");
    };
    await pollOnce(h.api, 1001, h.ledger);
    for (let i = 0; i < 12; i++) {
      await h.runtime.drain();
      clock += 31 * 60_000;
    }
    expect(await h.ledger.get(m.id)).toMatchObject({ state: "failed", reason: "reply-retries-exhausted", sendAttempts: 8 });

    const h2 = makeHarness();
    await pollOnce(h2.api, 1001, h2.ledger);
    const m2 = h2.api.add(makeMessage());
    h2.api.replyImpl = async () => {
      throw Object.assign(new Error("bad request"), { statusCode: 400 });
    };
    await pollOnce(h2.api, 1001, h2.ledger);
    await h2.runtime.drain();
    expect(await h2.ledger.get(m2.id)).toMatchObject({ state: "failed", reason: "reply-refused-400" });
  });
});

describe("fixtures derived from real API responses", () => {
  it("the thread fixture shows an outbound reply that recovery recognises, and the follow-up fixture references it", async () => {
    const thread = fixture("thread-with-outbound.json") as InboundThread;
    const followUp = fixture("message-reply.json");
    const outbound = thread.messages.find((m) => m.direction === "outbound")!;
    const inbound = thread.messages.find((m) => m.direction === "inbound")!;
    expect(followUp.in_reply_to).toBe(outbound.rfc_message_id);
    expect(followUp.thread_id).not.toBe(thread.id); // Mailtrap splits the thread on a reply

    const h = makeHarness();
    h.api.threads.set(thread.id, thread);
    await pollOnce(h.api, 1001, h.ledger);
    await h.ledger.enqueue(inbound.id, "poll");
    await h.ledger.update(inbound.id, { state: "sending", threadId: thread.id, inboundRfcId: inbound.rfc_message_id, inboundReceivedAt: inbound.created_at, conversationKey: inbound.id, reply: { text: "x", media: [] } });
    expect(await h.processor.reconcile(inbound.id)).toBe("done");
    expect(h.api.replies).toHaveLength(0);

    // The follow-up (new thread id) joins through the outbound Message-ID recorded from the thread.
    h.api.add({ ...followUp, id: "9000000000000000001" });
    await pollOnce(h.api, 1001, h.ledger);
    await h.runtime.drain();
    expect(h.turns[0]?.conversationKey).toBe(inbound.id);
  });
});
