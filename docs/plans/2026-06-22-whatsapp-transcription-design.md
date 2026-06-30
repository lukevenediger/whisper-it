# WhatsApp transcription via WAHA — design

_Shipped on branch `whatsapp-transcription` (PR #5). This doc records the design and rationale; CLAUDE.md and README hold the living reference + setup._

## Context

Whisper It transcribes audio in a browser. This adds a second front door: a WhatsApp
number people send (or forward) voice notes to, and the bot replies with the
transcription — reusing the full pipeline (model routing, long-audio chunking,
Parakeet/Whisper fallback) and the existing cloud speaker-attribution feature for
on-demand diarization.

The WhatsApp link is [WAHA](https://waha.devlike.pro) (WhatsApp HTTP API), run as a
second container in `docker-compose.yml`. WAHA Core (free) covers everything needed:
receive the `message` webhook with a voice note, download media, send replies, expose
QR + session status.

## Decisions

- **Bot logic in-process, not a separate service.** Lives in `src/whatsapp/`, mounted
  into the existing Express app via `mountWhatsApp(app, {dataDir})`. Reuses the
  transcription/attribution pipeline directly. WAHA is the only extra container.
- **Reusable cores (load-bearing refactor).** Transcription + attribution orchestration
  were extracted from the Express SSE route closures into `src/lib/transcribe-core.ts`
  (`runTranscription`) and `src/lib/attribute-core.ts` (`runAttribution`). Browser SSE
  routes forward an `onProgress` callback; the WhatsApp handler `await`s the promise.
  The SSE wire contract is preserved byte-for-byte (guarded by the integration tests).
- **WAHA NOWEB engine.** No headless Chromium → ~300 MB vs ~1–2 GB (WEBJS). Session
  persisted to the `waha-sessions` volume so the QR isn't re-scanned on restart.
- **WAHA port not published.** Only the app talks to WAHA; the admin page proxies
  QR/status so the WAHA API key never reaches the browser.
- **Whitelist deny-by-default.** UI-editable, persisted to `/data`. Non-whitelisted (and
  group) senders are silently ignored — no reply reveals the bot.
- **Defaults, no per-message overrides.** WhatsApp transcriptions use a configurable
  default model/language (whisper `small` / auto). Keeps the chat interface simple.
- **`diarize` = attribution with an optional roster.** `diarize`/`diarise` alone → model
  guesses `Speaker 1/2`; `diarize Alice, Bob` → those names are the roster. Triggered
  three ways (all share the stored-transcript mechanism): a reply after a transcript, the
  keyword in the voice note's caption, or `help`. Offered only when `OPENROUTER_API_KEY`
  is set. A first-ever sender gets a welcome/help message.

## Architecture

```
WhatsApp ⇄ WAHA container ──webhook(POST /api/whatsapp/webhook)──▶ whisper-it
                  ▲                                                     │
                  └──────── sendText / media download / QR / status ◀──┘
```

`src/whatsapp/` (each file single-purpose):

- `index.ts` — `mountWhatsApp`: builds stores + WAHA client + handler, mounts the webhook
  and admin routers, ensures the session starts. `isWhatsAppConfigured()` gates the feature.
- `webhook.ts` — `POST /webhook`: HMAC verify → ack 200 → async process (dedupes WAHA
  retries). `parseWahaEvent` (pure) maps the payload → `InboundMessage`.
- `admin.ts` — proxy + config router: status / qr / session control / whitelist / settings
  / stats. Keeps the WAHA key server-side.
- `handler.ts` — orchestration: whitelist → welcome → transcribe / diarize / help.
  Consumes the cores non-SSE.
- `waha-client.ts` — `WAHAClient`: downloadMedia / sendText / seen+typing / status / qr /
  restart / logout. Only module that knows the WAHA wire format.
- `command-parser.ts` — `parseCommand` (reply: diarize/diarise/help) + `extractDiarize`
  (caption keyword + names).
- `whitelist-store.ts` / `settings-store.ts` / `sender-stats-store.ts` — atomic JSON stores
  under `/data` (mirror `src/stats.ts`). `json-file.ts` is the shared atomic-write helper.
- `session-state.ts` — in-memory TTL map (chatId → last transcript) for the interactive
  diarize flow. Not persisted.

Admin page: `src/public/whatsapp.html` (QR + status, whitelist editor, defaults, usage).
Footer/nav link gated on the `hasWhatsApp` flag in `/api/version`.

## Security (hardened in this PR, not deferred)

- **SSRF / credential leak in media download.** `downloadMedia` keeps only the path of the
  webhook-supplied `media.url`, forces the configured `WAHA_BASE_URL` origin, and uses
  `redirect: "manual"` — so the `X-Api-Key` is never sent to an attacker-influenced host,
  even via a 30x. Also fixes WAHA emitting `localhost`-based file URLs unreachable from the
  container.
- **Webhook HMAC verification.** When `WHATSAPP_WEBHOOK_SECRET` is set, the webhook requires
  a valid `X-Webhook-Hmac` (HMAC-SHA512 of the raw body, hex, constant-time compared) and
  returns `401` before the handler runs. Compose wires the same value to WAHA's
  `WHATSAPP_HOOK_HMAC_KEY`. Raw body captured via the `express.json` `verify` hook. Pinned
  to WAHA's reference test vector in a unit test.

Deferred to a follow-up: prompt-injection hardening, per-sender rate limits.

## Persistence / migration

Docker volumes and `.env` do not move with the git repo:

- `waha-sessions` — the WhatsApp pairing. Lost on machine move → re-scan the QR.
- `whisper-data` — `whatsapp-whitelist.json`, `whatsapp-settings.json`, `whatsapp-stats.json`.
  Lost on machine move → re-add the whitelist.
- `.env` — secrets. Recreate from `.env.example`.

See README → _WhatsApp Transcription → Moving to another machine_ for the steps (and the
optional `docker run … tar` volume-copy recipe if you want to migrate state instead of
re-pairing).

## Env vars

| Var                       | Default            | Notes                                                                             |
| ------------------------- | ------------------ | --------------------------------------------------------------------------------- |
| `WAHA_BASE_URL`           | `http://waha:3000` | Unset to disable the feature.                                                     |
| `WAHA_API_KEY`            | _(unset)_          | `X-Api-Key` to WAHA; must match the `waha` service.                               |
| `WAHA_SESSION`            | `default`          | One WhatsApp number per session.                                                  |
| `WHATSAPP_WEBHOOK_SECRET` | _(unset)_          | Enables HMAC verification; compose mirrors it to WAHA's `WHATSAPP_HOOK_HMAC_KEY`. |

## Build sequence (as executed)

1. Refactor → `transcribe-core` + `attribute-core`, rewrite both SSE routes, tests green.
2. `src/whatsapp/` stores + parser (TDD) → waha-client → handler → webhook + admin routers
   → `mountWhatsApp` wired into `app.ts`.
3. Admin page + `hasWhatsApp` version flag + footer link.
4. docker-compose `waha` service + `.env.example` + docs.
5. Security: media-download origin-pin + redirect guard; webhook HMAC verification.

## Verification

- Automated: `npm run test:unit` + `npm run test:integration` (unit parser/stores/session/
  cores/HMAC; integration handler flow + webhook ack/dedupe/HMAC-401 + WAHA-client SSRF/
  redirect guards). Lint + typecheck clean.
- Manual (pending a second SIM): `make run` → `/whatsapp.html` → scan QR → status `WORKING`
  → send a voice note from a whitelisted number → transcript → reply `diarize` → labelled
  version → confirm the sender appears in the usage table; verify a non-whitelisted number
  gets no reply.
