import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { runAccount } from "../src/account-runner.js";
import { resolveAccount } from "../src/config.js";
import { Ledger } from "../src/ledger.js";
import { runWebhookCommand, registerMailtrapCli } from "../src/cli.js";
import { silentLogger, type WebhookAdmin, type WebhookInfo } from "../src/types.js";
import { accountIdFromPath, handleWebhook, webhookUrlFor } from "../src/webhook.js";
import { createWebhookRouteHandler } from "../src/webhook-route.js";
import { connectWebhook, disconnectWebhook } from "../src/webhook-cli.js";
import { FakeInbound, memoryOpenStore } from "./helpers/memory.js";

const SECRET = "test-signing-secret";
const sign = (body: string, secret = SECRET) => createHmac("sha256", secret).update(body).digest("hex");
const event = (messageId: string, over: Record<string, unknown> = {}) => ({ event: "inbound.message_received", event_id: `ev-${messageId}`, timestamp: 1760000000, inbox_id: 1001, message_id: messageId, from: "Alex", ...over });
const body = (...events: unknown[]) => JSON.stringify({ events });

async function target() {
  const ledger = new Ledger(memoryOpenStore(), "default");
  await ledger.setWebhook({ secret: SECRET, id: 7 });
  return { accountId: "default", inboxId: 1001, ledger };
}

describe("webhook ingress", () => {
  it("verifies, persists the message id, and answers 200 without fetching anything", async () => {
    const t = await target();
    const raw = body(event("m1"));
    const r = await handleWebhook(raw, sign(raw), t);
    expect(r).toEqual({ status: 200, body: "ok", enqueued: true });
    expect(await t.ledger.get("m1")).toMatchObject({ state: "queued", source: "webhook" });
  });

  it("rejects a bad signature, a signature made with another secret, and a missing signature, and persists nothing", async () => {
    const t = await target();
    const raw = body(event("m1"));
    expect((await handleWebhook(raw, "0".repeat(64), t)).status).toBe(401);
    expect((await handleWebhook(raw, sign(raw, "other-secret"), t)).status).toBe(401);
    expect((await handleWebhook(raw, undefined, t)).status).toBe(401);
    expect((await handleWebhook(raw, "not-hex", t)).status).toBe(401);
    expect(await t.ledger.get("m1")).toBeUndefined();
  });

  it("rejects a body altered after signing", async () => {
    const t = await target();
    const signed = body(event("m1"));
    expect((await handleWebhook(body(event("m2")), sign(signed), t)).status).toBe(401);
    expect(await t.ledger.get("m2")).toBeUndefined();
  });

  it("answers 404 when no webhook secret is stored, 503 when the account isn't running", async () => {
    const ledger = new Ledger(memoryOpenStore(), "default");
    const raw = body(event("m1"));
    expect((await handleWebhook(raw, sign(raw), { accountId: "default", inboxId: 1001, ledger })).status).toBe(404);
    expect((await handleWebhook(raw, sign(raw), undefined)).status).toBe(503);
  });

  it("answers 400 to signed garbage and ignores other events and other inboxes", async () => {
    const t = await target();
    expect((await handleWebhook("not json", sign("not json"), t)).status).toBe(400);
    const raw = body(event("m1", { event: "something.else" }), event("m2", { inbox_id: 9999 }), event("m3", { message_id: "" }), event("m4"));
    const r = await handleWebhook(raw, sign(raw), t);
    expect(r).toMatchObject({ status: 200, enqueued: true });
    expect(await t.ledger.inStates("queued")).toHaveLength(1);
    expect(await t.ledger.get("m4")).toBeDefined();
  });

  it("is idempotent: Mailtrap retries and repeated events enqueue once", async () => {
    const t = await target();
    const raw = body(event("m1"), event("m1"));
    expect((await handleWebhook(raw, sign(raw), t)).enqueued).toBe(true);
    expect((await handleWebhook(raw, sign(raw), t)).enqueued).toBe(false);
    expect(await t.ledger.inStates("queued")).toHaveLength(1);
  });

  it("builds per-account URLs and parses them back", () => {
    expect(webhookUrlFor("https://gw.example.test", "support")).toBe("https://gw.example.test/mailtrap/webhook/support");
    expect(webhookUrlFor("https://gw.example.test/base/", "default")).toBe("https://gw.example.test/base/mailtrap/webhook/default");
    expect(webhookUrlFor("https://gw.example.test/mailtrap/webhook/x", "default")).toBe("https://gw.example.test/mailtrap/webhook/x");
    expect(() => webhookUrlFor("http://gw.example.test", "default")).toThrow(/https/);
    expect(accountIdFromPath("/mailtrap/webhook")).toBe("default");
    expect(accountIdFromPath("/mailtrap/webhook/")).toBe("default");
    expect(accountIdFromPath("/mailtrap/webhook/Support")).toBe("support");
  });
});

function fakeReq(method: string, url: string, headers: Record<string, string> = {}) {
  return { method, url, headers } as unknown as IncomingMessage;
}
function fakeRes() {
  const out = { statusCode: 0, body: "", headers: {} as Record<string, string> };
  const res = {
    get statusCode() {
      return out.statusCode;
    },
    set statusCode(v: number) {
      out.statusCode = v;
    },
    setHeader: (k: string, v: string) => void (out.headers[k] = v),
    end: (b?: string) => void (out.body = b ?? "")
  };
  return { res: res as unknown as ServerResponse, out };
}

describe("webhook route", () => {
  async function running() {
    const api = new FakeInbound();
    const openStore = memoryOpenStore();
    const ac = new AbortController();
    const done = runAccount(
      resolveAccount({ channels: { mailtrap: { apiToken: "t", inboxId: 1001, allowFrom: ["alex@example.test"], allowUnauthenticated: true } } }, "default"),
      ac.signal,
      { createApi: () => api, openStore, runAgentTurn: async (i) => ({ text: `re ${i.body}` }) },
      silentLogger
    );
    await new Promise((r) => setTimeout(r, 20));
    const ledger = new Ledger(openStore, "default");
    await ledger.setWebhook({ secret: SECRET, id: 7 });
    return { api, ledger, stop: async () => (ac.abort(), done) };
  }

  it("answers 200, persists the id and starts the drain after responding; a following drain replies", async () => {
    const r = await running();
    const raw = body(event("will-be-fetched"));
    const detached: Array<() => Promise<unknown>> = [];
    const handler = createWebhookRouteHandler({ readBody: async () => raw, runDetached: async (w) => void detached.push(w) });
    const { res, out } = fakeRes();
    await handler(fakeReq("POST", "/mailtrap/webhook", { "mailtrap-signature": sign(raw) }), res);
    expect(out.statusCode).toBe(200);
    expect(await r.ledger.get("will-be-fetched")).toMatchObject({ state: "queued", source: "webhook" });
    expect(r.api.calls.filter((c) => c.startsWith("get:"))).toHaveLength(0); // nothing fetched inside the request
    expect(detached).toHaveLength(1);
    await r.stop();
  });

  it("rejects non-POST (405), oversize or unreadable bodies (413), bad signatures (401) and stopped accounts (503)", async () => {
    const r = await running();
    const raw = body(event("m"));
    const ok = createWebhookRouteHandler({ readBody: async () => raw, runDetached: async () => {} });
    let x = fakeRes();
    await ok(fakeReq("GET", "/mailtrap/webhook"), x.res);
    expect(x.out.statusCode).toBe(405);
    x = fakeRes();
    await createWebhookRouteHandler({ readBody: async () => { throw new Error("too big"); }, runDetached: async () => {} })(fakeReq("POST", "/mailtrap/webhook"), x.res);
    expect(x.out.statusCode).toBe(413);
    x = fakeRes();
    await ok(fakeReq("POST", "/mailtrap/webhook", { "mailtrap-signature": "00" }), x.res);
    expect(x.out.statusCode).toBe(401);
    expect(await r.ledger.get("m")).toBeUndefined();
    x = fakeRes();
    await ok(fakeReq("POST", "/mailtrap/webhook/nobody", { "mailtrap-signature": sign(raw) }), x.res);
    expect(x.out.statusCode).toBe(503);
    await r.stop();
  });
});

describe("webhook route, malformed path", () => {
  it("answers 400 for a malformed percent-encoded path, before reading the body, and never throws", async () => {
    let read = 0;
    const handler = createWebhookRouteHandler({ readBody: async () => (read++, "{}"), runDetached: async () => {} });
    for (const path of ["/mailtrap/webhook/%E0%A4%A", "/mailtrap/webhook/%", "/mailtrap/webhook/%zz"]) {
      for (const method of ["POST", "GET"]) {
        const x = fakeRes();
        await expect(handler(fakeReq(method, path, { "mailtrap-signature": "00" }), x.res)).resolves.toBe(true);
        expect(x.out.statusCode).toBe(400);
      }
    }
    expect(read).toBe(0);
  });
});

class FakeAdmin implements WebhookAdmin {
  hooks: WebhookInfo[] = [];
  deleted: number[] = [];
  nextId = 50;
  deleteError: Error | undefined;
  async list() {
    return this.hooks.map((h) => ({ ...h }));
  }
  async create(p: { url: string; inboxId: number }) {
    const h = { id: this.nextId++, url: p.url, active: true, webhook_type: "inbound_receiving", inbound_inbox_id: p.inboxId };
    this.hooks.push(h);
    return { ...h, signing_secret: `secret-${h.id}` };
  }
  async update(id: number, p: { url: string }) {
    const h = this.hooks.find((x) => x.id === id)!;
    h.url = p.url;
    return { ...h };
  }
  async delete(id: number) {
    if (this.deleteError) throw this.deleteError;
    this.deleted.push(id);
    this.hooks = this.hooks.filter((h) => h.id !== id);
  }
}

describe("webhook connect / disconnect", () => {
  const base = () => ({ admin: new FakeAdmin(), ledger: new Ledger(memoryOpenStore(), "default"), accountId: "default", inboxId: 1001, publicUrl: "https://gw.example.test" });

  it("creates the webhook and stores the signing secret in the state store", async () => {
    const o = base();
    const r = await connectWebhook(o);
    expect(r).toEqual({ url: "https://gw.example.test/mailtrap/webhook/default", webhookId: 50, action: "created" });
    expect(await o.ledger.getWebhook()).toEqual({ secret: "secret-50", id: 50, url: "https://gw.example.test/mailtrap/webhook/default" });
  });

  it("updates the URL of its own webhook and keeps the secret", async () => {
    const o = base();
    await connectWebhook(o);
    const r = await connectWebhook({ ...o, publicUrl: "https://new.example.test" });
    expect(r.action).toBe("updated");
    expect(o.admin.hooks).toHaveLength(1);
    expect(o.admin.hooks[0]!.url).toBe("https://new.example.test/mailtrap/webhook/default");
    expect((await o.ledger.getWebhook())?.secret).toBe("secret-50");
  });

  it("refuses to touch a webhook it did not create unless --replace", async () => {
    const o = base();
    o.admin.hooks.push({ id: 3, url: "https://other.example.test", active: true, webhook_type: "inbound_receiving", inbound_inbox_id: 1001 });
    await expect(connectWebhook(o)).rejects.toThrow(/--replace/);
    expect(o.admin.hooks).toHaveLength(1);
    const r = await connectWebhook({ ...o, replace: true });
    expect(r.action).toBe("recreated");
    expect(o.admin.deleted).toEqual([3]);
    expect((await o.ledger.getWebhook())?.secret).toBe("secret-50");
  });

  it("ignores webhooks of other inboxes and other types", async () => {
    const o = base();
    o.admin.hooks.push({ id: 3, url: "u", active: true, webhook_type: "inbound_receiving", inbound_inbox_id: 2 }, { id: 4, url: "u", active: true, webhook_type: "email_sending", inbound_inbox_id: null });
    expect((await connectWebhook(o)).action).toBe("created");
    expect(o.admin.hooks).toHaveLength(3);
  });

  it("disconnect deletes the webhook and the stored secret, tolerates a webhook already gone, and is a no-op when not connected", async () => {
    const o = base();
    expect(await disconnectWebhook(o)).toEqual({ deleted: false });
    await connectWebhook(o);
    expect(await disconnectWebhook(o)).toEqual({ deleted: true });
    expect(o.admin.hooks).toHaveLength(0);
    expect(await o.ledger.getWebhook()).toBeUndefined();

    await connectWebhook(o);
    o.admin.deleteError = Object.assign(new Error("not found"), { statusCode: 404 });
    expect(await disconnectWebhook(o)).toEqual({ deleted: true });
    expect(await o.ledger.getWebhook()).toBeUndefined();

    o.admin.hooks = [];
    o.admin.deleteError = undefined;
    await connectWebhook(o);
    o.admin.deleteError = Object.assign(new Error("forbidden"), { statusCode: 403 });
    await expect(disconnectWebhook(o)).rejects.toThrow("forbidden");
    expect(await o.ledger.getWebhook()).toBeDefined(); // secret kept when the delete failed
  });
});

describe("mailtrap webhook CLI", () => {
  const cfg = { channels: { mailtrap: { apiToken: "channel-token", inboxId: 1001 } } };
  const env = { MAILTRAP_API_TOKEN: "broad-token", MAILTRAP_ACCOUNT_ID: "42" };

  it("uses the broad env token (not the channel token) and prints the URL but never the secret", async () => {
    const admin = new FakeAdmin();
    const seen: Array<[string, number]> = [];
    const openStore = memoryOpenStore();
    const lines = await runWebhookCommand("connect", { url: "https://gw.example.test" }, { cfg, env, openStore, createAdmin: (t, a) => (seen.push([t, a]), admin) });
    expect(seen).toEqual([["broad-token", 42]]);
    expect(lines.join("\n")).toContain("https://gw.example.test/mailtrap/webhook/default");
    expect(lines.join("\n")).not.toContain("secret-50");
    expect(JSON.stringify([...openStore.stores.values()].map((s) => [...(s as never as { data: Map<string, unknown> }).data.entries()]))).not.toContain("broad-token");
    const off = await runWebhookCommand("disconnect", {}, { cfg, env, openStore, createAdmin: () => admin });
    expect(off[0]).toMatch(/removed/);
  });

  it("explains missing configuration, env and --url", async () => {
    const deps = { cfg, env, openStore: memoryOpenStore(), createAdmin: () => new FakeAdmin() };
    await expect(runWebhookCommand("connect", {}, deps)).rejects.toThrow(/--url/);
    await expect(runWebhookCommand("connect", { url: "https://x.example.test" }, { ...deps, env: {} })).rejects.toThrow(/MAILTRAP_API_TOKEN/);
    await expect(runWebhookCommand("connect", { url: "https://x.example.test" }, { ...deps, cfg: {} })).rejects.toThrow(/not configured/);
    await expect(runWebhookCommand("connect", { url: "https://x.example.test", account: "nope" }, deps)).rejects.toThrow(/"nope"/);
  });

  it("registers mailtrap > webhook > connect|disconnect with the right options", () => {
    const tree: string[] = [];
    const mk = (path: string): never => ({
      command: (n: string) => mk(`${path} ${n}`),
      description: () => mk(path),
      option: (f: string) => (tree.push(`${path} ${f}`), mk(path)),
      action: () => mk(path)
    }) as never;
    registerMailtrapCli(mk("") as never, () => ({}) as never, () => {});
    expect(tree).toContain(" mailtrap webhook connect --url <url>");
    expect(tree).toContain(" mailtrap webhook connect --replace");
    expect(tree).toContain(" mailtrap webhook disconnect --account <id>");
  });
});
