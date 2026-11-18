import { describe, expect, it, vi } from "vitest";
import { pollOnce } from "../src/poller.js";
import { silentLogger } from "../src/types.js";
import { makeMessage, memoryOpenStore } from "./helpers/memory.js";
import { makeHarness } from "./helpers/harness.js";

describe("polling and the ledger", () => {
  it("sets the cursor to the newest message on first start and never replies to old mail", async () => {
    const h = makeHarness();
    h.api.add(makeMessage());
    h.api.add(makeMessage());
    const r = await pollOnce(h.api, 1001, h.ledger);
    expect(r).toEqual({ initialized: true, enqueued: 0 });
    await h.runtime.drain();
    expect(h.api.replies).toHaveLength(0);
    expect(h.turns).toHaveLength(0);
    expect(await h.ledger.inStates("dropped")).toHaveLength(2);
  });

  it("never answers old mail even when it shares the newest message's timestamp", async () => {
    const h = makeHarness();
    const a = h.api.add(makeMessage({ received_at: "2026-11-09T12:00:00.000Z" }));
    const b = h.api.add(makeMessage({ received_at: "2026-11-09T12:00:00.000Z" }));
    await pollOnce(h.api, 1001, h.ledger);
    expect((await pollOnce(h.api, 1001, h.ledger)).enqueued).toBe(0);
    expect((await h.ledger.get(a.id))?.reason).toBe("before-first-start");
    expect((await h.ledger.get(b.id))?.reason).toBe("before-first-start");
  });

  it("starts from an empty inbox with cursor 0 so the first message is new", async () => {
    const h = makeHarness();
    await pollOnce(h.api, 1001, h.ledger);
    expect(await h.ledger.getCursor()).toEqual({ id: "", receivedAt: "1970-01-01T00:00:00.000Z" });
    h.api.add(makeMessage());
    expect((await pollOnce(h.api, 1001, h.ledger)).enqueued).toBe(1);
  });

  it("enqueues only messages newer than the cursor, across pages, oldest first", async () => {
    const h = makeHarness();
    h.api.pageSize = 2;
    h.api.add(makeMessage());
    await pollOnce(h.api, 1001, h.ledger);
    const fresh = [makeMessage(), makeMessage(), makeMessage(), makeMessage(), makeMessage()].map((m) => h.api.add(m));
    const r = await pollOnce(h.api, 1001, h.ledger);
    expect(r.enqueued).toBe(5);
    const queued = await h.ledger.inStates("queued");
    expect(queued.map((i) => i.id)).toEqual(fresh.map((m) => m.id));
    expect((await h.ledger.getCursor())?.id).toBe(fresh[4]!.id);
    expect((await pollOnce(h.api, 1001, h.ledger)).enqueued).toBe(0);
  });

  it("warns when more new mail arrived than one poll scans (50 pages)", async () => {
    const h = makeHarness();
    h.api.pageSize = 1;
    await pollOnce(h.api, 1001, h.ledger);
    for (let i = 0; i < 51; i++) h.api.add(makeMessage());
    const log = { ...silentLogger, warn: vi.fn() };
    expect((await pollOnce(h.api, 1001, h.ledger, "poll", log)).enqueued).toBe(50);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("older messages are skipped"), expect.objectContaining({ pages: 50 }));
    log.warn.mockClear();
    h.api.add(makeMessage());
    await pollOnce(h.api, 1001, h.ledger, "poll", log);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("does not enqueue an id twice and leaves a cursor behind a crash harmless", async () => {
    const h = makeHarness();
    await pollOnce(h.api, 1001, h.ledger);
    const m = h.api.add(makeMessage());
    await h.ledger.enqueue(m.id, "webhook"); // webhook got there first
    const r = await pollOnce(h.api, 1001, h.ledger);
    expect(r.enqueued).toBe(0);
    expect((await h.ledger.get(m.id))?.source).toBe("webhook");
  });
});

describe("poll -> ledger -> agent turn -> reply", () => {
  it("answers a new message from an allowed sender in the same conversation", async () => {
    const h = makeHarness();
    await pollOnce(h.api, 1001, h.ledger);
    const m = h.api.add(makeMessage({ text_body: "Ping" }));
    await pollOnce(h.api, 1001, h.ledger);
    await h.runtime.drain();

    expect(h.turns).toHaveLength(1);
    expect(h.turns[0]).toMatchObject({ messageId: m.id, conversationKey: m.id, sender: { email: "alex@example.test", name: "Alex Example" }, body: "Ping" });
    expect(h.api.replies).toHaveLength(1);
    expect(h.api.replies[0]!.messageId).toBe(m.id);
    expect(h.api.replies[0]!.params).toEqual({ text: "echo: Ping" }); // hosted inbox: no `from`
    const item = await h.ledger.get(m.id);
    expect(item).toMatchObject({ state: "done", sentMessageIds: ["00000000-0000-4000-8000-000000000001"] });
  });

  it("marks the item `sending` before it calls reply", async () => {
    const h = makeHarness();
    await pollOnce(h.api, 1001, h.ledger);
    const m = h.api.add(makeMessage());
    let stateDuringReply: string | undefined;
    h.api.replyImpl = async () => {
      stateDuringReply = (await h.ledger.get(m.id))?.state;
      return { message_ids: ["u1"] };
    };
    await pollOnce(h.api, 1001, h.ledger);
    await h.runtime.drain();
    expect(stateDuringReply).toBe("sending");
  });

  it("never replies twice to the same message", async () => {
    const h = makeHarness();
    await pollOnce(h.api, 1001, h.ledger);
    h.api.add(makeMessage());
    await pollOnce(h.api, 1001, h.ledger);
    await h.runtime.drain();
    await pollOnce(h.api, 1001, h.ledger);
    await h.runtime.drain();
    expect(h.api.replies).toHaveLength(1);
  });

  it("stays silent when the agent returns nothing", async () => {
    const h = makeHarness({ runAgentTurn: async () => null });
    await pollOnce(h.api, 1001, h.ledger);
    const m = h.api.add(makeMessage());
    await pollOnce(h.api, 1001, h.ledger);
    await h.runtime.drain();
    expect(h.api.replies).toHaveLength(0);
    expect(await h.ledger.get(m.id)).toMatchObject({ state: "dropped", reason: "no-reply" });
  });

  it("never replies to its own address (loop guard)", async () => {
    const h = makeHarness({ allowFrom: ["agent-test@inbound-mailtrap.io"] });
    await pollOnce(h.api, 1001, h.ledger);
    const m = h.api.add(makeMessage({ from: "agent-test@inbound-mailtrap.io" }));
    await pollOnce(h.api, 1001, h.ledger);
    await h.runtime.drain();
    expect(h.api.replies).toHaveLength(0);
    expect((await h.ledger.get(m.id))?.reason).toBe("own-address");
  });

  it("gives up on a message it can't fetch after the fetch attempt cap", async () => {
    let clock = Date.UTC(2026, 10, 9, 12, 0);
    const h = makeHarness({ now: () => clock });
    await pollOnce(h.api, 1001, h.ledger);
    const m = h.api.add(makeMessage());
    h.api.getMessageImpl = async () => {
      throw new Error("boom");
    };
    await pollOnce(h.api, 1001, h.ledger);
    for (let i = 0; i < 8; i++) {
      await h.runtime.drain();
      clock += 31 * 60_000;
    }
    expect(await h.ledger.get(m.id)).toMatchObject({ state: "dropped", reason: "fetch-failed", attempts: 8 });
  });
});

describe("sessions", () => {
  it("joins a follow-up that references a reply we sent, even though Mailtrap gives it a new thread_id", async () => {
    const h = makeHarness();
    await pollOnce(h.api, 1001, h.ledger);
    const first = h.api.add(makeMessage({ thread_id: "T1" }));
    await pollOnce(h.api, 1001, h.ledger);
    await h.runtime.drain();
    const sentUuid = (await h.ledger.get(first.id))!.sentMessageIds![0]!;

    const followUp = h.api.add(
      makeMessage({ thread_id: "T2-new", in_reply_to: `<${sentUuid}@inbound-mailtrap.io>`, references: [`<${sentUuid}@inbound-mailtrap.io>`] })
    );
    await pollOnce(h.api, 1001, h.ledger);
    await h.runtime.drain();
    expect(h.turns[1]!.conversationKey).toBe(first.id);
    expect((await h.ledger.get(followUp.id))?.conversationKey).toBe(first.id);
  });

  it("joins by thread_id when a message in a known thread has no usable references", async () => {
    const h = makeHarness();
    await pollOnce(h.api, 1001, h.ledger);
    const first = h.api.add(makeMessage({ thread_id: "T1" }));
    await pollOnce(h.api, 1001, h.ledger);
    await h.runtime.drain();
    h.api.add(makeMessage({ thread_id: "T1" }));
    await pollOnce(h.api, 1001, h.ledger);
    await h.runtime.drain();
    expect(h.turns[1]!.conversationKey).toBe(first.id);
  });

  it("starts a new session for an unrelated message", async () => {
    const h = makeHarness();
    await pollOnce(h.api, 1001, h.ledger);
    h.api.add(makeMessage());
    const second = makeMessage();
    h.api.add(second);
    await pollOnce(h.api, 1001, h.ledger);
    await h.runtime.drain();
    expect(h.turns[1]!.conversationKey).toBe(second.id);
  });

  it("keeps accounts apart: the same references in another account's ledger join nothing", async () => {
    const openStore = memoryOpenStore();
    const a = makeHarness({ openStore });
    const b = makeHarness({ openStore, accountId: "other" });
    await pollOnce(a.api, 1001, a.ledger);
    await pollOnce(b.api, 1001, b.ledger);
    const first = a.api.add(makeMessage());
    await pollOnce(a.api, 1001, a.ledger);
    await a.runtime.drain();
    const m = b.api.add(makeMessage({ in_reply_to: first.rfc_message_id, references: [first.rfc_message_id!] }));
    await pollOnce(b.api, 1001, b.ledger);
    await b.runtime.drain();
    expect(b.turns[0]!.conversationKey).toBe(m.id);
  });
});

describe("AccountRuntime", () => {
  it("polls on start, drains, reschedules, and stops when aborted", async () => {
    const h = makeHarness();
    h.api.add(makeMessage()); // old mail
    const ac = new AbortController();
    await h.runtime.start(ac.signal);
    expect(await h.ledger.getCursor()).not.toBeUndefined();
    ac.abort();
    await h.runtime.stop();
    const callsAfterStop = h.api.calls.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(h.api.calls.length).toBe(callsAfterStop);
  });
});

describe("reply identity", () => {
  it("sends the configured from on a custom-domain inbox, and records both candidate Message-IDs for session joining", async () => {
    const h = makeHarness({ customFrom: "agent@mail.example.test" });
    await pollOnce(h.api, 1001, h.ledger);
    const first = h.api.add(makeMessage());
    await pollOnce(h.api, 1001, h.ledger);
    await h.runtime.drain();
    expect(h.api.replies[0]!.params.from).toEqual({ email: "agent@mail.example.test" });
    const uuid = (await h.ledger.get(first.id))!.sentMessageIds![0]!;
    const follow = h.api.add(makeMessage({ in_reply_to: `<${uuid}@mail.example.test>`, references: [`<${uuid}@mail.example.test>`] }));
    await pollOnce(h.api, 1001, h.ledger);
    await h.runtime.drain();
    expect((await h.ledger.get(follow.id))?.conversationKey).toBe(first.id);
  });

  it("drops mail from its own custom-domain from address", async () => {
    const h = makeHarness({ customFrom: "agent@mail.example.test", allowFrom: ["agent@mail.example.test"] });
    await pollOnce(h.api, 1001, h.ledger);
    const m = h.api.add(makeMessage({ from: "agent@mail.example.test" }));
    await pollOnce(h.api, 1001, h.ledger);
    await h.runtime.drain();
    expect((await h.ledger.get(m.id))?.reason).toBe("own-address");
  });
});
