import fs from "fs";
import path from "path";
import { readJson, writeJsonAtomic } from "../lib/json-file";

/** Coerce admin/user input to a positive integer Telegram user id, or null. */
export function normalizeTelegramId(input: unknown): number | null {
  if (typeof input === "number") return Number.isInteger(input) && input > 0 ? input : null;
  if (typeof input !== "string") return null;
  const s = input.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

type WhitelistFile = { ids: number[] };

/**
 * UI-editable allow-list of Telegram user ids, persisted to disk. Deny-by-default:
 * an empty list allows nobody.
 */
export class TelegramWhitelistStore {
  private file: string;
  private ids: Set<number>;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "telegram-whitelist.json");
    const data = readJson<WhitelistFile>(this.file, { ids: [] });
    this.ids = new Set(this.clean(data.ids));
  }

  private clean(inputs: unknown[]): number[] {
    const out: number[] = [];
    for (const raw of inputs || []) {
      const id = normalizeTelegramId(raw);
      if (id !== null && !out.includes(id)) out.push(id);
    }
    return out;
  }

  private persist(): void {
    try {
      writeJsonAtomic(this.file, { ids: this.list() });
    } catch (err) {
      console.error("Failed to persist Telegram whitelist:", err);
    }
  }

  list(): number[] {
    return Array.from(this.ids);
  }

  isAllowed(userId: number): boolean {
    return this.ids.has(userId);
  }

  add(input: unknown): number[] {
    const id = normalizeTelegramId(input);
    if (id !== null && !this.ids.has(id)) {
      this.ids.add(id);
      this.persist();
    }
    return this.list();
  }

  remove(input: unknown): number[] {
    const id = normalizeTelegramId(input);
    if (id !== null && this.ids.delete(id)) this.persist();
    return this.list();
  }

  /** Replace the whole list (admin PUT). */
  replace(inputs: unknown[]): number[] {
    this.ids = new Set(this.clean(inputs));
    this.persist();
    return this.list();
  }
}
