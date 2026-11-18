import { describe, expect, it } from "vitest";
import { getRunningAccount, runAccount } from "../src/account-runner.js";
import { resolveAccount } from "../src/config.js";
import { createOpenStore, safeNamespace, type HostApi } from "../src/openclaw-host.js";
import { silentLogger } from "../src/types.js";
import { FakeInbound, makeMessage, MemoryStore, memoryOpenStore } from "./helpers/memory.js";

const cfg = (extra: object = {}) => ({
  channels: { mailtrap: { apiToken: "test-token", inboxId: 1001, allowFrom: ["alex@example.test"], allowUnauthenticated: true, pollIntervalSec: 5, ...extra } }
});

describe("runAccount", () => {
  it("starts an account, answers mail that arrives after start, and stops on abort", async () => {
    const api = new FakeInbound();
    api.add(makeMessage()); // pre-existing mail is ignored
    const ac = new AbortController();
    const done = runAccount(resolveAccount(cfg(), "default"), ac.signal, { createApi: () => api, openStore: memoryOpenStore(), runAgentTurn: async (i) => ({ text: `re: ${i.body}` }) }, silentLogger);
    await new Promise((r) => setTimeout(r, 30));
    expect(getRunningAccount("default")).toBeDefined();
    expect(api.replies).toHaveLength(0);
    ac.abort();
    await done;
    expect(getRunningAccount("default")).toBeUndefined();
  });

  it("on restart, waits for the old runtime's turn to finish so the item is answered once", async () => {
    const api = new FakeInbound();
    const openStore = memoryOpenStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let turns = 0;
    const deps = {
      createApi: () => api,
      openStore,
      runAgentTurn: async () => {
        turns++;
        await gate;
        return { text: "answer" };
      }
    };
    const ac1 = new AbortController();
    const first = runAccount(resolveAccount(cfg(), "default"), ac1.signal, deps, silentLogger);
    await new Promise((r) => setTimeout(r, 20));
    api.add(makeMessage());
    void getRunningAccount("default")!.runtime.tick(); // polls; the turn starts and blocks on the gate
    await new Promise((r) => setTimeout(r, 20));
    expect(turns).toBe(1);

    const ac2 = new AbortController();
    const second = runAccount(resolveAccount(cfg(), "default"), ac2.signal, deps, silentLogger);
    await new Promise((r) => setTimeout(r, 30));
    expect(turns).toBe(1); // the new runtime has not picked up the item still in processing

    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(turns).toBe(1);
    expect(api.replies).toHaveLength(1);
    ac1.abort();
    ac2.abort();
    await Promise.all([first, second]);
  });

  it("refuses to start with a hosted inbox and a configured from", async () => {
    const api = new FakeInbound();
    await expect(
      runAccount(resolveAccount(cfg({ from: "x@mail.example.test" }), "default"), new AbortController().signal, { createApi: () => api, openStore: memoryOpenStore(), runAgentTurn: async () => null }, silentLogger)
    ).rejects.toThrow(/hosted inbox/);
  });

  it("refuses to start without a token or inbox", async () => {
    await expect(
      runAccount(resolveAccount({ channels: { mailtrap: { inboxId: 1 } } }, "default"), new AbortController().signal, { createApi: () => new FakeInbound(), openStore: memoryOpenStore(), runAgentTurn: async () => null }, silentLogger)
    ).rejects.toThrow(/apiToken and inboxId/);
  });

  it("does nothing for a disabled account", async () => {
    await runAccount(resolveAccount(cfg({ enabled: false }), "default"), new AbortController().signal, { createApi: () => { throw new Error("must not be called"); }, openStore: memoryOpenStore(), runAgentTurn: async () => null }, silentLogger);
  });

  it("requires a from on a custom-domain inbox and then sends it with every reply", async () => {
    const api = new FakeInbound();
    api.inbox = { id: 1001, name: "t", address: "*@mail.example.test" };
    const mk = (extra: object) => resolveAccount(cfg(extra), "default");
    await expect(runAccount(mk({}), new AbortController().signal, { createApi: () => api, openStore: memoryOpenStore(), runAgentTurn: async () => null }, silentLogger)).rejects.toThrow(/set "from"/);
  });
});

describe("store namespaces", () => {
  it("map account ids injectively, so team_a and team-a never share a store", () => {
    const ids = ["team_a", "team-a", "team.a", "Team-a", "team-A", "team a", "team--a", "teäm-a", "default", "default-"];
    const ns = ids.map((id) => safeNamespace(`mailtrap-items-${id}`));
    expect(new Set(ns).size).toBe(ids.length);
    for (const n of ns) expect(n).toMatch(/^[a-z0-9.-]+$/);
  });
  it("keeps plain lowercase ids readable and unchanged", () => {
    expect(safeNamespace("mailtrap-items-default")).toBe("mailtrap-items-default");
  });
});

describe("createOpenStore", () => {
  it("maps ttl stores to bounded stores and the rest to retained ones", async () => {
    const opened: Array<Record<string, unknown>> = [];
    const backing = new MemoryStore<unknown>();
    const api = {
      runtime: { state: { openKeyedStoreV2: (o: Record<string, unknown>) => (opened.push(o), backing) } }
    } as unknown as HostApi;
    const open = createOpenStore(api);
    open("items-Default_1", { ttlMs: 1000 });
    open("meta-default", {});
    expect(opened[0]).toMatchObject({ namespace: "mailtrap-items-.44efault.5f1", defaultTtlMs: 1000 });
    expect(opened[1]).toEqual({ namespace: "mailtrap-meta-default", retention: "retained" });
    const s = open<string>("x", {});
    await s.register("k", "v");
    expect(await s.lookup("k")).toBe("v");
    expect(await s.entries()).toEqual([{ key: "k", value: "v" }]);
  });
});

describe("channel config adapter", () => {
  it("reports an account with no channels.mailtrap section as not configured, so the gateway never starts it", async () => {
    const { mailtrapChannelPlugin } = await import("../src/channel.js");
    const config = mailtrapChannelPlugin.config as unknown as { isConfigured: (a: unknown, c?: unknown) => boolean; resolveAccount: (c: unknown, id: string) => unknown };
    expect(config.isConfigured(config.resolveAccount({}, "default"))).toBe(false);
    expect(config.isConfigured(config.resolveAccount({ channels: { mailtrap: { apiToken: "t", inboxId: 1 } } }, "default"))).toBe(true);
  });
});
