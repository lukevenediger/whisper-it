// Transcript → PDF via pdfkit. Used when a transcript is too long for a
// Telegram message. pdfkit's built-in Helvetica only covers WinAnsi, so we
// prefer a TTF (DejaVu Sans from the fonts-dejavu-core package in the image).
import fs from "fs";
import PDFDocument from "pdfkit";

export type PdfBodyLine = { speaker?: string; text: string; ambiguous?: boolean };

export type PdfInput = {
  title: string;
  body: string | PdfBodyLine[];
  meta: { model: string; language: string; duration: number; date: Date };
};

export const DEJAVU_PATHS = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/TTF/DejaVuSans.ttf",
];

export type FontChoice = { path: string; boldPath?: string } | { builtin: "Helvetica" };

let warnedFallback = false;

/** Pick the body font: env override → DejaVu → Helvetica (with a one-time warning). */
export function resolveFont(o: { candidates?: string[]; env?: string } = {}): FontChoice {
  const env = o.env ?? process.env.TELEGRAM_PDF_FONT;
  const candidates = [...(env ? [env] : []), ...(o.candidates ?? DEJAVU_PATHS)];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) {
      const bold = p.replace(/\.ttf$/i, "-Bold.ttf");
      return { path: p, boldPath: bold !== p && fs.existsSync(bold) ? bold : undefined };
    }
  }
  if (!warnedFallback) {
    warnedFallback = true;
    console.warn("[telegram] no TTF font found for PDFs — falling back to Helvetica (Latin-only)");
  }
  return { builtin: "Helvetica" };
}

function fmtDuration(sec: number): string {
  const s = Math.round(sec || 0);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function buildTranscriptPdf(
  input: PdfInput,
  opts: { fontPath?: string | null } = {},
): Promise<Buffer> {
  const font: FontChoice =
    opts.fontPath === null
      ? { builtin: "Helvetica" }
      : opts.fontPath
        ? resolveFont({ candidates: [opts.fontPath], env: "" })
        : resolveFont();
  const regular = "builtin" in font ? "Helvetica" : font.path;
  const bold = "builtin" in font ? "Helvetica-Bold" : font.boldPath || font.path;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 56, info: { Title: input.title } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      doc.font(bold).fontSize(16).text(input.title);
      const m = input.meta;
      const metaLine = [
        m.language || null,
        m.model,
        fmtDuration(m.duration),
        m.date.toISOString().slice(0, 16).replace("T", " "),
      ]
        .filter(Boolean)
        .join(" · ");
      doc.moveDown(0.3).font(regular).fontSize(9).fillColor("#666").text(metaLine);
      doc.moveDown(1).fillColor("#000").fontSize(11);

      if (typeof input.body === "string") {
        doc.font(regular).text(input.body, { lineGap: 3 });
      } else {
        for (const line of input.body) {
          if (line.speaker) {
            doc
              .font(bold)
              .text(`${line.speaker}${line.ambiguous ? " (?)" : ""}: `, { continued: true });
          }
          doc.font(regular).text(line.text, { lineGap: 3 });
          doc.moveDown(0.4);
        }
      }
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
