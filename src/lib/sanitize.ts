export function sanitizeZipName(name: string): string {
  // Strip control chars, path separators, leading dots; cap length.
  const base = String(name)
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[\\/]+/g, "_")
    .replace(/^\.+/, "");
  const trimmed = base.trim() || "transcript.txt";
  return trimmed.slice(0, 200);
}
