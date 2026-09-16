import fs from "fs";
import { resolveEngine } from "../lib/engine";
import { countWords } from "../lib/words";
import { runTranscription, TranscribeResult } from "../lib/transcribe-core";
import { runAttribution, AttributeResult } from "../lib/attribute-core";
import { AttrSegment } from "../lib/attribution";
import { WahaApi } from "./waha-client";
import { WhitelistStore } from "./whitelist-store";
import { SettingsStore } from "./settings-store";
import { SenderStatsStore } from "./sender-stats-store";
import { SessionStore } from "../lib/session-store";
import { extractDiarize, parseCommand } from "./command-parser";
import { FlowState, InboundMessage } from "./types";

type TranscribeFn = (opts: {
  model: string;
  filePath: string;
  language?: string;
}) => Promise<TranscribeResult>;

type AttributeFn = (opts: {
  segments: AttrSegment[];
  speakers?: { name: string }[];
}) => Promise<AttributeResult>;

export type HandlerDeps = {
  waha: WahaApi;
  whitelist: WhitelistStore;
  settings: SettingsStore;
  senderStats: SenderStatsStore;
  sessions: SessionStore<FlowState>;
  /** Whether server-side OpenRouter key exists (gates the diarize feature). */
  hasOpenRouterKey: () => boolean;
  /** Injectable for tests; defaults to the real transcription core. */
  transcribe?: TranscribeFn;
  /** Injectable for tests; defaults to the real attribution core. */
  attribute?: AttributeFn;
  /** Whisper model used when Parakeet can't handle a forced language. */
  fallbackModel?: string;
};

const HELP = [
  "🎙️ *Whisper It* — send me a voice note (or forward one) and I'll transcribe it.",
  "",
  "• Just send audio — I reply with the text.",
  "• Want speakers labelled? Reply *diarize* after a transcript,",
  "  or send the audio with a caption like *diarize Alice, Bob*.",
  "• Send *help* any time to see this again.",
].join("\n");

const WELCOME = `👋 *Welcome!*\n\n${HELP}`;

function fmtDuration(sec: number): string {
  const s = Math.round(sec || 0);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function transcriptReply(result: TranscribeResult, model: string, offerDiarize: boolean): string {
  const text = (result.text || "").trim() || "(no speech detected)";
  const meta = [result.language ? result.language : null, model, fmtDuration(result.duration)]
    .filter(Boolean)
    .join(" · ");
  let out = `${text}\n\n_${meta}_`;
  if (offerDiarize) {
    out += "\n🗣 Reply *diarize* to label speakers — or *diarize Alice, Bob*";
  }
  return out;
}

function attributedReply(result: AttributeResult): string {
  const lines: string[] = [];
  let lastSpeaker: string | null = null;
  result.merged.forEach((seg: any, i: number) => {
    const amb = result.ambiguous.includes(i) ? " ⚠️" : "";
    const text = (seg.text || "").trim();
    if (seg.speaker === lastSpeaker && !amb) {
      lines[lines.length - 1] += ` ${text}`;
    } else {
      lines.push(`*${seg.speaker}*${amb}: ${text}`);
      lastSpeaker = amb ? null : seg.speaker;
    }
  });
  let out = lines.join("\n");
  if (result.notes) out += `\n\n_${result.notes}_`;
  return out;
}

/**
 * Build the inbound-message orchestrator. Returns an async fn the webhook calls
 * per message. Whitelist → welcome → transcribe / diarize / help, all driven by
 * the injectable cores. Never throws to the caller (errors become chat replies).
 */
export function createHandler(deps: HandlerDeps): (msg: InboundMessage) => Promise<void> {
  const transcribe = deps.transcribe || ((opts) => runTranscription(opts));
  const attribute =
    deps.attribute ||
    ((opts) => runAttribution({ segments: opts.segments, speakers: opts.speakers }));
  const fallbackModel = deps.fallbackModel || "small";

  const diarizeAvailable = () => deps.settings.get().diarizeEnabled && deps.hasOpenRouterKey();

  const runDiarize = async (
    chatId: string,
    segments: AttrSegment[],
    names: string[],
    replyTo?: string,
  ) => {
    const speakers = names.map((name) => ({ name }));
    const result = await attribute({ segments, speakers });
    await deps.waha.sendText(chatId, attributedReply(result), replyTo);
  };

  return async function handle(msg: InboundMessage): Promise<void> {
    const { chatId } = msg;
    if (!deps.whitelist.isAllowed(chatId)) return; // silently ignore

    const justGreeted = !deps.senderStats.hasGreeted(chatId);
    if (justGreeted) {
      deps.senderStats.markGreeted(chatId);
      await deps.waha.sendText(chatId, WELCOME);
    }

    if (msg.hasAudio && msg.mediaUrl) {
      let file: string | null = null;
      try {
        await deps.waha.sendSeen(chatId);
        await deps.waha.startTyping(chatId);
        file = await deps.waha.downloadMedia(msg.mediaUrl, msg.mimetype);
        const { model, language } = deps.settings.get();
        const resolution = resolveEngine(model, language, fallbackModel);
        const result = await transcribe({ model: resolution.model, filePath: file, language });

        deps.sessions.set(chatId, { segments: result.segments, model: resolution.model });
        deps.senderStats.record(chatId, {
          ts: Date.now(),
          durationSec: result.duration || 0,
          words: countWords(result.text || ""),
        });

        const caption = extractDiarize(msg.body || "");
        if (caption.found && diarizeAvailable()) {
          await runDiarize(chatId, result.segments, caption.names, msg.messageId);
        } else {
          await deps.waha.sendText(
            chatId,
            transcriptReply(result, resolution.model, diarizeAvailable()),
            msg.messageId,
          );
        }
      } catch (err) {
        console.error("[whatsapp] transcription failed:", err);
        await deps.waha.sendText(
          chatId,
          "⚠️ Sorry, I couldn't transcribe that. Please try again.",
          msg.messageId,
        );
      } finally {
        await deps.waha.stopTyping(chatId).catch(() => {});
        if (file) fs.unlink(file, () => {});
      }
      return;
    }

    // Text-only message: command handling.
    const cmd = parseCommand(msg.body || "");

    if (cmd.kind === "diarize") {
      if (!diarizeAvailable()) {
        await deps.waha.sendText(chatId, "Speaker labelling isn't enabled on this server.");
        return;
      }
      const flow = deps.sessions.get(chatId);
      if (!flow) {
        await deps.waha.sendText(
          chatId,
          "Send me a voice note first, then reply *diarize* to label the speakers.",
        );
        return;
      }
      try {
        await runDiarize(chatId, flow.segments, cmd.names);
      } catch (err) {
        console.error("[whatsapp] diarize failed:", err);
        await deps.waha.sendText(chatId, "⚠️ Couldn't label the speakers. Please try again.");
      }
      return;
    }

    if (cmd.kind === "help") {
      if (!justGreeted) await deps.waha.sendText(chatId, HELP);
      return;
    }

    // Unknown text — nudge with help (unless we just sent the welcome).
    if (!justGreeted) await deps.waha.sendText(chatId, HELP);
  };
}
