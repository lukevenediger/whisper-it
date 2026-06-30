import fs from "fs";
import path from "path";
import { readJson, writeJsonAtomic } from "./json-file";
import { jidToNumber } from "./whitelist-store";

export type SenderRecord = {
  count: number;
  durationSec: number;
  words: number;
  firstSeen: number;
  lastSeen: number;
  greeted: boolean;
};

export type SenderStats = {
  total: number;
  totalDurationSec: number;
  totalWords: number;
  byDay: Record<string, number>;
  bySender: Record<string, SenderRecord>;
};

export type SenderEvent = { ts: number; durationSec: number; words: number };

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
 * Per-sender + per-day usage counters for WhatsApp transcriptions, persisted to
 * disk. Separate from the global StatsStore (keyed by phone number, not model)
 * and the source of the `greeted` flag that powers the first-message welcome.
 */
export class SenderStatsStore {
  private file: string;
  private stats: SenderStats;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "whatsapp-stats.json");
    this.stats = { ...emptyStats(), ...readJson<Partial<SenderStats>>(this.file, {}) };
  }

  private persist(): void {
    try {
      writeJsonAtomic(this.file, this.stats);
    } catch (err) {
      console.error("Failed to persist WhatsApp stats:", err);
    }
  }

  private sender(num: string, ts: number): SenderRecord {
    const existing = this.stats.bySender[num];
    if (existing) return existing;
    const fresh: SenderRecord = {
      count: 0,
      durationSec: 0,
      words: 0,
      firstSeen: ts,
      lastSeen: ts,
      greeted: false,
    };
    this.stats.bySender[num] = fresh;
    return fresh;
  }

  record(jid: string, event: SenderEvent): void {
    const num = jidToNumber(jid);
    if (!num) return;
    const s = this.stats;
    s.total += 1;
    s.totalDurationSec += event.durationSec;
    s.totalWords += event.words;
    s.byDay[dayKey(event.ts)] = (s.byDay[dayKey(event.ts)] || 0) + 1;

    const rec = this.sender(num, event.ts);
    rec.count += 1;
    rec.durationSec += event.durationSec;
    rec.words += event.words;
    rec.lastSeen = event.ts;
    this.persist();
  }

  hasGreeted(jid: string): boolean {
    const num = jidToNumber(jid);
    return !!this.stats.bySender[num]?.greeted;
  }

  markGreeted(jid: string, ts: number = Date.now()): void {
    const num = jidToNumber(jid);
    if (!num) return;
    const rec = this.sender(num, ts);
    if (!rec.greeted) {
      rec.greeted = true;
      this.persist();
    }
  }

  get(): SenderStats {
    return this.stats;
  }
}
