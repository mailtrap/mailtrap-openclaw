type StatusCarrier = { statusCode?: unknown; status?: unknown; response?: { status?: unknown }; cause?: unknown };

function read(e: unknown): number | undefined {
  const c = e as StatusCarrier | null | undefined;
  if (!c || typeof c !== "object") return undefined;
  for (const n of [c.statusCode, c.status, c.response?.status]) if (typeof n === "number") return n;
  return undefined;
}

/**
 * HTTP status of a failed SDK call. The mailtrap SDK wraps the AxiosError as
 * `MailtrapError.cause`, so the status is looked up on the error and down its
 * cause chain. Message text is never parsed: a network error such as
 * "connect ECONNREFUSED 52.1.2.3:443" carries no HTTP status.
 */
export function httpStatus(err: unknown): number | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur; i++) {
    const n = read(cur);
    if (n !== undefined) return n;
    cur = (cur as StatusCarrier).cause;
  }
  return undefined;
}

/**
 * True for 4xx statuses that waiting cannot fix (404, 422, ...). 408 and 429 are
 * transient; 401 and 403 are credential faults that clear once the token is
 * rotated or re-scoped, so they are retried with backoff rather than dropped.
 */
export function isPermanentStatus(status: number | undefined): boolean {
  return status !== undefined && status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status);
}
