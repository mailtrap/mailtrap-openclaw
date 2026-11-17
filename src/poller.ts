import type { Ledger } from "./ledger.js";
import { EPOCH_CURSOR } from "./ledger.js";
import type { InboundApi, Logger } from "./types.js";

const MAX_PAGES = 50;

export interface PollResult {
  /** True on the very first poll of an account, which only sets the cursor. */
  initialized: boolean;
  enqueued: number;
}

/**
 * One pass over the inbox. The list is newest first, so a pass
 * pages back until it reaches the cursor message or anything received before
 * it, enqueues everything newer (the ledger de-duplicates), and only then
 * moves the cursor. A crash between the two leaves the cursor behind, which
 * re-enqueues nothing new. Message ids are treated as opaque; recency is the
 * list order and `received_at`.
 *
 * On the first ever pass the cursor is set to the newest message, and every
 * message on that first page is recorded as ignored, so the channel never
 * replies to mail that was already there.
 */
export async function pollOnce(
  api: InboundApi,
  inboxId: number,
  ledger: Ledger,
  source: "poll" | "webhook" = "poll",
  log?: Logger
): Promise<PollResult> {
  const cursor = await ledger.getCursor();
  if (cursor === undefined) {
    const first = await api.listMessages(inboxId);
    for (const m of first.data) await ledger.enqueueIgnored(m.id, "before-first-start");
    const newest = first.data[0];
    await ledger.setCursor(newest ? { id: newest.id, receivedAt: newest.received_at } : EPOCH_CURSOR);
    log?.info("mailtrap: first start, cursor set; existing mail is ignored", { ignored: first.data.length });
    return { initialized: true, enqueued: 0 };
  }

  const cursorTime = Date.parse(cursor.receivedAt);
  const fresh: Array<{ id: string; receivedAt: string }> = []; // newest first
  let lastId: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await api.listMessages(inboxId, lastId);
    let reachedCursor = false;
    for (const m of res.data) {
      if (m.id === cursor.id || Date.parse(m.received_at) < cursorTime) {
        reachedCursor = true;
        break;
      }
      fresh.push({ id: m.id, receivedAt: m.received_at });
    }
    if (reachedCursor || res.data.length === 0 || !res.last_id) break;
    lastId = res.last_id;
  }

  let enqueued = 0;
  for (const m of [...fresh].reverse()) {
    if (await ledger.enqueue(m.id, source)) enqueued++;
  }
  if (fresh.length > 0) await ledger.setCursor({ id: fresh[0]!.id, receivedAt: fresh[0]!.receivedAt });
  return { initialized: false, enqueued };
}
