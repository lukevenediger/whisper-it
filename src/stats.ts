import fs from "fs";
import path from "path";

export type StatsEvent = {
  ts: number;
  model: string;
  language: string;
  durationSec: number;
  words: number;
  audioBytes: number;
  fromRecording: boolean;
  filename: string;
};

export type Stats = {
  total: number;
  totalDurationSec: number;
  totalWords: number;
  totalAudioBytes: number;
  byModel: Record<string, { count: number; durationSec: number }>;
  byLanguage: Record<string, number>;
  byDay: Record<string, number>;
  recordingCount: number;
  uploadCount: number;
  firstAt: number | null;
  lastAt: number | null;
  longestDurationSec: number;
  longest: StatsEvent | null;
  recent: StatsEvent[];
};

const RECENT_MAX = 50;

function emptyStats(): Stats {
  return {
    total: 0,
    totalDurationSec: 0,
    totalWords: 0,
    totalAudioBytes: 0,
    byModel: {},
    byLanguage: {},
    byDay: {},
    recordingCount: 0,
    uploadCount: 0,
    firstAt: null,
    lastAt: null,
    longestDurationSec: 0,
    longest: null,
    recent: [],
  };
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export class StatsStore {
  private file: string;
  private cache: Stats;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "stats.json");
    this.cache = this.load();
  }

  private load(): Stats {
    try {
      const raw = fs.readFileSync(this.file, "utf-8");
      const parsed = JSON.parse(raw) as Partial<Stats>;
      return { ...emptyStats(), ...parsed };
    } catch {
      return emptyStats();
    }
  }

  private persist(): void {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.cache, null, 2));
    fs.renameSync(tmp, this.file);
  }

  record(event: StatsEvent): void {
    const s = this.cache;
    s.total += 1;
    s.totalDurationSec += event.durationSec;
    s.totalWords += event.words;
    s.totalAudioBytes += event.audioBytes;

    const m = s.byModel[event.model] || { count: 0, durationSec: 0 };
    m.count += 1;
    m.durationSec += event.durationSec;
    s.byModel[event.model] = m;

    if (event.language) {
      s.byLanguage[event.language] = (s.byLanguage[event.language] || 0) + 1;
    }

    const dk = dayKey(event.ts);
    s.byDay[dk] = (s.byDay[dk] || 0) + 1;

    if (event.fromRecording) s.recordingCount += 1;
    else s.uploadCount += 1;

    if (s.firstAt == null || event.ts < s.firstAt) s.firstAt = event.ts;
    if (s.lastAt == null || event.ts > s.lastAt) s.lastAt = event.ts;

    if (event.durationSec > s.longestDurationSec) {
      s.longestDurationSec = event.durationSec;
      s.longest = event;
    }

    s.recent.unshift(event);
    if (s.recent.length > RECENT_MAX) s.recent.length = RECENT_MAX;

    try {
      this.persist();
    } catch (err) {
      console.error("Failed to persist stats:", err);
    }
  }

  get(): Stats {
    return this.cache;
  }
}
