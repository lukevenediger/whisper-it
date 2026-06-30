import { FlowState } from "./types";

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

type Entry = { state: FlowState; ts: number };

/**
 * Ephemeral, in-memory store of each sender's most recent transcript, powering
 * the interactive "reply 'diarize'" flow. Not persisted — losing it on restart
 * just means a sender re-sends to diarize. Entries expire after the TTL.
 */
export class SessionStore {
  private map = new Map<string, Entry>();
  private ttlMs: number;
  private now: () => number;

  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  set(jid: string, state: FlowState): void {
    this.map.set(jid, { state, ts: this.now() });
  }

  get(jid: string): FlowState | undefined {
    const entry = this.map.get(jid);
    if (!entry) return undefined;
    if (this.now() - entry.ts > this.ttlMs) {
      this.map.delete(jid);
      return undefined;
    }
    return entry.state;
  }

  clear(jid: string): void {
    this.map.delete(jid);
  }
}
