import { describe, it, expect } from "vitest";
import { describeFailure } from "../../src/lib/transcribe-core";

describe("describeFailure (transcribe-core)", () => {
  it("reports OOM when killed by SIGKILL, embedding the model name", () => {
    const r = describeFailure({ code: null, signal: "SIGKILL", model: "medium", stderrRaw: "" });
    expect(r.kind).toBe("oom");
    expect(r.reason).toMatch(/out of memory/i);
    expect(r.reason).toContain("medium");
  });

  it("reports OOM when exit code is null with no signal", () => {
    const r = describeFailure({ code: null, signal: null, model: "small", stderrRaw: "" });
    expect(r.kind).toBe("oom");
    expect(r.reason).toContain("small");
  });

  it("reports a non-SIGKILL signal termination", () => {
    const r = describeFailure({ code: null, signal: "SIGTERM", model: "small", stderrRaw: "" });
    expect(r.kind).toBe("signal");
    expect(r.reason).toBe("Process terminated by signal SIGTERM.");
  });

  it("returns the stderr tail (non-JSON lines) for a plain non-zero exit", () => {
    const stderrRaw = [
      '{"status":"loading_model"}',
      "Traceback (most recent call last):",
      "RuntimeError: boom",
    ].join("\n");
    const r = describeFailure({ code: 1, signal: null, model: "small", stderrRaw });
    expect(r.kind).toBe("exit");
    expect(r.reason).toContain("RuntimeError: boom");
    expect(r.reason).not.toContain("loading_model");
  });

  it("falls back to the exit code when there is no useful stderr", () => {
    const r = describeFailure({ code: 2, signal: null, model: "small", stderrRaw: "" });
    expect(r.kind).toBe("exit");
    expect(r.reason).toBe("exit code 2");
  });
});
