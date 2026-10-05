// A second view can expose a dropped character even when the first read's
// mean confidence is > .99 (#500). It is disagreement evidence, not a vote
// for replacing the first read. Requested only for schedule imports.
import { cleanOcrText } from "./wordClean";

export type CodeBox = { x: number; y: number; width: number; height: number };
export type CodeRead = { text: string; box: CodeBox; confidence: number; codeAlternate?: string };
export type MakeCodeCrop = (canvas: unknown, box: CodeBox) => unknown;

const comparable = (text: string) => cleanOcrText(text).trim().replace(/\s+/g, " ").toUpperCase();

/** Short standalone code shapes, including a single surviving letter. A
 * prose line is not reread; long/huge boxes are bounded before allocating. */
export function checkableCode(read: CodeRead): boolean {
  const text = comparable(read.text).replace(/\s+/g, "");
  return /^[A-Z0-9][A-Z0-9()./-]{0,15}$/.test(text)
    && (/\d/.test(text) || text.length <= 4)
    && read.box.width > 0 && read.box.width <= 1024
    && read.box.height > 0 && read.box.height <= 256;
}

/** A crop stretched horizontally by 2 gives short/thin glyphs a different
 * recognition view. Keep every primary string, box and confidence unchanged.
 * An empty second read is also a disagreement; never silently call it verified. */
export async function checkCodes(
  reads: CodeRead[], canvas: unknown, makeCrop: MakeCodeCrop,
  recognize: (crop: unknown, box: CodeBox) => Promise<CodeRead[]>,
): Promise<CodeRead[]> {
  const out: CodeRead[] = [];
  for (const read of reads) {
    if (!checkableCode(read)) { out.push(read); continue; }
    const crop = makeCrop(canvas, read.box);
    const box = { x: 0, y: 0, width: Math.max(1, Math.ceil(read.box.width * 2)), height: Math.max(1, Math.ceil(read.box.height)) };
    const second = await recognize(crop, box);
    const alternative = second.length === 1 ? comparable(second[0].text) : "";
    out.push(alternative === comparable(read.text) ? read : { ...read, codeAlternate: alternative });
  }
  return out;
}
