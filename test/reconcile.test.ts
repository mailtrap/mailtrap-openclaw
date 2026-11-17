import { describe, expect, it } from "vitest";
import { pollOnce } from "../src/poller.js";
import { Processor } from "../src/processor.js";
import { AccountRuntime } from "../src/runtime.js";
import { silentLogger } from "../src/types.js";
import { makeHarness } from "./helpers/harness.js";
import { makeMessage } from "./helpers/memory.js";

function runtimeAt(h: ReturnType<typeof makeHarness>, clock: { t: number }) {
  return new AccountRuntime({ api: h.api, inboxId: 1001, ledger: h.ledger, processor: h.processor as Processor, pollIntervalMs: 30_000, reconcileIntervalMs: 600_000, now: () => clock.t, log: silentLogger });
}
const lists = (h: ReturnType<typeof makeHarness>) => h.api.calls.filter((c) => c.startsWith("list:")).length;

describe("catch-up and reconcile when a webhook is set", () => {
  it("catches up on start: mail that arrived while the gateway was down is answered", async () => {
    const h = makeHarness();
    await pollOnce(h.api, 1001, h.ledger); // an earlier run set the cursor
    await h.ledger.setWebhook({ secret: "s", id: 1 });
    const m = h.api.add(makeMessage()); // arrived while down, webhook couldn't reach us
    const rt = runtimeAt(h, { t: 1_000 });
    await rt.tick();
    expect(h.api.replies.map((r) => r.messageId)).toEqual([m.id]);
  });

  it("then polls only every 10 minutes while the webhook is set, but drains on every tick", async () => {
    const h = makeHarness();
    await pollOnce(h.api, 1001, h.ledger);
    await h.ledger.setWebhook({ secret: "s", id: 1 });
    const clock = { t: 0 };
    const rt = runtimeAt(h, clock);
    await rt.tick();
    const afterFirst = lists(h);
    clock.t = 30_000;
    await rt.tick();
    clock.t = 300_000;
    await rt.tick();
    expect(lists(h)).toBe(afterFirst); // no extra polling

    const viaWebhook = h.api.add(makeMessage());
    await h.ledger.enqueue(viaWebhook.id, "webhook");
    clock.t = 330_000;
    await rt.tick();
    expect(h.api.replies.map((r) => r.messageId)).toEqual([viaWebhook.id]);
    expect(lists(h)).toBe(afterFirst);

    const missed = h.api.add(makeMessage()); // webhook never arrived; only the reconcile finds it
    clock.t = 600_000;
    await rt.tick();
    expect(lists(h)).toBeGreaterThan(afterFirst);
    expect(h.api.replies.map((r) => r.messageId)).toContain(missed.id);
  });

  it("without a webhook secret every tick polls", async () => {
    const h = makeHarness();
    const clock = { t: 0 };
    const rt = runtimeAt(h, clock);
    await rt.tick();
    clock.t = 30_000;
    await rt.tick();
    clock.t = 60_000;
    await rt.tick();
    expect(lists(h)).toBe(3);
  });

  it("returns to 30 s polling after the webhook is disconnected", async () => {
    const h = makeHarness();
    await pollOnce(h.api, 1001, h.ledger);
    await h.ledger.setWebhook({ secret: "s", id: 1 });
    const clock = { t: 0 };
    const rt = runtimeAt(h, clock);
    await rt.tick();
    await h.ledger.clearWebhook();
    const m = h.api.add(makeMessage());
    clock.t = 30_000;
    await rt.tick();
    expect(h.api.replies.map((r) => r.messageId)).toEqual([m.id]);
  });

  it("keeps working when the webhook state can't be read", async () => {
    const h = makeHarness();
    h.ledger.getWebhook = async () => {
      throw new Error("db locked");
    };
    await pollOnce(h.api, 1001, h.ledger);
    const m = h.api.add(makeMessage());
    await runtimeAt(h, { t: 0 }).tick();
    expect(h.api.replies.map((r) => r.messageId)).toEqual([m.id]);
  });
});
