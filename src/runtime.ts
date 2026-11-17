import type { Ledger } from "./ledger.js";
import { pollOnce } from "./poller.js";
import type { Processor } from "./processor.js";
import type { InboundApi, Logger } from "./types.js";

export interface RuntimeDeps {
  api: InboundApi;
  inboxId: number;
  ledger: Ledger;
  processor: Processor;
  pollIntervalMs: number;
  /** With a webhook secret stored, polling only reconciles this often. Default 10 minutes. */
  reconcileIntervalMs?: number;
  now?: () => number;
  log: Logger;
}

export const DEFAULT_RECONCILE_MS = 10 * 60 * 1000;

/** Per-account engine: owns the poll timer and runs ledger items one at a time. */
export class AccountRuntime {
  private running = false;
  private again = false;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private current: Promise<void> = Promise.resolve();
  private lastPollAt: number | undefined;

  constructor(private d: RuntimeDeps) {}

  /** Starts polling until `signal` aborts. Resolves once the first pass has been scheduled. */
  async start(signal?: AbortSignal): Promise<void> {
    signal?.addEventListener("abort", () => void this.stop(), { once: true });
    await this.cycle();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.current;
  }

  /**
   * One timer tick. Without a webhook secret every tick polls.
   * With one, the first tick after start polls as the catch-up for mail that
   * arrived while the gateway was down, then polling only reconciles every
   * `reconcileIntervalMs`; webhook-delivered ids are drained on every tick.
   */
  async tick(): Promise<void> {
    const now = (this.d.now ?? Date.now)();
    let due = true;
    try {
      const hook = await this.d.ledger.getWebhook();
      due = !hook || this.lastPollAt === undefined || now - this.lastPollAt >= (this.d.reconcileIntervalMs ?? DEFAULT_RECONCILE_MS);
    } catch (err) {
      this.d.log.warn("mailtrap: could not read webhook state; polling", { error: String(err) });
    }
    if (due) {
      this.lastPollAt = now;
      try {
        await pollOnce(this.d.api, this.d.inboxId, this.d.ledger, "poll", this.d.log);
      } catch (err) {
        this.d.log.warn("mailtrap: poll failed", { error: String(err) });
      }
    }
    await this.drain();
  }

  private async cycle(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.tick();
    } catch (err) {
      // A store or network failure must not end polling: log it and try again next interval.
      this.d.log.error("mailtrap: poll cycle failed; will retry", { error: String(err) });
    } finally {
      if (!this.stopped) {
        this.timer = setTimeout(() => void this.cycle(), this.d.pollIntervalMs);
        this.timer.unref?.();
      }
    }
  }

  /** Processes queued items serially; calls arriving meanwhile cause one more pass. */
  async drain(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.current;
    }
    this.running = true;
    this.current = (async () => {
      try {
        do {
          this.again = false;
          for (const item of await this.d.ledger.inStates("sending")) {
            if (this.stopped) return;
            try {
              await this.d.processor.reconcile(item.id);
            } catch (err) {
              this.d.log.error("mailtrap: recovery failed", { id: item.id, error: String(err) });
            }
          }
          const pending = await this.d.ledger.inStates("queued", "processing");
          for (const item of pending) {
            if (this.stopped) return;
            try {
              await this.d.processor.process(item.id);
            } catch (err) {
              this.d.log.error("mailtrap: item failed", { id: item.id, error: String(err) });
            }
          }
        } while (this.again && !this.stopped);
      } catch (err) {
        this.d.log.error("mailtrap: could not read the ledger", { error: String(err) });
      } finally {
        this.running = false;
      }
    })();
    return this.current;
  }
}
