import type { KeyedStore, Logger, OpenStore } from "./types.js";

/** The subset of the OpenClaw plugin API the channel uses. Kept structural so tests can fake it. */
export interface HostApi {
  runtime: {
    state: {
      openKeyedStoreV2: <T>(options: {
        namespace: string;
        maxEntries?: number;
        defaultTtlMs?: number;
        retention?: "bounded" | "retained";
      }) => {
        register(key: string, value: T): Promise<unknown>;
        registerIfAbsent(key: string, value: T): Promise<boolean>;
        lookup(key: string): Promise<T | undefined>;
        delete(key: string): Promise<unknown>;
        entries(): Promise<Array<{ key: string; value: T }>>;
      };
    };
  };
  logger?: { info(m: string): void; warn(m: string): void; error(m: string): void };
}

const MAX_ENTRIES = 20_000;

/**
 * Store namespaces allow `[a-z0-9.-]`. Account ids may hold anything, so every other
 * byte (uppercase, `_`, `.` itself, non-ASCII) is written as `.` plus two hex digits.
 * The mapping is injective: `team_a` and `team-a` (or `Team`/`team`) never share a store.
 * Plain lowercase ids such as `default` map to themselves.
 */
export function safeNamespace(ns: string): string {
  return [...Buffer.from(ns, "utf8")].map((b) => (/[a-z0-9-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `.${b.toString(16).padStart(2, "0")}`)).join("");
}

/**
 * Items and session links are bounded stores with a TTL (about a
 * week); the cursor and webhook secret are retained, so they never expire.
 */
export function createOpenStore(api: HostApi): OpenStore {
  return <T>(namespace: string, opts: { ttlMs?: number }): KeyedStore<T> => {
    const store = api.runtime.state.openKeyedStoreV2<T>(
      opts.ttlMs
        ? { namespace: safeNamespace(`mailtrap-${namespace}`), maxEntries: MAX_ENTRIES, defaultTtlMs: opts.ttlMs }
        : { namespace: safeNamespace(`mailtrap-${namespace}`), retention: "retained" }
    );
    return {
      register: async (key, value) => void (await store.register(key, value)),
      registerIfAbsent: (key, value) => store.registerIfAbsent(key, value),
      lookup: (key) => store.lookup(key),
      delete: async (key) => void (await store.delete(key)),
      entries: async () => (await store.entries()).map((e) => ({ key: e.key, value: e.value }))
    };
  };
}

export function toLogger(sink: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void } | undefined, prefix = ""): Logger {
  const fmt = (msg: string, meta?: Record<string, unknown>) => `${prefix}${msg}${meta ? ` ${JSON.stringify(meta)}` : ""}`;
  return {
    info: (m, meta) => sink?.info?.(fmt(m, meta)),
    warn: (m, meta) => sink?.warn?.(fmt(m, meta)),
    error: (m, meta) => sink?.error?.(fmt(m, meta))
  };
}

let hostApi: HostApi | undefined;
export function setHostApi(api: HostApi): void {
  hostApi = api;
}
export function getHostApi(): HostApi {
  if (!hostApi) throw new Error("mailtrap channel: the plugin runtime is not registered yet");
  return hostApi;
}
