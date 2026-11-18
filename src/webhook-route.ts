import type { IncomingMessage, ServerResponse } from "node:http";
import { getRunningAccount } from "./account-runner.js";
import { SIGNATURE_HEADER, WEBHOOK_MAX_BODY_BYTES, WEBHOOK_PATH, accountIdFromPath, handleWebhook } from "./webhook.js";

export interface WebhookRouteDeps {
  readBody: (req: IncomingMessage, opts: { maxBytes: number; timeoutMs: number }) => Promise<string>;
  runDetached: (work: () => Promise<unknown>) => Promise<unknown>;
}

function respond(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(body);
}

/** HTTP glue around handleWebhook. Registered with auth "plugin": the signature is the only credential. */
export function createWebhookRouteHandler(deps: WebhookRouteDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    // A malformed percent-encoded path is a client error; decide that before any other work.
    let accountId: string;
    try {
      accountId = accountIdFromPath(new URL(req.url ?? WEBHOOK_PATH, "http://localhost").pathname);
    } catch {
      respond(res, 400, "bad request path");
      return true;
    }
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      respond(res, 405, "method not allowed");
      return true;
    }
    let raw: string;
    try {
      raw = await deps.readBody(req, { maxBytes: WEBHOOK_MAX_BODY_BYTES, timeoutMs: 10_000 });
    } catch {
      respond(res, 413, "body too large or unreadable");
      return true;
    }
    const header = req.headers[SIGNATURE_HEADER];
    const account = getRunningAccount(accountId);
    const result = await handleWebhook(raw, Array.isArray(header) ? header[0] : header, account);
    respond(res, result.status, result.body);
    if (result.enqueued && account) void deps.runDetached(() => account.runtime.drain());
    return true;
  };
}
