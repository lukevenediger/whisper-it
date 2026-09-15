import fs from "fs";
import path from "path";
import { readJson, writeJsonAtomic } from "../lib/json-file";

/** Reduce any phone input to bare E.164 digits (drop +, spaces, punctuation). */
export function normalizeNumber(input: string): string {
  return (input || "").replace(/\D/g, "");
}

/** Extract the bare number from a chat JID ("27821234567@c.us" -> "27821234567"). */
export function jidToNumber(jid: string): string {
  const local = (jid || "").split("@")[0];
  return normalizeNumber(local);
}

/** True only for individual chats ("@c.us"); excludes groups ("@g.us"). */
function isIndividual(jid: string): boolean {
  return (jid || "").endsWith("@c.us") || !(jid || "").includes("@");
}

type WhitelistFile = { numbers: string[] };

/**
 * UI-editable allow-list of phone numbers, persisted to disk. Deny-by-default:
 * an empty list allows nobody (non-whitelisted senders are silently ignored).
 */
export class WhitelistStore {
  private file: string;
  private numbers: Set<string>;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "whatsapp-whitelist.json");
    const data = readJson<WhitelistFile>(this.file, { numbers: [] });
    this.numbers = new Set((data.numbers || []).map(normalizeNumber).filter(Boolean));
  }

  private persist(): void {
    try {
      writeJsonAtomic(this.file, { numbers: this.list() });
    } catch (err) {
      console.error("Failed to persist whitelist:", err);
    }
  }

  list(): string[] {
    return Array.from(this.numbers);
  }

  isAllowed(jid: string): boolean {
    if (!isIndividual(jid)) return false;
    const num = jidToNumber(jid);
    return !!num && this.numbers.has(num);
  }

  add(input: string): string[] {
    const num = normalizeNumber(input);
    if (num && !this.numbers.has(num)) {
      this.numbers.add(num);
      this.persist();
    }
    return this.list();
  }

  remove(input: string): string[] {
    const num = normalizeNumber(input);
    if (this.numbers.delete(num)) this.persist();
    return this.list();
  }

  /** Replace the whole list (used by the admin PUT endpoint). */
  replace(inputs: string[]): string[] {
    this.numbers = new Set((inputs || []).map(normalizeNumber).filter(Boolean));
    this.persist();
    return this.list();
  }
}
