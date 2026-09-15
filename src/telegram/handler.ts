// Orchestration for the Telegram bot: whitelist gate → welcome → audio
// (queue → download → transcribe → text-or-PDF reply with buttons), inline
// button callbacks (retry / language / diarize / LLM), and slash commands.
// Talks to Telegram only through the injectable TelegramApi; transcription and
// attribution cores are injectable too, so the whole flow is testable offline.
import fs from "fs";
import { resolveEngine } from "../lib/engine";
import type { EngineResolution } from "../lib/engine";
import { VALID_MODELS } from "../lib/engine";
import { VALID_LANGUAGES } from "../lib/languages";
import { countWords } from "../lib/words";
import { runTranscription, TranscribeAbortError, TranscribeError } from "../lib/transcribe-core";
import type { TranscribeProgress, TranscribeResult } from "../lib/transcribe-core";
import { runAttribution } from "../lib/attribute-core";
import type { AttributeResult } from "../lib/attribute-core";
import type { AttrSegment } from "../lib/attribution";
import { ATTR_MODEL_OPTIONS } from "../lib/attribution";
import { SenderStatsStore } from "../lib/sender-stats-store";
import { SessionStore } from "../lib/session-store";
import { extractDiarize, splitNames } from "../whatsapp/command-parser";
import type { TelegramApi } from "./telegram-client";
import { TelegramFileTooBigError, TELEGRAM_MAX_DOWNLOAD_BYTES } from "./telegram-client";
import { TelegramWhitelistStore } from "./whitelist-store";
import { PrefsStore } from "./prefs-store";
import { SerialQueue } from "./queue";
import { decodeCallback } from "./callback-data";
import {
  diarizeMenu,
  languagePicker,
  llmPicker,
  modelPicker,
  shortLlmName,
  transcriptKeyboard,
} from "./keyboards";
import {
  attributedLines,
  attributedReply,
  escapeHtml,
  FILE_TOO_BIG,
  footer,
  HELP,
  NOT_AUTHORISED,
  pdfCaption,
  pdfFilename,
  progressText,
  transcriptReply,
  WELCOME,
} from "./format";
import { parseSlash } from "./commands";
import { parseUpdate, extForAudio } from "./update-parser";
import { buildTranscriptPdf } from "./pdf";
import type { PdfInput } from "./pdf";
import type {
  ChatState,
  InboundAudio,
  InboundCallback,
  InboundMessage,
  InlineKeyboardMarkup,
  TgUpdate,
  TranscriptState,
} from "./types";
import { transcriptKey } from "./types";

type TranscribeFn = (o: {
  model: string;
  filePath: string;
  language?: string;
  onProgress?: (e: TranscribeProgress) => void;
  signal?: AbortSignal;
}) => Promise<TranscribeResult>;

type AttributeFn = (o: {
  segments: AttrSegment[];
  speakers?: { name: string }[];
  model?: string;
}) => Promise<AttributeResult>;

export type HandlerDeps = {
  api: TelegramApi;
  whitelist: TelegramWhitelistStore;
  prefs: PrefsStore;
  senderStats: SenderStatsStore;
  transcripts: SessionStore<TranscriptState>;
  chats: SessionStore<ChatState>;
  queue: SerialQueue;
  /** Whether a server-side OpenRouter key exists (gates diarize). */
  hasOpenRouterKey: () => boolean;
  transcribe?: TranscribeFn;
  attribute?: AttributeFn;
  buildPdf?: (i: PdfInput) => Promise<Buffer>;
  /** Whisper model used when Parakeet can't handle a forced language. */
  fallbackModel?: string;
  /** Minimum gap between progress edits of the status message. */
  progressThrottleMs?: number;
  now?: () => number;
  log?: Pick<Console, "log" | "warn" | "error">;
};

export type Handler = {
  handleUpdate(u: TgUpdate): Promise<void>;
  handleMessage(m: InboundMessage): Promise<void>;
  handleCallback(c: InboundCallback): Promise<void>;
};

const DIARIZE_DISABLED = "Speaker labelling isn't enabled on this server.";
const NOTHING_TO_LABEL = "Nothing to label — retry the transcription first.";
const EXPIRED = "This transcript has expired — send the audio again.";
const NO_TRANSCRIPT = "Send me a voice note first, then tap Diarize (or use /diarize).";
const TYPING_INTERVAL_MS = 4000;

type JobParams = {
  chatId: number;
  userId: number;
  userMessageId: number;
  audio: InboundAudio;
  requestedModel: string;
  language: string;
  attrModel: string;
  displayName?: string;
  /** Caption text on the original audio message (may request diarize). */
  caption?: string;
};

export function createHandler(deps: HandlerDeps): Handler {
  const api = deps.api;
  const log = deps.log ?? console;
  const now = deps.now ?? (() => Date.now());
  const throttleMs = deps.progressThrottleMs ?? 2000;
  const fallbackModel = deps.fallbackModel || "small";
  const transcribe: TranscribeFn = deps.transcribe || ((o) => runTranscription(o));
  const attribute: AttributeFn =
    deps.attribute ||
    ((o) => runAttribution({ segments: o.segments, speakers: o.speakers, model: o.model }));
  const buildPdf = deps.buildPdf || ((i: PdfInput) => buildTranscriptPdf(i));

  const deniedNotified = new Set<number>();
  const recentMessages = new Set<string>();

  const diarizeAvailable = () => deps.prefs.getDefaults().diarizeEnabled && deps.hasOpenRouterKey();
  const rootKeyboard = (state?: Pick<TranscriptState, "failed">) =>
    transcriptKeyboard({ diarize: diarizeAvailable(), failed: state?.failed });
  const chatKey = (chatId: number) => String(chatId);
  const setChat = (chatId: number, patch: Partial<ChatState>) => {
    if (!deps.chats.update(chatKey(chatId), patch)) deps.chats.set(chatKey(chatId), { ...patch });
  };

  /** Whitelist gate. Returns false (after the one-time notice) when the sender is not allowed. */
  async function gate(
    msg: { chatId: number; userId: number; chatType?: string },
    notify: boolean,
  ): Promise<boolean> {
    if (msg.chatType && msg.chatType !== "private") return false;
    if (deps.whitelist.isAllowed(msg.userId)) return true;
    if (notify && !deniedNotified.has(msg.userId)) {
      if (deniedNotified.size > 1000) deniedNotified.clear();
      deniedNotified.add(msg.userId);
      await api.sendMessage({ chatId: msg.chatId, text: NOT_AUTHORISED(msg.userId) });
    }
    return false;
  }

  /** First contact → welcome. Returns true if the welcome was just sent. */
  async function greet(chatId: number, userId: number): Promise<boolean> {
    const key = String(userId);
    if (deps.senderStats.hasGreeted(key)) return false;
    deps.senderStats.markGreeted(key);
    await api.sendMessage({ chatId, text: WELCOME });
    return true;
  }

  function seenBefore(msg: InboundMessage): boolean {
    const k = `${msg.chatId}:${msg.messageId}`;
    if (recentMessages.has(k)) return true;
    if (recentMessages.size > 500) recentMessages.clear();
    recentMessages.add(k);
    return false;
  }

  // ---------------------------------------------------------------- delivery

  /** Edit the status message into the reply, or replace it with a PDF. Returns the final message id. */
  async function deliver(o: {
    chatId: number;
    statusId: number;
    replyTo: number;
    html: string;
    fitsText: boolean;
    pdf: () => PdfInput;
    pdfName: string;
    caption: string;
    keyboard: InlineKeyboardMarkup;
  }): Promise<number> {
    if (o.fitsText) {
      await api.editMessageText({
        chatId: o.chatId,
        messageId: o.statusId,
        text: o.html,
        replyMarkup: o.keyboard,
      });
      return o.statusId;
    }
    const buf = await buildPdf(o.pdf());
    await api.sendChatAction(o.chatId, "upload_document");
    await api.deleteMessage(o.chatId, o.statusId);
    const doc = await api.sendDocument({
      chatId: o.chatId,
      file: buf,
      filename: o.pdfName,
      mimeType: "application/pdf",
      caption: o.caption,
      replyTo: o.replyTo,
      replyMarkup: o.keyboard,
    });
    return doc.message_id;
  }

  // ------------------------------------------------------------ transcription

  async function runJob(p: JobParams): Promise<void> {
    const { chatId } = p;
    if (typeof p.audio.fileSize === "number" && p.audio.fileSize > TELEGRAM_MAX_DOWNLOAD_BYTES) {
      await api.sendMessage({
        chatId,
        text: FILE_TOO_BIG(p.audio.fileSize),
        replyTo: p.userMessageId,
      });
      return;
    }

    const ahead = deps.queue.pending() + (deps.queue.running() ? 1 : 0);
    const queued = ahead > 0;
    const status = await api.sendMessage({
      chatId,
      text: queued ? `⏳ Queued (${ahead} ahead)…` : "⬇️ Downloading…",
      replyTo: p.userMessageId,
    });
    const statusId = status.message_id;
    let lastText = "";
    let lastEditAt = 0;
    // All edits to the status message go through one chain so a slow progress
    // edit can never land after (and clobber) the final transcript edit.
    let editChain: Promise<void> = Promise.resolve();
    const edit = (text: string, force = false): Promise<void> => {
      if (text === lastText) return editChain;
      if (!force && now() - lastEditAt < throttleMs) return editChain;
      lastText = text;
      lastEditAt = now();
      editChain = editChain.then(() =>
        api.editMessageText({ chatId, messageId: statusId, text }).catch(() => {}),
      );
      return editChain;
    };

    await deps.queue.enqueue(
      async ({ signal }) => {
        let file: string | null = null;
        await api.sendChatAction(chatId, "typing");
        const heartbeat = setInterval(
          () => void api.sendChatAction(chatId, "typing"),
          TYPING_INTERVAL_MS,
        );
        heartbeat.unref?.();
        try {
          if (queued) await edit("⬇️ Downloading…", true);
          try {
            file = await api.downloadFile(p.audio.fileId, extForAudio(p.audio));
          } catch (err) {
            if (err instanceof TelegramFileTooBigError) {
              await edit(FILE_TOO_BIG(err.bytes), true);
              return;
            }
            throw err;
          }

          const resolution: EngineResolution = resolveEngine(
            p.requestedModel,
            p.language,
            fallbackModel,
          );
          const model = resolution.model;
          const fallbackNote = resolution.fallback
            ? `\nℹ️ ${escapeHtml(resolution.fallback.reason)} — using ${model}`
            : "";
          await edit(`🎙 Transcribing (${model})…${fallbackNote}`, true);

          const result = await transcribe({
            model,
            filePath: file,
            language: p.language,
            signal,
            onProgress: (ev) => {
              const t = progressText(ev, model);
              if (t) void edit(`${t}${fallbackNote}`);
            },
          });

          const state: TranscriptState = {
            chatId,
            userId: p.userId,
            userMessageId: p.userMessageId,
            audio: p.audio,
            requestedModel: p.requestedModel,
            model,
            language: p.language,
            detectedLanguage: result.language || "",
            duration: result.duration || 0,
            text: result.text || "",
            segments: result.segments || [],
            attrModel: p.attrModel,
            displayName: p.displayName,
          };
          const reply = transcriptReply(state, { fallback: resolution.fallback });
          const meta = {
            language: state.detectedLanguage,
            model,
            duration: state.duration,
            fallback: resolution.fallback,
          };
          await editChain; // let in-flight progress edits settle before the final edit
          const finalId = await deliver({
            chatId,
            statusId,
            replyTo: p.userMessageId,
            html: reply.html,
            fitsText: reply.fitsText,
            pdf: () => ({
              title: pdfFilename(state).replace(/\.pdf$/, ""),
              body: reply.plain,
              meta: {
                model,
                language: state.detectedLanguage,
                duration: state.duration,
                date: new Date(now()),
              },
            }),
            pdfName: pdfFilename(state),
            caption: pdfCaption(reply.plain, footer(meta)),
            keyboard: rootKeyboard(),
          });
          const key = transcriptKey(chatId, finalId);
          deps.transcripts.set(key, state);
          setChat(chatId, { lastTranscriptKey: key });
          deps.senderStats.record(
            String(p.userId),
            { ts: now(), durationSec: state.duration, words: countWords(state.text) },
            p.displayName,
          );

          const caption = extractDiarize(p.caption || "");
          if (caption.found && diarizeAvailable()) {
            await runDiarize(key, state, caption.names, finalId);
          }
        } catch (err) {
          log.error("[telegram] transcription failed:", err);
          let text: string;
          if (err instanceof TranscribeAbortError) {
            text = "⚠️ Server restarted mid-transcription — please resend the audio.";
          } else {
            const reason = err instanceof Error ? err.message : String(err);
            const hint =
              err instanceof TranscribeError && err.kind === "oom" ? " Try a smaller model." : "";
            text = `⚠️ Sorry, I couldn't transcribe that.${hint}\n<i>${escapeHtml(reason.slice(0, 300))}</i>`;
          }
          const failed: TranscriptState = {
            chatId,
            userId: p.userId,
            userMessageId: p.userMessageId,
            audio: p.audio,
            requestedModel: p.requestedModel,
            model: p.requestedModel,
            language: p.language,
            detectedLanguage: "",
            duration: 0,
            text: "",
            segments: [],
            attrModel: p.attrModel,
            displayName: p.displayName,
            failed: true,
          };
          deps.transcripts.set(transcriptKey(chatId, statusId), failed);
          await editChain;
          await api
            .editMessageText({
              chatId,
              messageId: statusId,
              text,
              replyMarkup: rootKeyboard(failed),
            })
            .catch(() => {});
        } finally {
          clearInterval(heartbeat);
          if (file) fs.unlink(file, () => {});
        }
      },
      () => {
        if (queued) void edit("⬇️ Downloading…", true);
      },
    );
  }

  // --------------------------------------------------------------- diarize

  async function runDiarize(
    sourceKey: string,
    state: TranscriptState,
    names: string[],
    replyTo: number,
  ): Promise<void> {
    const { chatId } = state;
    if (!diarizeAvailable()) {
      await api.sendMessage({ chatId, text: DIARIZE_DISABLED, replyTo });
      return;
    }
    if (state.failed) {
      await api.sendMessage({ chatId, text: NOTHING_TO_LABEL, replyTo });
      return;
    }
    const status = await api.sendMessage({
      chatId,
      text: `🗣 Labelling speakers with ${escapeHtml(shortLlmName(state.attrModel))}…`,
      replyTo,
    });
    try {
      await api.sendChatAction(chatId, "typing");
      const result = await attribute({
        segments: state.segments,
        speakers: names.map((name) => ({ name })),
        model: state.attrModel,
      });
      const meta = {
        language: state.detectedLanguage,
        model: state.model,
        duration: state.duration,
      };
      const reply = attributedReply(result, meta);
      const finalId = await deliver({
        chatId,
        statusId: status.message_id,
        replyTo,
        html: reply.html,
        fitsText: reply.fitsText,
        pdf: () => ({
          title: pdfFilename(state, { speakers: true }).replace(/\.pdf$/, ""),
          body: attributedLines(result),
          meta: {
            model: state.model,
            language: state.detectedLanguage,
            duration: state.duration,
            date: new Date(now()),
          },
        }),
        pdfName: pdfFilename(state, { speakers: true }),
        caption: pdfCaption(reply.plain, footer(meta)),
        keyboard: rootKeyboard(),
      });
      const key = transcriptKey(chatId, finalId);
      deps.transcripts.set(key, { ...state, diarized: true });
      setChat(chatId, { lastTranscriptKey: key });
    } catch (err) {
      log.error("[telegram] diarize failed:", err);
      const reason = err instanceof Error ? err.message : String(err);
      await api
        .editMessageText({
          chatId,
          messageId: status.message_id,
          text: `⚠️ Couldn't label the speakers: ${escapeHtml(reason.slice(0, 300))}`,
        })
        .catch(() => {});
    }
    void sourceKey;
  }

  // --------------------------------------------------------------- messages

  async function handleMessage(msg: InboundMessage): Promise<void> {
    if (!(await gate(msg, true))) return;
    if (seenBefore(msg)) return;
    const { chatId, userId } = msg;
    const justGreeted = await greet(chatId, userId);
    const displayName =
      `${msg.from.firstName}${msg.from.username ? ` (@${msg.from.username})` : ""}`.trim();
    const chat = deps.chats.get(chatKey(chatId));
    const pending = chat?.pending;
    const text = (msg.text || "").trim();
    const isSlash = text.startsWith("/");

    // Reply to the "Enter names" prompt.
    if (pending?.kind === "names" && !msg.audio && !isSlash) {
      deps.chats.update(chatKey(chatId), { pending: undefined });
      const state = deps.transcripts.get(pending.transcriptKey);
      if (!state) {
        await api.sendMessage({ chatId, text: EXPIRED });
        return;
      }
      const names = /^guess$/i.test(text) ? [] : splitNames(text);
      await runDiarize(pending.transcriptKey, state, names, msg.messageId);
      return;
    }
    if (pending) {
      deps.chats.update(chatKey(chatId), { pending: undefined });
      await api.deleteMessage(chatId, pending.promptMessageId);
    }

    if (msg.audio) {
      const prefs = deps.prefs.resolve(userId);
      await runJob({
        chatId,
        userId,
        userMessageId: msg.messageId,
        audio: msg.audio,
        requestedModel: prefs.model,
        language: prefs.language,
        attrModel: prefs.attrModel,
        displayName,
        caption: msg.text,
      });
      return;
    }

    const cmd = parseSlash(text);
    switch (cmd.kind) {
      case "start":
        if (!justGreeted) await api.sendMessage({ chatId, text: HELP });
        return;
      case "help":
        await api.sendMessage({ chatId, text: HELP });
        return;
      case "model": {
        const current = deps.prefs.resolve(userId).model;
        if (cmd.arg) {
          if (VALID_MODELS.includes(cmd.arg)) {
            deps.prefs.setUser(userId, { model: cmd.arg });
            await api.sendMessage({ chatId, text: `Default model: <b>${cmd.arg}</b> ✓` });
          } else {
            await api.sendMessage({
              chatId,
              text: `Unknown model "${escapeHtml(cmd.arg)}". Choose one of: ${VALID_MODELS.join(", ")}`,
            });
          }
          return;
        }
        await api.sendMessage({
          chatId,
          text: `Your default model: <b>${current}</b>\nPick a new default:`,
          replyMarkup: modelPicker(current, "pref"),
        });
        return;
      }
      case "language": {
        const current = deps.prefs.resolve(userId).language;
        if (cmd.arg) {
          if (VALID_LANGUAGES.has(cmd.arg)) {
            deps.prefs.setUser(userId, { language: cmd.arg });
            await api.sendMessage({ chatId, text: `Default language: <b>${cmd.arg}</b> ✓` });
          } else {
            await api.sendMessage({
              chatId,
              text: `Unknown language code "${escapeHtml(cmd.arg)}". Use an ISO 639-1 code like en, de, fr — or auto.`,
            });
          }
          return;
        }
        await api.sendMessage({
          chatId,
          text: `Your default language: <b>${current}</b>\nPick a new default:`,
          replyMarkup: languagePicker(current, "pref"),
        });
        return;
      }
      case "diarize": {
        if (!diarizeAvailable()) {
          await api.sendMessage({ chatId, text: DIARIZE_DISABLED });
          return;
        }
        const key = deps.chats.get(chatKey(chatId))?.lastTranscriptKey;
        const state = key ? deps.transcripts.get(key) : undefined;
        if (!key || !state) {
          await api.sendMessage({ chatId, text: NO_TRANSCRIPT });
          return;
        }
        await runDiarize(key, state, cmd.names, msg.messageId);
        return;
      }
      default:
        if (!justGreeted) await api.sendMessage({ chatId, text: HELP });
    }
  }

  // -------------------------------------------------------------- callbacks

  async function handleCallback(cb: InboundCallback): Promise<void> {
    const answer = (text?: string, showAlert?: boolean) =>
      api.answerCallbackQuery({ id: cb.id, text, showAlert });
    if (!(await gate(cb, false))) {
      await answer();
      return;
    }
    const action = decodeCallback(cb.data);
    if (!action) {
      await answer("Unknown action");
      return;
    }
    const { chatId, userId, messageId } = cb;
    const setMarkup = (replyMarkup: InlineKeyboardMarkup | null) =>
      api.editMessageReplyMarkup({ chatId, messageId, replyMarkup });

    if (action.kind === "noop") {
      await answer();
      await setMarkup(null);
      return;
    }
    if (action.kind === "pref") {
      deps.prefs.setUser(userId, { [action.field]: action.value });
      const label = action.field === "model" ? "Default model" : "Default language";
      await answer(`${label}: ${action.value}`);
      await api
        .editMessageText({ chatId, messageId, text: `${label}: <b>${action.value}</b> ✓` })
        .catch(() => {});
      return;
    }

    const key = transcriptKey(chatId, messageId);
    const state = deps.transcripts.get(key);
    if (!state) {
      await answer(EXPIRED, true);
      await setMarkup(null);
      return;
    }

    switch (action.kind) {
      case "menu":
        switch (action.menu) {
          case "root":
            await answer();
            await setMarkup(rootKeyboard(state));
            return;
          case "retry":
            await answer();
            await setMarkup(modelPicker(state.model, "retry"));
            return;
          case "lang":
            await answer();
            await setMarkup(languagePicker(state.language, "lang"));
            return;
          case "diar":
            if (!diarizeAvailable()) return void (await answer(DIARIZE_DISABLED, true));
            if (state.failed) return void (await answer(NOTHING_TO_LABEL, true));
            await answer();
            await setMarkup(diarizeMenu(state.attrModel));
            return;
          case "llm":
            await answer();
            await setMarkup(llmPicker(state.attrModel));
            return;
        }
        return;
      case "llm": {
        const model = ATTR_MODEL_OPTIONS[action.index];
        deps.transcripts.update(key, { attrModel: model });
        await answer(`LLM: ${shortLlmName(model)}`);
        await setMarkup(diarizeMenu(model));
        return;
      }
      case "retry":
        await answer(`Re-transcribing with ${action.model}…`);
        await setMarkup(rootKeyboard(state));
        await runJob({
          chatId,
          userId,
          userMessageId: state.userMessageId,
          audio: state.audio,
          requestedModel: action.model,
          language: state.language,
          attrModel: state.attrModel,
          displayName: state.displayName,
        });
        return;
      case "lang":
        await answer(`Re-transcribing in ${action.language}…`);
        await setMarkup(rootKeyboard(state));
        await runJob({
          chatId,
          userId,
          userMessageId: state.userMessageId,
          audio: state.audio,
          requestedModel: state.requestedModel,
          language: action.language,
          attrModel: state.attrModel,
          displayName: state.displayName,
        });
        return;
      case "diar":
        if (!diarizeAvailable()) return void (await answer(DIARIZE_DISABLED, true));
        if (state.failed) return void (await answer(NOTHING_TO_LABEL, true));
        if (action.mode === "guess") {
          await answer("Labelling speakers…");
          await setMarkup(rootKeyboard(state));
          await runDiarize(key, state, [], messageId);
          return;
        }
        await answer();
        await setMarkup(rootKeyboard(state));
        {
          const prompt = await api.sendMessage({
            chatId,
            text: "Reply with the speaker names, comma-separated (e.g. <i>Alice, Bob</i>) — or <i>guess</i>.",
            replyTo: messageId,
            replyMarkup: { force_reply: true, input_field_placeholder: "Alice, Bob" },
          });
          const pending = {
            kind: "names" as const,
            transcriptKey: key,
            promptMessageId: prompt.message_id,
          };
          setChat(chatId, { pending });
        }
        return;
    }
  }

  async function handleUpdate(u: TgUpdate): Promise<void> {
    const parsed = parseUpdate(u);
    if (!parsed) return;
    if (parsed.kind === "message") await handleMessage(parsed.msg);
    else await handleCallback(parsed.cb);
  }

  return { handleUpdate, handleMessage, handleCallback };
}
