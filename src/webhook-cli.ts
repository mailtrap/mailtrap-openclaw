import { httpStatus } from "./http-status.js";
import { webhookUrlFor } from "./webhook.js";
import type { Ledger } from "./ledger.js";
import type { WebhookAdmin } from "./types.js";

export interface ConnectOptions {
  admin: WebhookAdmin;
  ledger: Ledger;
  accountId: string;
  inboxId: number;
  publicUrl: string;
  /** Delete and recreate an existing inbox webhook whose signing secret isn't stored here. */
  replace?: boolean;
}

export interface ConnectResult {
  url: string;
  webhookId: number;
  action: "created" | "updated" | "recreated";
}

/**
 * `openclaw mailtrap webhook connect`. Creates the inbound_receiving webhook
 * for the inbox, or updates the URL of the one this plugin created. The
 * signing secret is returned only on create, so it is stored in the plugin's
 * state store and never printed. The admin client holds the
 * broad account token; nothing here keeps it.
 */
export async function connectWebhook(o: ConnectOptions): Promise<ConnectResult> {
  const url = webhookUrlFor(o.publicUrl, o.accountId);
  const stored = await o.ledger.getWebhook();
  const existing = (await o.admin.list()).find((w) => w.webhook_type === "inbound_receiving" && w.inbound_inbox_id === o.inboxId);

  if (existing && stored?.id === existing.id) {
    const updated = await o.admin.update(existing.id, { url });
    await o.ledger.setWebhook({ secret: stored.secret, id: existing.id, url: updated.url });
    return { url, webhookId: existing.id, action: "updated" };
  }
  if (existing) {
    if (!o.replace) {
      throw new Error(
        `Inbox ${o.inboxId} already has an inbound webhook (id ${existing.id}) that this plugin did not create, so its signing secret is unknown. Re-run with --replace to delete and recreate it.`
      );
    }
    await o.admin.delete(existing.id);
  }
  const created = await o.admin.create({ url, inboxId: o.inboxId });
  await o.ledger.setWebhook({ secret: created.signing_secret, id: created.id, url: created.url });
  return { url, webhookId: created.id, action: existing ? "recreated" : "created" };
}

/** `openclaw mailtrap webhook disconnect`: deletes the webhook and forgets the stored secret. */
export async function disconnectWebhook(o: { admin: WebhookAdmin; ledger: Ledger }): Promise<{ deleted: boolean }> {
  const stored = await o.ledger.getWebhook();
  if (!stored) return { deleted: false };
  if (stored.id !== undefined) {
    try {
      await o.admin.delete(stored.id);
    } catch (err) {
      if (httpStatus(err) !== 404) throw err;
    }
  }
  await o.ledger.clearWebhook();
  return { deleted: true };
}
