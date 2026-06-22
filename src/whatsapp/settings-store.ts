import fs from "fs";
import path from "path";
import { readJson, writeJsonAtomic } from "./json-file";
import { SenderSettings } from "./types";

// Mirrors VALID_MODELS in app.ts. Kept local to avoid a circular import.
const VALID_MODELS = ["parakeet-v3", "tiny", "base", "small", "medium", "large-v3"];

const DEFAULTS: SenderSettings = { model: "small", language: "auto", diarizeEnabled: true };

/** WhatsApp transcription defaults, editable on the admin page, persisted to disk. */
export class SettingsStore {
  private file: string;
  private settings: SenderSettings;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "whatsapp-settings.json");
    this.settings = { ...DEFAULTS, ...readJson<Partial<SenderSettings>>(this.file, {}) };
    this.settings.model = this.cleanModel(this.settings.model);
  }

  private cleanModel(model: unknown): string {
    return typeof model === "string" && VALID_MODELS.includes(model) ? model : DEFAULTS.model;
  }

  private persist(): void {
    try {
      writeJsonAtomic(this.file, this.settings);
    } catch (err) {
      console.error("Failed to persist WhatsApp settings:", err);
    }
  }

  get(): SenderSettings {
    return { ...this.settings };
  }

  set(patch: Partial<SenderSettings>): SenderSettings {
    if (patch.model !== undefined) this.settings.model = this.cleanModel(patch.model);
    if (typeof patch.language === "string")
      this.settings.language = patch.language.trim() || "auto";
    if (typeof patch.diarizeEnabled === "boolean")
      this.settings.diarizeEnabled = patch.diarizeEnabled;
    this.persist();
    return this.get();
  }
}
