import { MailtrapClient } from "mailtrap";
import type { InboundApi, InboxInfo, WebhookAdmin, WebhookInfo } from "./types.js";

const USER_AGENT = "mailtrap-openclaw (channel)";

/**
 * The channel view of Mailtrap. Only `reply` ever sends mail; the reply-all,
 * forward and Sending API calls are deliberately not reachable from here.
 * The inbox is found by walking folders, because the API
 * addresses inboxes under `/folders/{id}/inboxes`.
 */
export function createInboundApi(token: string): InboundApi {
  const client = new MailtrapClient({ token, userAgent: USER_AGENT });
  const inbound = client.inbound;
  let inboxCache: InboxInfo | undefined;
  return {
    async getInbox(inboxId) {
      if (inboxCache?.id === inboxId) return inboxCache;
      for (const folder of await inbound.folders.getList()) {
        for (const inbox of await inbound.inboxes.getList(folder.id)) {
          if (inbox.id === inboxId) {
            inboxCache = { id: inbox.id, name: inbox.name, address: inbox.address };
            return inboxCache;
          }
        }
      }
      throw new Error(`Inbound inbox ${inboxId} was not found with this token`);
    },
    listMessages: (inboxId, lastId) => inbound.messages.getList(inboxId, lastId ? { last_id: lastId } : undefined) as never,
    getMessage: (inboxId, id) => inbound.messages.get(inboxId, id) as never,
    getThread: (inboxId, threadId) => inbound.threads.get(inboxId, threadId) as never,
    reply: (inboxId, id, params) => inbound.messages.reply(inboxId, id, params)
  };
}

/** Webhook management with the broad account token; used only by the CLI. */
export function createWebhookAdmin(token: string, accountId: number): WebhookAdmin {
  const hooks = new MailtrapClient({ token, accountId, userAgent: USER_AGENT }).webhooks;
  const info = (w: { id: number; url: string; active: boolean; webhook_type: string; inbound_inbox_id?: number | null }): WebhookInfo => ({
    id: w.id,
    url: w.url,
    active: w.active,
    webhook_type: w.webhook_type,
    inbound_inbox_id: w.inbound_inbox_id ?? null
  });
  return {
    async list() {
      return (await hooks.getList()).data.map(info);
    },
    async create({ url, inboxId }) {
      const { data } = await hooks.create({ url, webhook_type: "inbound_receiving", inbound_inbox_id: inboxId, active: true });
      return { ...info(data), signing_secret: data.signing_secret };
    },
    async update(id, { url }) {
      return info((await hooks.update(id, { url, active: true })).data);
    },
    async delete(id) {
      await hooks.delete(id);
    }
  };
}
