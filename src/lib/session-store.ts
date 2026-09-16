const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_MAX_ENTRIES = 500;

type Entry<T> = { state: T; ts: number };

export type SessionStoreOptions = {
  ttlMs?: number;
  now?: () => number;
  /** Cap on live entries; the oldest is evicted when exceeded. */
  maxEntries?: number;
};

/**
 * Ephemeral, in-memory keyed state with a TTL. Shared by the chat bots
 * (WhatsApp: last transcript per sender; Telegram: per-transcript + per-chat
 * state). Not persisted — losing it on restart just means the user re-sends.
 * Expiry is lazy on read; insertion order drives `maxEntries` eviction.
 */
export class SessionStore<T> {
  private map = new Map<string, Entry<T>>();
  private ttlMs: number;
  private now: () => number;
  private maxEntries: number;

  constructor(opts: SessionStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  set(key: string, state: T): void {
    this.map.delete(key); // re-insert so Map order reflects recency
    this.map.set(key, { state, ts: this.now() });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.ts > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return entry.state;
  }

  /** Shallow-merge `patch` into an existing entry (refreshing its timestamp). */
  update(key: string, patch: Partial<T>): T | undefined {
    const current = this.get(key);
    if (current === undefined) return undefined;
    const next = { ...current, ...patch };
    this.set(key, next);
    return next;
  }

  clear(key: string): void {
    this.map.delete(key);
  }

  size(): number {
    return this.map.size;
  }
}
