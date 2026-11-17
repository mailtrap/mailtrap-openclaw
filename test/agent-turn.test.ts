import { describe, expect, it } from "vitest";
import { createAgentTurnRunner, emailSessionKey } from "../src/agent-turn.js";
import { TurnNotRunError } from "../src/processor.js";
import { guardToolCall, isEmailSessionKey } from "../src/tool-policy.js";
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
    // core returns `{ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } }` and reports no run
    const host = makeTurnHost(async () => ({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } }));
    await expect(createAgentTurnRunner({ cfg: {}, accountId: "d", onError: () => {}, host })(input)).rejects.toBeInstanceOf(TurnNotRunError);
  });

  it("a run that finished before return is a real silence; one that started or was admitted without a terminal outcome is retried", async () => {
    const mk = (fn: (ro: any) => unknown) => createAgentTurnRunner({ cfg: {}, accountId: "d", onError: () => {}, host: makeTurnHost(async (p) => fn((p as any).replyOptions)) });
    expect(await mk((ro) => ro.onAgentRunTerminalOutcome("completed"))(input)).toBeNull();
    for (const hook of ["onAgentRunStart", "onPreparedAgentRunStart", "onQueuedFollowupAdmitted"]) {
      // the hook fires before the dispatch returns the busy result; delivery would come later
      await expect(mk((ro) => ro[hook]?.("run-1"))(input)).rejects.toBeInstanceOf(TurnNotRunError);
    }
  });

  it("the key the turn runs under is blocked by the tool guard", async () => {
    let sk = "";
    await createAgentTurnRunner({ cfg: { session: { dmScope: "main" } }, accountId: "default", onError: () => {}, host: makeTurnHost(async (p) => ((sk = (p as any).route.sessionKey), ranSilently(p))) })(input);
    expect(guardToolCall({ toolName: "mailtrap__send-email" }, { channelId: "alex@example.test", sessionKey: sk })).toMatchObject({ block: true });
  });
});
