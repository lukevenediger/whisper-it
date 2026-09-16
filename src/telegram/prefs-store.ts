import fs from "fs";
import path from "path";
import { readJson, writeJsonAtomic } from "../lib/json-file";
import { VALID_MODELS } from "../lib/engine";
import { VALID_LANGUAGES } from "../lib/languages";
import { ATTR_DEFAULT_MODEL } from "../lib/attribution";
import type { GlobalDefaults, UserPrefs } from "./types";

export const DEFAULTS: GlobalDefaults = {
  model: "small",
  language: "auto",
  diarizeEnabled: true,
  attrModel: ATTR_DEFAULT_MODEL,
};

type PrefsFile = { defaults: Partial<GlobalDefaults>; users: Record<string, UserPrefs> };

function cleanModel(v: unknown): string | undefined {
  return typeof v === "string" && VALID_MODELS.includes(v) ? v : undefined;
}

function cleanLanguage(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase();
  if (!s) return "auto";
  return VALID_LANGUAGES.has(s) ? s : undefined;
}

function cleanUser(v: unknown): UserPrefs {
  const out: UserPrefs = {};
  if (v && typeof v === "object") {
    const m = cleanModel((v as UserPrefs).model);
    const l = cleanLanguage((v as UserPrefs).language);
    if (m) out.model = m;
    if (l) out.language = l;
  }
  return out;
}

/**
 * Telegram transcription preferences: admin-set global defaults plus per-user
 * overrides (set via /model and /language). One JSON file, atomic writes.
 */
export class PrefsStore {
  private file: string;
  private defaults: GlobalDefaults;
  private users: Record<string, UserPrefs>;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "telegram-prefs.json");
    const data = readJson<Partial<PrefsFile>>(this.file, {});
    this.defaults = { ...DEFAULTS };
    this.applyDefaults(data.defaults || {});
    this.users = {};
    for (const [id, prefs] of Object.entries(data.users || {})) {
      const clean = cleanUser(prefs);
      if (Object.keys(clean).length) this.users[id] = clean;
    }
  }

  private applyDefaults(patch: Partial<GlobalDefaults>): void {
    const m = cleanModel(patch.model);
    const l = cleanLanguage(patch.language);
    if (m) this.defaults.model = m;
    if (l) this.defaults.language = l;
    if (typeof patch.diarizeEnabled === "boolean")
      this.defaults.diarizeEnabled = patch.diarizeEnabled;
    if (typeof patch.attrModel === "string" && patch.attrModel.trim())
      this.defaults.attrModel = patch.attrModel.trim();
  }

  private persist(): void {
    try {
      writeJsonAtomic(this.file, { defaults: this.defaults, users: this.users });
    } catch (err) {
      console.error("Failed to persist Telegram prefs:", err);
    }
  }

  getDefaults(): GlobalDefaults {
    return { ...this.defaults };
  }

  setDefaults(patch: Partial<GlobalDefaults>): GlobalDefaults {
    this.applyDefaults(patch || {});
    this.persist();
    return this.getDefaults();
  }

  getUser(userId: number): UserPrefs {
    return { ...(this.users[String(userId)] || {}) };
  }

  setUser(userId: number, patch: UserPrefs): UserPrefs {
    const merged = { ...this.getUser(userId), ...cleanUser(patch) };
    this.users[String(userId)] = merged;
    this.persist();
    return { ...merged };
  }

  clearUser(userId: number): void {
    if (delete this.users[String(userId)]) this.persist();
  }

  listUsers(): Record<string, UserPrefs> {
    return JSON.parse(JSON.stringify(this.users));
  }

  /** Effective settings for a user: defaults with their overrides applied. */
  resolve(userId: number): GlobalDefaults {
    const u = this.getUser(userId);
    return {
      ...this.defaults,
      ...(u.model ? { model: u.model } : {}),
      ...(u.language ? { language: u.language } : {}),
    };
  }
}
