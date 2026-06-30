import {
  AttrSegment,
  AttrSpeaker,
  AttrResult,
  ATTR_MAX_SEGMENTS,
  ATTR_DEFAULT_MODEL,
  buildAttributionPrompt,
  applyAssignments,
  countAssignedKeys,
} from "./attribution";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_REFERER = "https://github.com/lukevenediger/whisper-it";

export type AttributeProgress =
  | { status: "attributing"; model: string; rosterSize: number; segmentCount: number }
  | { status: "progress"; done: number; total: number; elapsedMs: number };

/** Carries the effective model alongside the assignment result. */
export type AttributeResult = AttrResult & { model: string };

export class AttributeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttributeError";
  }
}

export type AttributeOptions = {
  segments?: AttrSegment[];
  /** Empty/undefined => the model guesses speaker count and uses Speaker 1/2/... */
  speakers?: AttrSpeaker[];
  /** Defaults to ATTR_DEFAULT_MODEL. */
  model?: string;
  /** Defaults to process.env.OPENROUTER_API_KEY, READ AT CALL TIME. */
  apiKey?: string;
  /** HTTP-Referer header value. */
  referer?: string;
  /** Streamed progress (attributing + progress). Optional for non-UI callers. */
  onProgress?: (event: AttributeProgress) => void;
};

/**
 * Run speaker attribution against OpenRouter and resolve with the merged result.
 * Validation, key check, prompt build, streaming/non-streaming consumption and
 * applyAssignments are lifted verbatim from the original /api/attribute route so
 * the SSE wire contract is preserved when the route forwards `onProgress`.
 */
export async function runAttribution(opts: AttributeOptions): Promise<AttributeResult> {
  const segments = Array.isArray(opts?.segments) ? opts.segments : null;
  if (!segments || segments.length === 0) throw new AttributeError("segments array required");
  if (segments.length > ATTR_MAX_SEGMENTS)
    throw new AttributeError(`Too many segments (${segments.length}). Max ${ATTR_MAX_SEGMENTS}.`);
  for (const s of segments) {
    if (typeof s.start !== "number" || typeof s.end !== "number" || typeof s.text !== "string") {
      throw new AttributeError("Each segment needs {start, end, text}");
    }
  }

  const speakers = Array.isArray(opts.speakers)
    ? opts.speakers
        .filter((s) => s && typeof s.name === "string" && s.name.trim())
        .map((s) => ({
          name: s.name.trim().slice(0, 80),
          description: typeof s.description === "string" ? s.description.trim().slice(0, 400) : "",
        }))
    : [];

  const model =
    typeof opts.model === "string" && opts.model.trim() ? opts.model.trim() : ATTR_DEFAULT_MODEL;
  const apiKey = (opts.apiKey ?? process.env.OPENROUTER_API_KEY ?? "").trim();
  if (!apiKey)
    throw new AttributeError(
      "Speaker attribution is unavailable — server has no OPENROUTER_API_KEY configured.",
    );

  const referer = opts.referer || DEFAULT_REFERER;
  const emit = opts.onProgress;

  emit?.({
    status: "attributing",
    model,
    rosterSize: speakers.length,
    segmentCount: segments.length,
  });

  const { system, user } = buildAttributionPrompt({ segments, speakers });

  let openrouterRes: Response;
  try {
    openrouterRes = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": referer,
        "X-Title": "Whisper It",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.1,
        response_format: { type: "json_object" },
        stream: true,
      }),
    });
  } catch (e: any) {
    throw new AttributeError(`OpenRouter request failed: ${e?.message || String(e)}`);
  }

  if (!openrouterRes.ok) {
    let errBody = "";
    try {
      errBody = (await openrouterRes.text()).slice(0, 400);
    } catch {
      /* ignore */
    }
    throw new AttributeError(
      `OpenRouter ${openrouterRes.status}: ${errBody || openrouterRes.statusText}`,
    );
  }

  const startedAt = Date.now();
  const total = segments.length;
  const contentType = openrouterRes.headers.get("content-type") || "";
  let content = "";

  if (contentType.includes("text/event-stream") && openrouterRes.body) {
    // Streamed completion: forward live progress as the model emits assignments.
    let lastDone = -1;
    const emitProgress = (force = false) => {
      const done = Math.min(countAssignedKeys(content), total);
      if (force || done !== lastDone) {
        lastDone = done;
        emit?.({ status: "progress", done, total, elapsedMs: Date.now() - startedAt });
      }
    };
    // Heartbeat keeps the bar moving during silent "thinking" gaps.
    const heartbeat = emit ? setInterval(() => emitProgress(true), 4000) : null;
    emitProgress(true); // show the bar immediately at 0
    try {
      const reader = (openrouterRes.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue; // skip ": OPENROUTER PROCESSING" keep-alives
          const data = t.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const delta = JSON.parse(data)?.choices?.[0]?.delta?.content;
            if (typeof delta === "string") content += delta;
          } catch {
            /* partial/non-JSON chunk — ignore */
          }
        }
        emitProgress();
      }
      emitProgress(true);
    } catch (e: any) {
      if (heartbeat) clearInterval(heartbeat);
      throw new AttributeError(`OpenRouter stream failed: ${e?.message || String(e)}`);
    }
    if (heartbeat) clearInterval(heartbeat);
  } else {
    // Non-streaming (test mocks / providers that ignore `stream`): single JSON body.
    let payload: any;
    try {
      payload = await openrouterRes.json();
    } catch (e: any) {
      throw new AttributeError(`OpenRouter returned non-JSON: ${e?.message || String(e)}`);
    }
    content = payload?.choices?.[0]?.message?.content;
  }

  if (typeof content !== "string" || !content.trim()) {
    throw new AttributeError("OpenRouter response missing message content");
  }

  const result = applyAssignments(segments, content);
  return { ...result, model };
}
