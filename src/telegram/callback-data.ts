// Compact, versioned encoding of inline-button actions into Telegram's 64-byte
// callback_data. Message identity comes from callback_query.message, so no ids
// are embedded here. Pure; validates on decode so stale/forged data is ignored.
import { VALID_MODELS } from "../lib/engine";
import { VALID_LANGUAGES } from "../lib/languages";
import { ATTR_MODEL_OPTIONS } from "../lib/attribution";

export const CALLBACK_MAX_BYTES = 64;
const VERSION = "t1";

export type MenuName = "root" | "retry" | "lang" | "diar" | "llm";
const MENUS: readonly MenuName[] = ["root", "retry", "lang", "diar", "llm"];

export type CallbackAction =
  | { kind: "menu"; menu: MenuName }
  | { kind: "retry"; model: string }
  | { kind: "lang"; language: string }
  | { kind: "diar"; mode: "guess" | "names" }
  | { kind: "llm"; index: number }
  | { kind: "pref"; field: "model" | "language"; value: string }
  | { kind: "noop" };

export function encodeCallback(a: CallbackAction): string {
  let s: string;
  switch (a.kind) {
    case "menu":
      s = `${VERSION}:menu:${a.menu}`;
      break;
    case "retry":
      s = `${VERSION}:retry:${a.model}`;
      break;
    case "lang":
      s = `${VERSION}:lang:${a.language}`;
      break;
    case "diar":
      s = `${VERSION}:diar:${a.mode}`;
      break;
    case "llm":
      s = `${VERSION}:llm:${a.index}`;
      break;
    case "pref":
      s = `${VERSION}:pref:${a.field}:${a.value}`;
      break;
    case "noop":
      s = `${VERSION}:noop`;
      break;
  }
  if (Buffer.byteLength(s) > CALLBACK_MAX_BYTES) throw new Error(`callback_data too long: ${s}`);
  return s;
}

export function decodeCallback(s: string): CallbackAction | null {
  if (typeof s !== "string" || !s) return null;
  const parts = s.split(":");
  if (parts[0] !== VERSION) return null;
  const [, kind, a, b] = parts;
  switch (kind) {
    case "menu":
      return (MENUS as readonly string[]).includes(a)
        ? { kind: "menu", menu: a as MenuName }
        : null;
    case "retry":
      return VALID_MODELS.includes(a) ? { kind: "retry", model: a } : null;
    case "lang":
      return VALID_LANGUAGES.has(a) ? { kind: "lang", language: a } : null;
    case "diar":
      return a === "guess" || a === "names" ? { kind: "diar", mode: a } : null;
    case "llm": {
      if (!/^\d+$/.test(a || "")) return null;
      const index = Number(a);
      return index < ATTR_MODEL_OPTIONS.length ? { kind: "llm", index } : null;
    }
    case "pref":
      if (a === "model" && VALID_MODELS.includes(b))
        return { kind: "pref", field: "model", value: b };
      if (a === "language" && VALID_LANGUAGES.has(b))
        return { kind: "pref", field: "language", value: b };
      return null;
    case "noop":
      return { kind: "noop" };
    default:
      return null;
  }
}
