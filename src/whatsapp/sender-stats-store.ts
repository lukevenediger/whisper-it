import { SenderStatsStore as SharedSenderStatsStore } from "../lib/sender-stats-store";
import { jidToNumber } from "./whitelist-store";

export type { SenderRecord, SenderStats, SenderEvent } from "../lib/sender-stats-store";

/** WhatsApp flavour of the shared store: keyed by phone number, own JSON file. */
export class SenderStatsStore extends SharedSenderStatsStore {
  constructor(dataDir: string) {
    super(dataDir, {
      filename: "whatsapp-stats.json",
      normalizeKey: jidToNumber,
      label: "WhatsApp",
    });
  }
}
