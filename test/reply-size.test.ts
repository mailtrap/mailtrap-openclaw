import { describe, expect, it } from "vitest";
import { pollOnce } from "../src/poller.js";
import { MAX_ITEM_BYTES } from "../src/processor.js";
import { makeHarness } from "./helpers/harness.js";
import { makeMessage, memoryOpenStore } from "./helpers/memory.js";

/** A store that refuses values over 1 MiB, like OpenClaw's keyed store. */
function limitedStore() {
  const open = memoryOpenStore();
  const wrapped = (<T>(ns: string, o: { ttlMs?: number }) => {
    const s = open<T>(ns, o);
    const check = (v: unknown) => {
      if (Buffer.byteLength(JSON.stringify(v)) > 1024 * 1024) throw new Error("value exceeds the 1 MiB store limit");
    };
    return { lookup: (k: string) => s.lookup(k), delete: (k: string) => s.delete(k), entries: () => s.entries(), register: (k: string, v: T) => (check(v), s.register(k, v)), registerIfAbsent: (k: string, v: T) => (check(v), s.registerIfAbsent(k, v)) };
  }) as typeof open;
  return wrapped;
}

describe("reply too large for the store", () => {
  it("fails the item with reply-too-large, sends nothing, and never reruns the agent turn", async () => {
    let turns = 0;
    const h = makeHarness({
      openStore: limitedStore(),
      runAgentTurn: async () => {
        turns++;
        return { text: "x".repeat(1024 * 1024) };
      }
    });
    await pollOnce(h.api, 1001, h.ledger);
    const m = h.api.add(makeMessage());
    await pollOnce(h.api, 1001, h.ledger);
    await h.runtime.drain();
    await h.runtime.drain();
    expect(await h.ledger.get(m.id)).toMatchObject({ state: "failed", reason: "reply-too-large" });
    expect((await h.ledger.get(m.id))?.reply).toBeUndefined();
    expect(h.api.replies).toHaveLength(0);
    expect(turns).toBe(1);
  });

  it("still sends a reply just under the limit", async () => {
    const h = makeHarness({ openStore: limitedStore(), runAgentTurn: async () => ({ text: "y".repeat(MAX_ITEM_BYTES - 4096) }) });
    await pollOnce(h.api, 1001, h.ledger);
    const m = h.api.add(makeMessage());
    await pollOnce(h.api, 1001, h.ledger);
    await h.runtime.drain();
    expect((await h.ledger.get(m.id))?.state).toBe("done");
    expect(h.api.replies).toHaveLength(1);
  });
});
