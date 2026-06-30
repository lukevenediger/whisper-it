import { spawn, ChildProcess } from "child_process";
import path from "path";

// One newline-delimited JSON event from the Python child's stderr
// (status: "loading_model" | "downloading" | "chunking" | "chunked" | "transcribing" | ...).
export type TranscribeProgress = { status: string; [k: string]: unknown };

export type TranscribeSegment = { start: number; end: number; text: string };

// Final result parsed from the child's stdout.
export type TranscribeResult = {
  text: string;
  segments: TranscribeSegment[];
  language: string;
  duration: number;
};

export type TranscribeFailureKind = "oom" | "signal" | "exit" | "spawn" | "parse";

export class TranscribeAbortError extends Error {
  constructor() {
    super("Transcription aborted");
    this.name = "TranscribeAbortError";
  }
}

export class TranscribeError extends Error {
  constructor(
    message: string,
    readonly kind: TranscribeFailureKind,
    readonly code: number | null = null,
    readonly signalName: NodeJS.Signals | null = null,
  ) {
    super(message);
    this.name = "TranscribeError";
  }
}

export type TranscribeOptions = {
  /** Effective model to run (caller already resolved engine/fallback). */
  model: string;
  /** Absolute path to the audio file the child reads. Core does NOT delete it. */
  filePath: string;
  /** "" or "auto" => no --language flag is passed. */
  language?: string;
  /** Per-event callback for each parsed stderr JSON line. */
  onProgress?: (event: TranscribeProgress) => void;
  /** Override script path (defaults to <repo>/transcribe.py). Lets tests stub. */
  scriptPath?: string;
  /** Abort hook: kills the child and rejects with TranscribeAbortError. */
  signal?: AbortSignal;
};

/**
 * Classify a non-zero/abnormal child exit into a failure kind + human reason.
 * Mirrors the original inline logic in the /api/transcribe route so the wire
 * error copy stays byte-identical. Pure — unit-testable without spawning.
 */
export function describeFailure(input: {
  code: number | null;
  signal: NodeJS.Signals | null;
  model: string;
  stderrRaw: string;
}): { kind: TranscribeFailureKind; reason: string } {
  const { code, signal, model, stderrRaw } = input;
  if (signal === "SIGKILL" || (code === null && !signal)) {
    return {
      kind: "oom",
      reason: `Process killed (likely out of memory — try a smaller model, or increase Docker's memory allocation). Model: ${model}.`,
    };
  }
  if (signal) {
    return { kind: "signal", reason: `Process terminated by signal ${signal}.` };
  }
  const tail = stderrRaw
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("{"))
    .slice(-8)
    .join("\n");
  return { kind: "exit", reason: tail.trim() || `exit code ${code}` };
}

/**
 * Spawn transcribe.py, stream its stderr progress events to `onProgress`, and
 * resolve with the final result parsed from stdout. The caller owns the input
 * file lifecycle (no cleanup here) and any stats recording.
 */
export function runTranscription(opts: TranscribeOptions): Promise<TranscribeResult> {
  const { model, filePath, language, onProgress, signal } = opts;
  const scriptPath = opts.scriptPath || path.join(__dirname, "..", "..", "transcribe.py");

  return new Promise<TranscribeResult>((resolve, reject) => {
    const pyArgs = [scriptPath, "--model", model, "--file", filePath];
    if (language && language !== "auto") {
      pyArgs.push("--language", language);
    }

    let proc: ChildProcess;
    try {
      proc = spawn("python3", pyArgs);
    } catch {
      reject(new TranscribeError("Failed to start transcription process", "spawn"));
      return;
    }

    let stdout = "";
    let stderrBuf = "";
    let stderrRaw = "";
    let aborted = false;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener("abort", onAbort);
      fn();
    };

    const onAbort = () => {
      aborted = true;
      if (!proc.killed) {
        try {
          proc.kill();
        } catch {
          /* already gone */
        }
      }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort);
    }

    proc.stdout!.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr!.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stderrRaw += chunk;
      stderrBuf += chunk;
      const lines = stderrBuf.split("\n");
      stderrBuf = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as TranscribeProgress;
          onProgress?.(parsed);
        } catch {
          console.error("[python stderr]", trimmed);
        }
      }
    });

    proc.on("error", (err) => {
      console.error("Failed to start transcription process:", err);
      finish(() => reject(new TranscribeError("Failed to start transcription process", "spawn")));
    });

    proc.on("close", (code, sig) => {
      if (aborted) {
        finish(() => reject(new TranscribeAbortError()));
        return;
      }
      if (code === 0) {
        let result: TranscribeResult;
        try {
          result = JSON.parse(stdout) as TranscribeResult;
        } catch {
          finish(() =>
            reject(new TranscribeError("Failed to parse transcription output", "parse")),
          );
          return;
        }
        finish(() => resolve(result));
        return;
      }
      const { kind, reason } = describeFailure({
        code,
        signal: sig,
        model,
        stderrRaw,
      });
      console.error(
        `[transcribe] failed (exit code=${code} signal=${sig || "none"}):\n${stderrRaw}`,
      );
      finish(() => reject(new TranscribeError(reason, kind, code, sig)));
    });
  });
}
