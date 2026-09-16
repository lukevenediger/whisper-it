// Pure parsing of Telegram slash commands. No I/O.
import { splitNames } from "../whatsapp/command-parser";

export type SlashCommand =
  | { kind: "start" }
  | { kind: "help" }
  | { kind: "model"; arg?: string }
  | { kind: "language"; arg?: string }
  | { kind: "diarize"; names: string[] }
  | { kind: "unknown"; name: string }
  | { kind: "none" };

export const BOT_COMMANDS: { command: string; description: string }[] = [
  { command: "start", description: "Welcome + how to use the bot" },
  { command: "help", description: "Show the help text" },
  { command: "model", description: "Pick your default transcription model" },
  { command: "language", description: "Pick your default language (or auto)" },
  { command: "diarize", description: "Label speakers on your last transcript" },
];

export function parseSlash(text: string): SlashCommand {
  const m = (text || "").trim().match(/^\/([a-z0-9_]+)(?:@\S+)?(?:\s+([\s\S]*))?$/i);
  if (!m) return { kind: "none" };
  const name = m[1].toLowerCase();
  const rest = (m[2] || "").trim();
  switch (name) {
    case "start":
      return { kind: "start" };
    case "help":
      return { kind: "help" };
    case "model":
      return rest ? { kind: "model", arg: rest.toLowerCase() } : { kind: "model" };
    case "language":
    case "lang":
      return rest ? { kind: "language", arg: rest.toLowerCase() } : { kind: "language" };
    case "diarize":
    case "diarise":
      return { kind: "diarize", names: splitNames(rest) };
    default:
      return { kind: "unknown", name };
  }
}
