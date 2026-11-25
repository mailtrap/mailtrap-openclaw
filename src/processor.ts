import { parseAddress } from "./address.js";
import { fetchAttachments, loadOutboundAttachments, type InboundAttachmentDeps, type InboundMedia, type OutboundDeps } from "./attachments.js";
import { httpStatus, isPermanentStatus } from "./http-status.js";
import { threadRef, type Ledger, type LedgerItem, type PendingReply } from "./ledger.js";
import { checkSender, isAutomatic, type Authenticator } from "./sender-check.js";
import type { ReplyIdentity } from "./config.js";
import type { InboundApi, InboundMessage, Logger } from "./types.js";

/** Message fetch retries with backoff (60 s doubling, capped at 30 min): 8 attempts span about 1.5 h of API outage. */
export const MAX_FETCH_ATTEMPTS = 8;
export const MAX_FETCH_BACKOFF_MS = 30 * 60_000;
export const MAX_SEND_ATTEMPTS = 8;
/** A throwing agent turn is paid work; it is retried this many times, with backoff, then the item fails. */
export const MAX_AUTH_ATTEMPTS = 5;
export const MAX_TURN_ATTEMPTS = 3;
export const TURN_BACKOFF_MS = 60_000;
/**
 * A dispatch that ran no turn (session busy, e.g. core restart recovery re-running the crashed turn) costs nothing,
 * so it has its own budget: retries every 60 s doubling up to 5 min, for at most 45 min from the first one, then `failed`.
 */
export const NOT_RUN_BACKOFF_MAX_MS = 5 * 60_000;
export const NOT_RUN_WINDOW_MS = 45 * 60_000;
/**
 * A dispatch into a busy session may have queued the turn as a follow-up that core admits once the session frees up.
 * The turn waits this long for that admission before it counts as not run.
 */
export const TURN_ADMISSION_WAIT_MS = 5 * 60_000;
/** Once a queued follow-up is admitted, the turn waits this long for it to settle; it is never dispatched again. */
export const TURN_OUTCOME_WAIT_MS = 10 * 60_000;
/** OpenClaw's keyed store rejects values over 1 MiB; the ledger item (with the pending reply) must stay clear of that, with margin. */
export const MAX_ITEM_BYTES = 1024 * 1024 - 64 * 1024;
/** Body of a reply that carries only attachments; the reply API needs text and/or html. */
export const ATTACHMENT_ONLY_TEXT = "Please see the attached file(s).";

export interface AgentTurnInput {
  accountId: string;
  /** Stable per conversation; it is the `:thread:` suffix of the session key, so one OpenClaw session per conversation. */
  conversationKey: string;
  messageId: string;
  /**
   * Id the host sees as this turn's message id. The first dispatch uses the message id; every later one
   * (a re-run after a crash or a failed turn) gets a fresh id. OpenClaw drops a dispatch whose message id
   * it already admitted (`skipped:duplicate`, also across a restart, while its own restart recovery
   * finishes the interrupted turn into a callback that died with the old process), which would lose the reply.
   */
  dispatchId: string;
  sender: { email: string; name: string | undefined };
  subject: string;
  body: string;
  receivedAt: string;
  /** The inbox address the message was sent to. */
  inboxAddress: string;
  /** Inbound attachments already stored in OpenClaw media. */
  media: InboundMedia[];
  /** Aborts a wait for a queued turn when the account stops. */
  signal?: AbortSignal;
}

/** What the agent said; null when it chose to stay silent. */
export type AgentReply = { text: string; media?: PendingReply["media"] } | null;
export type RunAgentTurn = (input: AgentTurnInput) => Promise<AgentReply>;

export interface ProcessorDeps {
  accountId: string;
  inboxId: number;
  api: InboundApi;
  ledger: Ledger;
  identity: ReplyIdentity;
  allowFrom: readonly string[];
  authenticate: Authenticator;
  runAgentTurn: RunAgentTurn;
  /** Inbound attachment handling; when absent attachments are ignored. */
  inbound?: Omit<InboundAttachmentDeps, "api" | "inboxId">;
  outbound?: OutboundDeps;
  log: Logger;
  now?: () => number;
}

export function bodyText(m: InboundMessage): string {
  if (m.text_body && m.text_body.trim()) return m.text_body.trim();
  if (m.html_body) {
    return m.html_body
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>|<\/(p|div|li|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .trim();
  }
  return "";
}

/**
 * The dispatch returned without running an agent turn for this item: the session was busy
 * (core restart recovery, another run) and the turn was queued or skipped. Not "no reply":
 * the item is retried later under a fresh dispatch id.
 */
export class TurnNotRunError extends Error {
  constructor() {
    super("no agent run started for this dispatch (session busy or turn queued)");
    this.name = "TurnNotRunError";
  }
}

/**
 * A queued follow-up for this item was admitted, but how it ended is unknown: it did not settle within
 * `TURN_OUTCOME_WAIT_MS` (`turn-outcome-timeout`), or it settled with nothing delivered and no completed
 * run (`turn-outcome-unknown`; core may be running it again). It is not dispatched again; the item fails.
 */
export class TurnOutcomeUnknownError extends Error {
  constructor(readonly reason: "turn-outcome-timeout" | "turn-outcome-unknown") {
    super(reason === "turn-outcome-timeout" ? "queued agent turn did not finish in time" : "queued agent turn settled without completing");
    this.name = "TurnOutcomeUnknownError";
  }
}

/** The account stopped while the turn waited for a queued follow-up; the item is left as it is. */
export class TurnAbortedError extends Error {
  constructor() {
    super("account stopped while waiting for the agent turn");
    this.name = "TurnAbortedError";
  }
}

/** Message id for the nth agent dispatch of one inbound message (n counts the dispatches already started). */
export function dispatchIdFor(messageId: string, startedBefore: number): string {
  return startedBefore === 0 ? messageId : `${messageId}:retry-${startedBefore}`;
}

/** RFC Message-ID of a reply we sent. Hosted inboxes use `<uuid@inbound-mailtrap.io>`. */
export function sentRfcIds(identity: ReplyIdentity, messageIds: readonly string[]): string[] {
  const domains = identity.kind === "hosted" ? [identity.domain] : [identity.domain, "inbound-mailtrap.io"];
  return messageIds.flatMap((id) => domains.map((d) => `<${id}@${d}>`));
}

/**
 * Turns one ledger item into at most one reply. Serial: the runtime never runs
 * two items of one account at the same time.
 */
export class Processor {
  constructor(private d: ProcessorDeps) {}

  async process(id: string, signal?: AbortSignal): Promise<void> {
    const item = await this.d.ledger.get(id);
    if (!item || (item.state !== "queued" && item.state !== "processing")) return;
    if (item.retryAt !== undefined && item.retryAt > (this.d.now ?? Date.now)()) return;

    let msg: InboundMessage;
    try {
      msg = await this.d.api.getMessage(this.d.inboxId, id);
    } catch (err) {
      const attempts = item.attempts + 1;
      const status = httpStatus(err);
      // 4xx other than 401/403/408/429 (404, 422, ...) will not clear by waiting; network errors, 5xx, 408, 429 and credential faults (401/403) will.
      const permanent = isPermanentStatus(status);
      const exhausted = permanent || attempts >= MAX_FETCH_ATTEMPTS;
      if (status === 401 || status === 403) this.d.log.warn("mailtrap: API token rejected; fix the channel apiToken, mail is kept and retried", { status });
      this.d.log.warn("mailtrap: could not fetch message", { id, attempts, status, permanent, exhausted, error: String(err) });
      await this.d.ledger.update(
        id,
        exhausted
          ? { state: "dropped", reason: "fetch-failed", attempts }
          : { attempts, retryAt: (this.d.now ?? Date.now)() + Math.min(TURN_BACKOFF_MS * 2 ** (attempts - 1), MAX_FETCH_BACKOFF_MS) }
      );
      return;
    }

    const own = [this.d.identity.inboxAddress, this.d.identity.from?.email].filter(Boolean).map((a) => a!.toLowerCase());
    const from = parseAddress(msg.from);
    if (from && own.includes(from.email)) return this.drop(id, "own-address");

    const verdict = await checkSender(msg, this.d.allowFrom, this.d.authenticate);
    if (!verdict.ok && verdict.transient) {
      // The check could not run (raw download or DNS failed). Retry with backoff; fail closed only at the cap.
      const authAttempts = (item.authAttempts ?? 0) + 1;
      const exhausted = authAttempts >= MAX_AUTH_ATTEMPTS;
      this.d.log.warn("mailtrap: sender check could not run", { id, reason: verdict.reason, authAttempts, exhausted });
      await this.d.ledger.update(
        id,
        exhausted
          ? { state: "dropped", reason: verdict.reason, authAttempts }
          : { authAttempts, retryAt: (this.d.now ?? Date.now)() + TURN_BACKOFF_MS * 2 ** (authAttempts - 1) }
      );
      return;
    }
    if (!verdict.ok) {
      // Logged without the sender's address or the body: it is unauthenticated input.
      this.d.log.warn("mailtrap: message dropped", { id, reason: verdict.reason });
      return this.drop(id, verdict.reason);
    }
    if (isAutomatic(verdict.headers)) {
      this.d.log.warn("mailtrap: message dropped", { id, reason: "auto-submitted" });
      return this.drop(id, "auto-submitted");
    }

    const conversationKey =
      (await this.d.ledger.findConversation([msg.in_reply_to, ...msg.references, msg.thread_id ? threadRef(msg.thread_id) : null])) ?? msg.id;
    await this.d.ledger.linkConversation(conversationKey, [msg.rfc_message_id, msg.thread_id ? threadRef(msg.thread_id) : null]);
    await this.d.ledger.update(id, {
      state: "processing",
      conversationKey,
      threadId: msg.thread_id,
      inboundRfcId: msg.rfc_message_id,
      inboundReceivedAt: msg.received_at,
      dispatchAttempts: (item.dispatchAttempts ?? 0) + 1
    });

    let media: InboundMedia[] = [];
    let notes: string[] = [];
    if (msg.attachments.length > 0 && this.d.inbound) {
      ({ media, notes } = await fetchAttachments(msg, { ...this.d.inbound, api: this.d.api, inboxId: this.d.inboxId }));
    }
    let reply: AgentReply;
    try {
      reply = await this.d.runAgentTurn({
        accountId: this.d.accountId,
        conversationKey,
        messageId: msg.id,
        dispatchId: dispatchIdFor(msg.id, item.dispatchAttempts ?? 0),
        sender: verdict.sender,
        subject: msg.subject ?? "",
        body: [bodyText(msg), ...notes.map((n) => `[${n}]`)].filter(Boolean).join("\n\n"),
        media,
        receivedAt: msg.received_at,
        inboxAddress: this.d.identity.inboxAddress,
        signal
      });
    } catch (err) {
      // Stopped mid-wait: left `processing` as after a crash; the next start dispatches it again.
      if (err instanceof TurnAbortedError) return;
      if (err instanceof TurnOutcomeUnknownError) {
        this.d.log.warn("mailtrap: queued agent turn ended without a known outcome; not running it again", { id, reason: err.reason });
        await this.d.ledger.update(id, { state: "failed", reason: err.reason });
        return;
      }
      const now = (this.d.now ?? Date.now)();
      if (err instanceof TurnNotRunError) {
        const notRunAttempts = (item.notRunAttempts ?? 0) + 1;
        const notRunSince = item.notRunSince ?? now;
        const exhausted = now - notRunSince >= NOT_RUN_WINDOW_MS;
        this.d.log.warn("mailtrap: session busy, turn not run; retrying later", { id, notRunAttempts, exhausted });
        await this.d.ledger.update(
          id,
          exhausted
            ? { state: "failed", reason: "session-busy-timeout", notRunAttempts, notRunSince }
            : { notRunAttempts, notRunSince, retryAt: now + Math.min(TURN_BACKOFF_MS * 2 ** (notRunAttempts - 1), NOT_RUN_BACKOFF_MAX_MS) }
        );
        return;
      }
      const turnAttempts = (item.turnAttempts ?? 0) + 1;
      const exhausted = turnAttempts >= MAX_TURN_ATTEMPTS;
      this.d.log.warn("mailtrap: agent turn failed", { id, turnAttempts, exhausted, error: String(err) });
      await this.d.ledger.update(
        id,
        exhausted
          ? { state: "failed", reason: "agent-turn-failed", turnAttempts }
          : { turnAttempts, retryAt: now + TURN_BACKOFF_MS * 2 ** (turnAttempts - 1) }
      );
      return;
    }
    if (!reply || (!reply.text.trim() && !(reply.media?.length))) return this.drop(id, "no-reply");

    await this.startReply(id, { text: reply.text, media: reply.media ?? [] });
  }

  private async drop(id: string, reason: string): Promise<void> {
    await this.d.ledger.update(id, { state: "dropped", reason });
  }

  /** Marks `sending` first, so a crash after the API call can be reconciled on restart. */
  async startReply(id: string, reply: PendingReply): Promise<void> {
    const cur = (await this.d.ledger.get(id)) as LedgerItem;
    const size = Buffer.byteLength(JSON.stringify({ ...cur, state: "sending", reply, sendStartedAt: Date.now(), sendAttempts: 0 }));
    if (size > MAX_ITEM_BYTES) {
      // The reply cannot be stored, so crash recovery could not see it: send nothing, and
      // never rerun the (paid) agent turn for it.
      this.d.log.warn("mailtrap: reply is too large to store; not sent", { id, bytes: size, limit: MAX_ITEM_BYTES });
      await this.d.ledger.update(id, { state: "failed", reason: "reply-too-large" });
      return;
    }
    await this.d.ledger.update(id, { state: "sending", reply, sendStartedAt: Date.now(), sendAttempts: 0 });
    await this.deliver(id);
  }

  /**
   * Performs the reply call for an item already marked `sending`. A failed
   * call is ambiguous (the request may have been accepted), so the item stays
   * `sending` for `reconcile` to look at, unless the API refused it for good.
   */
  async deliver(id: string): Promise<void> {
    const item = (await this.d.ledger.get(id)) as LedgerItem;
    const reply = item.reply as PendingReply;
    let res: { message_ids: string[] };
    try {
      const out = reply.media.length && this.d.outbound ? await loadOutboundAttachments(reply.media, this.d.outbound) : { attachments: [], notes: reply.media.length ? ["Attachments are not enabled."] : [] };
      let text = [reply.text.trim(), ...out.notes.map((n) => `(${n})`)].filter(Boolean).join("\n\n");
      if (!text && out.attachments.length) text = ATTACHMENT_ONLY_TEXT;
      res = await this.d.api.reply(this.d.inboxId, id, {
        ...(this.d.identity.from ? { from: this.d.identity.from } : {}),
        text,
        ...(out.attachments.length ? { attachments: out.attachments } : {})
      });
    } catch (err) {
      const status = httpStatus(err);
      const attempts = (item.sendAttempts ?? 0) + 1;
      const permanent = isPermanentStatus(status);
      const exhausted = attempts >= MAX_SEND_ATTEMPTS;
      if (status === 401 || status === 403) this.d.log.warn("mailtrap: API token rejected; fix the channel apiToken, the reply is kept and retried", { status });
      this.d.log.warn("mailtrap: reply failed", { id, status, attempts, permanent });
      await this.d.ledger.update(id, permanent || exhausted ? { state: "failed", reason: permanent ? `reply-refused-${status}` : "reply-retries-exhausted", sendAttempts: attempts } : { sendAttempts: attempts, retryAt: (this.d.now ?? Date.now)() + Math.min(TURN_BACKOFF_MS * 2 ** (attempts - 1), MAX_FETCH_BACKOFF_MS) });
      return;
    }
    await this.d.ledger.update(id, { sentMessageIds: res.message_ids });
    await this.complete(id, res.message_ids);
  }

  /**
   * Crash safety. For an item left `sending`: if the reply call
   * already returned ids, finish it. Otherwise look at the inbound message's
   * thread; an outbound message there whose `in_reply_to` is the inbound
   * message's Message-ID means the reply went out, so mark it done. If no such
   * message exists, or the thread can't be read, resend. The resend fallback can duplicate a reply that did
   * go out but could not be seen; it never loses one.
   */
  async reconcile(id: string): Promise<"done" | "resent" | "failed" | "skipped"> {
    const item = await this.d.ledger.get(id);
    if (!item || item.state !== "sending" || !item.reply) return "skipped";
    if (item.retryAt !== undefined && item.retryAt > (this.d.now ?? Date.now)()) return "skipped";
    if (item.sentMessageIds?.length) {
      await this.complete(id, item.sentMessageIds);
      return "done";
    }
    if (item.threadId) {
      // Only a failed thread read means "can't tell, resend". A failure in `complete()`
      // below propagates, so the next drain retries completion instead of sending again.
      const thread = await this.d.api.getThread(this.d.inboxId, item.threadId).catch((err) => {
        this.d.log.warn("mailtrap: thread unreadable during recovery; resending", { id, error: String(err) });
        return undefined;
      });
      // Only an outbound that answers this very message counts: two inbound messages
      // in one thread each get their own reply, so a later outbound is not proof.
      const sent = thread?.messages.find((m) => m.direction === "outbound" && !!item.inboundRfcId && m.in_reply_to === item.inboundRfcId);
      if (sent) {
        this.d.log.info("mailtrap: reply found in the thread after a restart; not resending", { id });
        await this.complete(id, [sent.id], sent.rfc_message_id ? [sent.rfc_message_id] : []);
        return "done";
      }
    }
    await this.deliver(id);
    const after = (await this.d.ledger.get(id))?.state;
    return after === "done" ? "resent" : after === "failed" ? "failed" : "skipped";
  }

  /** Records the sent message in the conversation index and closes the item. */
  async complete(id: string, sentMessageIds: readonly string[], rfcIds?: readonly string[]): Promise<void> {
    const item = (await this.d.ledger.get(id)) as LedgerItem;
    if (item.conversationKey) {
      await this.d.ledger.linkConversation(item.conversationKey, [...sentRfcIds(this.d.identity, sentMessageIds), ...(rfcIds ?? [])]);
    }
    await this.d.ledger.update(id, { state: "done", sentMessageIds: [...sentMessageIds] });
  }
}
