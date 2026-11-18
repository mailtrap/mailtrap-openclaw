import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { isAllowed, parseAddress } from "../src/address.js";
import { dkimSign } from "mailauth";
import { createDkimAuthenticator, defaultFetchRaw, MAX_RAW_BYTES, unauthenticated } from "../src/dkim.js";
import { pollOnce } from "../src/poller.js";
import { checkSender } from "../src/sender-check.js";
import { makeKey, mockResolver, rawMessage, sign, type TestKey } from "./helpers/dkim.js";
import { makeHarness } from "./helpers/harness.js";
import { FakeInbound, makeMessage } from "./helpers/memory.js";

describe("allowlist (layer 1)", () => {
  it("parses display-name and bare addresses", () => {
    expect(parseAddress("Alex Example <Alex@Example.test>")).toEqual({ email: "alex@example.test", name: "Alex Example" });
    expect(parseAddress('"Ex, Alex" <a@b.test>')?.name).toBe("Ex, Alex");
    expect(parseAddress("a@b.test")).toEqual({ email: "a@b.test", name: undefined });
    expect(parseAddress("not an address")).toBeUndefined();
    expect(parseAddress(null)).toBeUndefined();
  });

  it("is default deny, exact for addresses and for @domain entries", () => {
    expect(isAllowed("a@b.test", [])).toBe(false);
    expect(isAllowed("a@b.test", ["a@b.test"])).toBe(true);
    expect(isAllowed("A@B.test", ["a@b.test"])).toBe(true);
    expect(isAllowed("x@b.test", ["a@b.test"])).toBe(false);
    expect(isAllowed("x@b.test", ["@b.test"])).toBe(true);
    expect(isAllowed("x@sub.b.test", ["@b.test"])).toBe(false);
    expect(isAllowed("x@evilb.test", ["@b.test"])).toBe(false);
  });
});

describe("DKIM (layer 2)", () => {
  let key: TestKey;
  let attackerKey: TestKey;
  beforeAll(() => {
    key = makeKey();
    attackerKey = makeKey();
  });

  const dns = () => mockResolver({ "s1._domainkey.example.test": key.txt, "s1._domainkey.attacker.test": attackerKey.txt });
  const alex = { email: "alex@example.test", name: undefined };

  function setup(raw: Buffer | undefined, over: Partial<ReturnType<typeof makeMessage>> = {}) {
    const api = new FakeInbound();
    const msg = makeMessage({ from: "Alex Example <alex@example.test>", ...over });
    api.add(msg);
    const fetchRaw = vi.fn(async () => {
      if (!raw) throw new Error("none");
      return raw;
    });
    const resolver = dns();
    const auth = createDkimAuthenticator({ api, inboxId: 1001, fetchRaw, resolver, now: () => Date.UTC(2026, 10, 9, 12, 30) });
    return { api, msg, fetchRaw, resolver, auth };
  }

  it("passes a valid signature aligned with the From domain", async () => {
    const raw = await sign(rawMessage("Alex Example <alex@example.test>"), key, "example.test");
    const { auth, msg, resolver } = setup(raw);
    expect(await auth(msg, alex)).toEqual({ ok: true });
    expect(resolver.lookups).toEqual(["TXT s1._domainkey.example.test"]);
  });

  it("passes a signature from a parent organizational domain (relaxed alignment)", async () => {
    const raw = await sign(rawMessage("Alex <alex@mail.example.test>"), key, "example.test");
    const { auth, msg } = setup(raw, { from: "Alex <alex@mail.example.test>" });
    expect(await auth(msg, { email: "alex@mail.example.test", name: undefined })).toEqual({ ok: true });
  });

  it("rejects a forged sender: a message claiming alex@example.test with no signature", async () => {
    const raw = Buffer.from(rawMessage("Alex Example <alex@example.test>"));
    const { auth, msg } = setup(raw);
    expect(await auth(msg, alex)).toEqual({ ok: false, reason: "dkim-missing" });
  });

  it("rejects misaligned DKIM: valid signature, but for the attacker's own domain", async () => {
    const raw = await sign(rawMessage("Alex Example <alex@example.test>"), attackerKey, "attacker.test");
    const { auth, msg } = setup(raw);
    expect(await auth(msg, alex)).toEqual({ ok: false, reason: "dkim-misaligned" });
  });

  it("rejects a body changed after signing", async () => {
    const raw = await sign(rawMessage("Alex Example <alex@example.test>"), key, "example.test");
    const tampered = Buffer.from(raw.toString().replace("hello", "hullo"));
    const { auth, msg } = setup(tampered);
    expect(await auth(msg, alex)).toEqual({ ok: false, reason: "dkim-fail" });
  });

  it("rejects a signature whose key can't be found in DNS", async () => {
    const raw = await sign(rawMessage("Alex Example <alex@example.test>"), key, "example.test", "other");
    const { auth, msg } = setup(raw);
    expect(await auth(msg, alex)).toEqual({ ok: false, reason: "dkim-fail" });
  });

  it("rejects when the raw From differs from the sender the API reported", async () => {
    const raw = await sign(rawMessage("Mallory <mallory@example.test>"), key, "example.test");
    const { auth, msg } = setup(raw);
    expect(await auth(msg, alex)).toEqual({ ok: false, reason: "dkim-from-mismatch" });
  });

  it("retries (transient) when the aligned signature's DNS lookup fails, even if an unaligned one passes", async () => {
    const raw = rawMessage("Alex Example <alex@example.test>");
    const signed = await dkimSign(raw, {
      signatureData: [
        { signingDomain: "example.test", selector: "s1", privateKey: key.privateKey, algorithm: "rsa-sha256" },
        { signingDomain: "relay.test", selector: "s1", privateKey: attackerKey.privateKey, algorithm: "rsa-sha256" }
      ]
    });
    const relayOnly = mockResolver({ "s1._domainkey.relay.test": attackerKey.txt });
    const resolver = async (name: string, rr: string) => {
      if (name === "s1._domainkey.example.test") throw Object.assign(new Error("SERVFAIL"), { code: "ESERVFAIL" });
      return relayOnly(name, rr);
    };
    const { api, msg } = setup(undefined);
    const auth = createDkimAuthenticator({ api, inboxId: 1001, fetchRaw: async () => Buffer.from(signed.signatures + raw), resolver, now: () => Date.UTC(2026, 10, 9, 12, 30) });
    expect(await auth(msg, alex)).toEqual({ ok: false, reason: "dkim-dns-temperror", transient: true });
  });

  it("retries (transient) when one signature is a partial-body pass and another hit a DNS temperror", async () => {
    const raw = rawMessage("Alex Example <alex@example.test>", "hello\r\nmore text\r\n");
    const signed = await dkimSign(raw, {
      signatureData: [
        { signingDomain: "example.test", selector: "s1", privateKey: key.privateKey, algorithm: "rsa-sha256", maxBodyLength: "hello\r\n".length },
        { signingDomain: "relay.test", selector: "s1", privateKey: attackerKey.privateKey, algorithm: "rsa-sha256" }
      ]
    } as never);
    const exampleOnly = mockResolver({ "s1._domainkey.example.test": key.txt });
    const resolver = async (name: string, rr: string) => {
      if (name === "s1._domainkey.relay.test") throw Object.assign(new Error("SERVFAIL"), { code: "ESERVFAIL" });
      return exampleOnly(name, rr);
    };
    const { api, msg } = setup(undefined);
    const auth = createDkimAuthenticator({ api, inboxId: 1001, fetchRaw: async () => Buffer.from(signed.signatures + raw), resolver, now: () => Date.UTC(2026, 10, 9, 12, 30) });
    expect(await auth(msg, alex)).toEqual({ ok: false, reason: "dkim-dns-temperror", transient: true });
  });

  it("treats a download timeout as transient", async () => {
    const { api, msg } = setup(undefined);
    const fetchRaw = async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    const auth = createDkimAuthenticator({ api, inboxId: 1001, fetchRaw, resolver: dns(), now: () => Date.UTC(2026, 10, 9, 12, 30) });
    expect(await auth(msg, alex)).toEqual({ ok: false, reason: "dkim-raw-unavailable", transient: true });
  });

  it("rejects when the raw message can't be downloaded", async () => {
    const { auth, msg } = setup(undefined);
    expect(await auth(msg, alex)).toEqual({ ok: false, reason: "dkim-raw-unavailable", transient: true });
  });

  it("asks the API for a fresh URL when the raw URL has expired", async () => {
    const raw = await sign(rawMessage("Alex Example <alex@example.test>"), key, "example.test");
    const { api, auth, msg, fetchRaw } = setup(raw, { raw_message_url: "https://raw.example.test/old", raw_message_expires_at: "2026-11-09T12:00:00.000Z" });
    api.getMessageImpl = async () => ({ ...msg, raw_message_url: "https://raw.example.test/fresh", raw_message_expires_at: "2026-11-09T13:30:00.000Z" });
    expect(await auth(msg, alex)).toEqual({ ok: true });
    expect(fetchRaw).toHaveBeenCalledTimes(1);
    expect(fetchRaw).toHaveBeenCalledWith("https://raw.example.test/fresh");
  });

  it("retries once with a fresh URL when the download is refused as expired (403)", async () => {
    const raw = await sign(rawMessage("Alex Example <alex@example.test>"), key, "example.test");
    const { api, msg } = setup(raw);
    const fetchRaw = vi.fn(async (url: string) => {
      if (url.endsWith("/stale")) throw Object.assign(new Error("expired"), { statusCode: 403 });
      return raw;
    });
    api.getMessageImpl = async () => ({ ...msg, raw_message_url: "https://raw.example.test/fresh" });
    const auth = createDkimAuthenticator({ api, inboxId: 1001, fetchRaw, resolver: dns(), now: () => Date.UTC(2026, 10, 9, 12, 30) });
    expect(await auth({ ...msg, raw_message_url: "https://raw.example.test/stale", raw_message_expires_at: "2026-11-09T13:00:00.000Z" }, alex)).toEqual({ ok: true });
    expect(fetchRaw).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the API gives no raw URL even after a re-get", async () => {
    const { api, auth, msg } = setup(undefined, { raw_message_url: null });
    api.getMessageImpl = async () => ({ ...msg, raw_message_url: null });
    expect(await auth(msg, alex)).toEqual({ ok: false, reason: "dkim-raw-unavailable" });
  });

  it("`unauthenticated` (allowUnauthenticated) skips only layer 2: the allowlist still applies", async () => {
    const msg = makeMessage({ from: "Mallory <mallory@evil.test>" });
    expect(await checkSender(msg, ["alex@example.test"], unauthenticated)).toEqual({ ok: false, reason: "not-allowlisted" });
    const ok = makeMessage();
    expect(await checkSender(ok, ["alex@example.test"], unauthenticated)).toMatchObject({ ok: true });
  });

  it("runs the allowlist before DKIM, so unlisted senders cost no download", async () => {
    const authenticate = vi.fn(async () => ({ ok: true as const }));
    const verdict = await checkSender(makeMessage({ from: "x@evil.test" }), ["alex@example.test"], authenticate);
    expect(verdict).toEqual({ ok: false, reason: "not-allowlisted" });
    expect(authenticate).not.toHaveBeenCalled();
  });
});

describe("sender check inside the pipeline", () => {
  it("drops an unlisted sender and a forged sender without replying or bouncing", async () => {
    const key = makeKey();
    const resolver = mockResolver({ "s1._domainkey.example.test": key.txt });
    const api = new FakeInbound();
    const forged = makeMessage({ from: "Alex Example <alex@example.test>" });
    const unlisted = makeMessage({ from: "Mallory <mallory@evil.test>" });
    const good = makeMessage({ from: "Alex Example <alex@example.test>" });
    const raws = new Map<string, Buffer>([
      [forged.id, Buffer.from(rawMessage("Alex Example <alex@example.test>"))],
      [good.id, await sign(rawMessage("Alex Example <alex@example.test>"), key, "example.test")]
    ]);
    const h = makeHarness({
      api,
      authenticate: createDkimAuthenticator({
        api,
        inboxId: 1001,
        resolver,
        fetchRaw: async (url) => raws.get(url.split("/").pop()!) ?? Buffer.alloc(0)
      })
    });
    await pollOnce(api, 1001, h.ledger);
    for (const m of [forged, unlisted, good]) api.add({ ...m, raw_message_url: `https://raw.example.test/${m.id}`, raw_message_expires_at: "2026-11-09T23:00:00.000Z" });
    await pollOnce(api, 1001, h.ledger);
    await h.runtime.drain();

    expect(await h.ledger.get(forged.id)).toMatchObject({ state: "dropped", reason: "dkim-missing" });
    expect(await h.ledger.get(unlisted.id)).toMatchObject({ state: "dropped", reason: "not-allowlisted" });
    expect((await h.ledger.get(good.id))?.state).toBe("done");
    expect(api.replies.map((r) => r.messageId)).toEqual([good.id]);
    expect(h.turns.map((t) => t.messageId)).toEqual([good.id]);
  });
});

describe("raw message download", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sets a deadline and stops reading a body without Content-Length once it passes the cap", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        sent++;
        c.enqueue(chunk);
      }
    });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(body));
    vi.stubGlobal("fetch", fetchMock);
    await expect(defaultFetchRaw("https://raw.example.test/big")).rejects.toThrow("raw message too large");
    expect(fetchMock.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
    expect(sent).toBeLessThan(MAX_RAW_BYTES / chunk.length + 5);
  });
});
