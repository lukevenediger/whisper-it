# Telegram transcription via the Bot API — design

_Built on branch `telegram-transcription`. This doc records the design and rationale; CLAUDE.md and README hold the living reference + setup._

## Context

Whisper It already has two front doors: the browser UI and a WhatsApp bot (via WAHA).
This adds a third — a Telegram bot — with one extra requirement the WhatsApp bot doesn't
have: the web UI's features (retry with another model, force a language, speaker
attribution) must be reachable from Telegram controls, not just the plain "send audio,
get text" loop. Short transcripts come back as a message; long ones as a PDF.

Telegram is a better fit for this than WhatsApp: the Bot API is first-party, free,
needs no gateway container, supports inline keyboards and callback queries natively,
and can be consumed by **long polling** — so the deployment stays VPN-only with no
public URL, matching the project's "never expose directly" rule.

## Decisions

- **Long polling, not webhooks.** `getUpdates` with a 30 s timeout from inside the
  container. No inbound port, no TLS cert, no tunnel. Cost: exactly one instance may poll
  a token (Telegram returns `409 Conflict` otherwise) — surfaced in the log and on the
  admin page rather than hidden.
- **Hand-rolled client over `fetch`, no grammY/telegraf.** Same style as
  `waha-client.ts`; ~250 lines cover the dozen methods needed, and msw can test it
  offline. A framework would be a second way of doing bots in the repo and harder to
  assert against.
- **Sibling module, not a provider-neutral bot core.** `src/telegram/` mirrors
  `src/whatsapp/` in layout, but the UX (inline keyboards, callback queries, status
  edits, PDF delivery, per-user prefs) diverges enough that a shared handler would be
  a leaky abstraction. Only the genuinely generic pieces moved to `src/lib/`:
  `json-file`, a generic `SessionStore<T>`, and `SenderStatsStore` with
  `{filename, normalizeKey}` options. Neither bot imports the other.
- **Retry re-downloads by `file_id`; the server keeps no audio.** The web UI's
  re-transcribe re-uploads from browser memory, and the server unlinks uploads as soon
  as a request ends. Telegram keeps user-sent files, so `TranscriptState` stores the
  `file_id` and `getFile` is called again on Retry/Language. The state behind the
  buttons lives in an in-memory `SessionStore` keyed by `chatId:botMessageId` for 6 h
  (500 entries max); after that the buttons answer "expired — send the audio again".
- **Inline buttons + slash commands.** Every transcript carries
  `[Retry][Diarize][Language]`. Retry/Language open pickers and re-run into a **new**
  message (the original is never overwritten — same rule as the web history's sibling
  entries). Diarize opens `[Guess speakers][Enter names] [LLM ▸] [Back]`; "Enter names"
  uses a `force_reply` prompt and per-chat pending state. `/model` and `/language`
  set per-user defaults (persisted); `/diarize` acts on the last transcript.
- **`callback_data` is a ≤64-byte versioned string** (`t1:retry:medium`,
  `t1:lang:de`, `t1:diar:names`, `t1:llm:2`, `t1:pref:model:tiny`). No ids are embedded —
  the message identity comes from `callback_query.message`. Decode validates against
  `VALID_MODELS` / `VALID_LANGUAGES` / `ATTR_MODEL_OPTIONS`, so stale or forged data is
  ignored.
- **Menu transitions use `editMessageReplyMarkup` only.** PDF-delivered transcripts
  have no editable text, so keyboards are swapped independently of the message body.
- **Text vs PDF cut-off = rendered HTML length > 3000** (`TELEGRAM_TEXT_LIMIT`, hard cap
  4096). Anything that fits in one message is text; longer goes as a pdfkit PDF with a
  ≤1024-char caption preview. Audio-duration-based cut-offs were rejected (a silence-heavy
  10-minute clip is still a short transcript). pdfkit's built-in Helvetica is WinAnsi-only,
  so the image installs `fonts-dejavu-core` (Latin/Cyrillic/Greek); CJK/Arabic PDFs remain
  a documented limit, overridable via `TELEGRAM_PDF_FONT`.
- **Whitelist by numeric user id, deny-by-default, private chats only.** Usernames are
  optional and re-assignable. A non-whitelisted user gets exactly one reply — "Not
  authorised. Your Telegram ID is N" — so they can hand the id to the admin, then
  silence (per-process set). Callbacks from them are just acknowledged.
- **Serial transcription queue.** One `transcribe.py` at a time inside the 8 GB
  container; a second sender sees "Queued (1 ahead)". Attribution (an LLM call) is not
  queued.
- **Polling starts in `server.ts`, never at `app.ts` import.** The integration tests
  import `app`; `mountTelegram` wires routers and stores but returns `{start, stop}` for
  the entrypoint to call after `listen()`. `SIGTERM`/`SIGINT` stop polling and abort
  in-flight jobs.

## Architecture

```
Telegram ──getUpdates (long poll)──▶ poller.ts ──▶ update-parser ──▶ handler.ts ──▶ queue ──▶ runTranscription / runAttribution
   ▲                                                                       │
   └── sendMessage / editMessageText / editMessageReplyMarkup / sendDocument ◀┘  (telegram-client.ts)
                                                                           │
                /api/telegram/* admin router ◀── telegram.html (bot status, whitelist, defaults, usage)
```

`src/telegram/`, each file single-purpose:

- `index.ts` — `mountTelegram(app, {dataDir, fallbackModel}) → {start, stop} | null`; `isTelegramConfigured()`.
- `telegram-client.ts` — `TelegramApi` interface + `TelegramClient` (fetch, multipart `sendDocument`, `downloadFile` with the 20 MB guard and `redirect:"manual"`, 429 retry, best-effort methods that never throw).
- `poller.ts` — `getUpdates` loop with offset tracking and backoff (409 → 5 s, 429 → `retry_after`, else 1 → 30 s exponential); abortable `stop()`.
- `update-parser.ts` — raw `Update` → `InboundMessage` / `InboundCallback`; audio extraction for voice, audio, audio-like documents and video notes.
- `handler.ts` — gate → welcome → audio job (status message edited through progress) → deliver (text or PDF) → state; callbacks; slash commands.
- `callback-data.ts`, `keyboards.ts`, `format.ts`, `commands.ts` — pure helpers (encoding, keyboard builders, HTML formatting + cut-off, slash parsing).
- `pdf.ts` — pdfkit rendering with font resolution.
- `queue.ts` — serial job queue.
- `whitelist-store.ts`, `prefs-store.ts` — JSON-file stores under `/data`.
- `admin.ts` — `/api/telegram` router (status, whitelist, settings, users, stats).

`src/public/telegram.html` is the admin page; `/api/version` gains `hasTelegram`, which gates the nav link.

## Security

- **Token handling** — only ever appears in URLs to the configured API host; file
  downloads use `redirect:"manual"` so a 30x can't carry it elsewhere; error messages
  carry the API `description`, never the URL.
- **Whitelist** — deny-by-default on `from.id`; non-private chats dropped before any
  reply; callbacks from unknown users only acknowledged.
- **Callback data** — versioned and validated on decode; unknown/garbled data is
  answered and ignored.
- **HTML mode** — every user- or model-derived string passes through `escapeHtml`.
- Deferred, as for WhatsApp: prompt-injection hardening for the attribution prompt and
  per-user rate limits. No auth on `/telegram.html` — VPN-fronted like the rest.

## Persistence / migration

- `.env` — `TELEGRAM_BOT_TOKEN` (git-ignored).
- `whisper-data` volume — `/data/telegram-whitelist.json`, `/data/telegram-prefs.json`, `/data/telegram-stats.json`.
- In-memory only — transcript state behind the buttons (6 h), per-chat pending state, denied-user notice set.
- Moving machines needs no re-pairing: copy the token, `make run`, re-add the whitelist (or copy the volume).

## Env vars

| Var                   | Default                                           | Notes                                                         |
| --------------------- | ------------------------------------------------- | ------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`  | _(unset)_                                         | Feature switch. Never logged.                                 |
| `TELEGRAM_TEXT_LIMIT` | `3000`                                            | Rendered length above which replies go out as a PDF.          |
| `TELEGRAM_PDF_FONT`   | `/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf` | TTF for PDFs; Helvetica fallback (Latin-only) with a warning. |

## Build sequence (as executed)

1. Shared refactor: `json-file`, generic `SessionStore<T>`, parameterised `SenderStatsStore`, exported `VALID_MODELS` / `VALID_LANGUAGES` / `splitNames`.
2. Pure modules + unit tests: types, update parser, callback data, keyboards, format, commands.
3. Stores + queue: whitelist, prefs, serial queue.
4. PDF rendering (pdfkit + DejaVu in the image).
5. Bot API client (msw-tested), then the poller.
6. Handler + offline integration test (fake `TelegramApi`, stubbed cores).
7. Mount, admin router, `server.ts` start/stop, `hasTelegram`.
8. Admin page + nav link; compose/env; docs.

## Verification

- **Automated:** `npm run test:unit` (`tg-*`), `npm run test:integration` (`tg-client` via msw, `tg-handler` end-to-end flows offline, `tg-admin-route`, `tg-mount` asserting no network on import, `api-version` shape); WhatsApp suites unchanged after the refactor.
- **Manual:** `make run` with a real token → whitelist flow → voice note → Retry/Language/Diarize → long fixture → PDF → queue message → admin page → restart mid-poll.
