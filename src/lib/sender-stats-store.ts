import fs from "fs";
import path from "path";
import { readJson, writeJsonAtomic } from "./json-file";

export type SenderRecord = {
  count: number;
  durationSec: number;
  words: number;
  firstSeen: number;
  lastSeen: number;
  greeted: boolean;
  /** Human-readable label for the admin table (e.g. Telegram first name). */
  displayName?: string;
};

export type SenderStats = {
  total: number;
  totalDurationSec: number;
  totalWords: number;
  byDay: Record<string, number>;
  bySender: Record<string, SenderRecord>;
};

export type SenderEvent = { ts: number; durationSec: number; words: number };

export type SenderStatsOptions = {
  /** File name inside dataDir. */
  filename?: string;
  /** Map a raw sender id to its storage key; return "" to drop the event. */
  normalizeKey?: (id: string) => string;
  /** Label used in error logs. */
  label?: string;
};

function emptyStats(): SenderStats {
  return { total: 0, totalDurationSec: 0, totalWords: 0, byDay: {}, bySender: {} };
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Per-sender + per-day usage counters for a chat bot, persisted to disk.
 * Separate from the global StatsStore (keyed by sender, not model) and the
 * source of the `greeted` flag that powers the first-message welcome.
 */
export class SenderStatsStore {
  private file: string;
  private stats: SenderStats;
  private normalizeKey: (id: string) => string;
  private label: string;

  constructor(dataDir: string, opts: SenderStatsOptions = {}) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, opts.filename || "sender-stats.json");
    this.normalizeKey = opts.normalizeKey || ((id) => (id || "").trim());
    this.label = opts.label || "sender";
    this.stats = { ...emptyStats(), ...readJson<Partial<SenderStats>>(this.file, {}) };
  }

  private persist(): void {
    try {
      writeJsonAtomic(this.file, this.stats);
    } catch (err) {
      console.error(`Failed to persist ${this.label} stats:`, err);
    }
  }

  private sender(key: string, ts: number): SenderRecord {
    const existing = this.stats.bySender[key];
    if (existing) return existing;
    const fresh: SenderRecord = {
      count: 0,
      durationSec: 0,
      words: 0,
      firstSeen: ts,
      lastSeen: ts,
      greeted: false,
    };
    this.stats.bySender[key] = fresh;
    return fresh;
  }

  record(id: string, event: SenderEvent, displayName?: string): void {
    const key = this.normalizeKey(id);
    if (!key) return;
    const s = this.stats;
    s.total += 1;
    s.totalDurationSec += event.durationSec;
    s.totalWords += event.words;
    s.byDay[dayKey(event.ts)] = (s.byDay[dayKey(event.ts)] || 0) + 1;

    const rec = this.sender(key, event.ts);
    rec.count += 1;
    rec.durationSec += event.durationSec;
    rec.words += event.words;
    rec.lastSeen = event.ts;
    if (displayName) rec.displayName = displayName;
    this.persist();
  }

  hasGreeted(id: string): boolean {
    const key = this.normalizeKey(id);
    return !!this.stats.bySender[key]?.greeted;
  }

  markGreeted(id: string, ts: number = Date.now()): void {
    const key = this.normalizeKey(id);
    if (!key) return;
    const rec = this.sender(key, ts);
    if (!rec.greeted) {
      rec.greeted = true;
      this.persist();
    }
  }

  get(): SenderStats {
    return this.stats;
  }
}
