// Shared sheet/plan-text helpers for the Takeoff Canvas and the Sheet Gallery:
// sheet-key codec, standard scales, title-block sheet numbers, drawn-scale notes.
import * as pdfjsLib from "pdfjs-dist";

export const RENDER_SCALE = 2.0;

/** Side-by-side panel cap — shared by the canvas group logic and the gallery's
 * open-side-by-side gate so the two can never disagree. Hi-res sheets render at
 * the full auto budget, so a 4-up of large hi-res sheets is memory-heavy. */
export const MAX_GROUP = 4;

export interface Scale {
  label: string;
  /** real feet per image pixel at RENDER_SCALE */
  upp: number;
}
type ScaleWithKeys = Scale & { keys: string[] };

/** A page viewport (subset of pdf.js's PageViewport that we use). */
interface Viewport {
  width: number;
  height: number;
  transform: number[];
}
interface TextItemLike {
  str?: string;
  transform: number[];
  height?: number;
}
interface TextContentLike {
  items: TextItemLike[];
}

export interface ParsedSheetKey {
  file: string;
  page: number;
}

export interface DetectedScale {
  upp: number;
  label: string;
  multi: boolean;
}

// Standard architectural/engineering scales → units_per_px (real feet per image
// pixel). A plan PDF plotted to size has 72 pt = 1 paper inch; we raster at
// RENDER_SCALE, so 1 paper inch = 72*RENDER_SCALE px. For "1/4\"=1'-0\"", 1 paper
// inch = 4 ft, so feet/px = 4 / (72*RENDER_SCALE). (Use Calibrate for scans.)
const PX_PER_IN = 72 * RENDER_SCALE;
const arch = (inPerFt: number): number => (1 / inPerFt) / PX_PER_IN; // inPerFt e.g. 0.25 for 1/4"=1'
const eng = (ftPerIn: number): number => ftPerIn / PX_PER_IN;        // ftPerIn e.g. 20 for 1"=20'
// Metric ratio scales (EU plans): 1:R means 1 paper unit = R real units, so one
// paper inch = R real inches = R/12 real feet. upp stays in FEET per px — the
// unit system only changes what the UI displays (lib/units.ts).
const metric = (r: number): number => (r / 12) / PX_PER_IN;
export const STANDARD_SCALES: Scale[] = [
  { label: '1/16" = 1\'-0"', upp: arch(1 / 16) },
  { label: '3/32" = 1\'-0"', upp: arch(3 / 32) },
  { label: '1/8" = 1\'-0"', upp: arch(1 / 8) },
  { label: '3/16" = 1\'-0"', upp: arch(3 / 16) },
  { label: '1/4" = 1\'-0"', upp: arch(1 / 4) },
  { label: '3/8" = 1\'-0"', upp: arch(3 / 8) },
  { label: '1/2" = 1\'-0"', upp: arch(1 / 2) },
  { label: '3/4" = 1\'-0"', upp: arch(3 / 4) },
  { label: '1" = 1\'-0"', upp: arch(1) },
  { label: '1-1/2" = 1\'-0"', upp: arch(1.5) },
  { label: '3" = 1\'-0"', upp: arch(3) },
  { label: '1" = 10\'', upp: eng(10) },
  { label: '1" = 20\'', upp: eng(20) },
  { label: '1" = 30\'', upp: eng(30) },
  { label: '1" = 40\'', upp: eng(40) },
  { label: '1" = 50\'', upp: eng(50) },
  { label: '1" = 60\'', upp: eng(60) },
  { label: "1:20", upp: metric(20) },
  { label: "1:25", upp: metric(25) },
  { label: "1:50", upp: metric(50) },
  { label: "1:75", upp: metric(75) },
  { label: "1:100", upp: metric(100) },
  { label: "1:125", upp: metric(125) },
  { label: "1:200", upp: metric(200) },
  { label: "1:250", upp: metric(250) },
  { label: "1:500", upp: metric(500) },
];

// Inverse of sheetKey (page 1 = bare file name; pages 2+ = "name#page"): split on
// the LAST '#' and only when the tail is numeric — file names may contain '#'.
export function parseSheetKey(key: string): ParsedSheetKey {
  const i = key.lastIndexOf("#");
  if (i > 0 && /^\d+$/.test(key.slice(i + 1))) return { file: key.slice(0, i), page: parseInt(key.slice(i + 1), 10) };
  return { file: key, page: 1 };
}

// Pull the drawing's sheet number (e.g. A003, A-101, S1.1) from the title block —
// the largest sheet-number-shaped token in the lower-right region of the page.
const SHEET_NO_RE = /^[A-Z]{1,3}[-. ]?\d{1,3}(\.\d{1,2})?[A-Z]?$/;
export function extractSheetNumber(textContent: TextContentLike, viewport: Viewport): string | null {
  const W = viewport.width, H = viewport.height;
  let best: string | null = null, bestH = 0;
  for (const it of textContent.items || []) {
    const raw = (it.str || "").trim().toUpperCase().replace(/\s+/g, "");
    if (raw.length < 2 || raw.length > 8 || !SHEET_NO_RE.test(raw)) continue;
    const t = pdfjsLib.Util.transform(viewport.transform, it.transform);
    const x = t[4], y = t[5], h = Math.hypot(t[2], t[3]) || it.height || 0;
    // title block lives lower-right; require it there and prefer the biggest text
    if (x < W * 0.60 || y < H * 0.55) continue;
    const score = h + (x / W) * 4 + (y / H) * 4; // bigger + further to lower-right wins
    if (score > bestH) { bestH = score; best = raw; }
  }
  return best;
}

// ── scale detect: read the drawn scale note off the page text ────────────────
// Plans state their scale ("SCALE: 1/8" = 1'-0"") in the title block and under
// viewports. Match the page text against STANDARD_SCALES — wrong scale is the
// top takeoff error source, and the note is sitting right there.
const _canonScaleText = (s: string): string => s
  .replace(/[“”″]/g, '"').replace(/[‘’′]/g, "'")
  .replace(/\s+/g, "").toUpperCase();
const SCALE_KEYS: ScaleWithKeys[] = STANDARD_SCALES.map((s) => {
  const full = _canonScaleText(s.label);
  const keys = new Set<string>([full]);
  if (full.endsWith("=1'-0\"")) keys.add(full.slice(0, -3));   // 1/8"=1'-0" also written 1/8"=1'
  else if (full.endsWith("'")) keys.add(`${full}-0"`);         // 1"=20' also written 1"=20'-0"
  return { ...s, keys: [...keys] };
});
function _findScales(canon: string): ScaleWithKeys[] {
  const out: ScaleWithKeys[] = [];
  for (const sc of SCALE_KEYS) {
    let hit = false;
    for (const k of sc.keys) {
      let i = canon.indexOf(k);
      while (i !== -1 && !hit) {
        const prev = canon[i - 1];
        const next = canon[i + k.length];
        // boundary: "11/8"=1'" or "1-1/2"=…" must not read as 1/8" or 1/2";
        // and a metric "1:500" must not read as its "1:50" prefix
        if (!(prev >= "0" && prev <= "9") && prev !== "/" && prev !== "-"
            && !(next >= "0" && next <= "9")) hit = true;
        else i = canon.indexOf(k, i + 1);
      }
      if (hit) break;
    }
    if (hit) out.push(sc);
  }
  return out;
}
// → {upp, label, multi} or null. Title-block region is authoritative; a single
// page-wide note is accepted; several distinct scales with no title-block note
// is ambiguous (details are often drawn larger) → suggest nothing.
export function detectScale(textContent: TextContentLike, viewport: Viewport): DetectedScale | null {
  const W = viewport.width, H = viewport.height;
  let all = "", tb = "";
  for (const it of textContent.items || []) {
    const str = it.str || "";
    if (!str.trim()) continue;
    all += str + " ";
    const t = pdfjsLib.Util.transform(viewport.transform, it.transform);
    if (t[4] > W * 0.55 && t[5] > H * 0.5) tb += str + " ";
  }
  const tbHits = _findScales(_canonScaleText(tb));
  const allHits = _findScales(_canonScaleText(all));
  if (tbHits.length) return { upp: tbHits[0].upp, label: tbHits[0].label, multi: allHits.length > 1 };
  if (allHits.length === 1) return { upp: allHits[0].upp, label: allHits[0].label, multi: false };
  return null;
}

// Match free text (e.g. a vision model's reply) against STANDARD_SCALES through
// the SAME canonicalizer + boundary-guarded matcher as the page-text path — so
// "1:500" never reads as its "1:50" prefix no matter who wrote the text.
// Exactly one hit or nothing: an ambiguous reply suggests nothing.
export function scaleFromLabel(text: string): DetectedScale | null {
  if (!text || /^\s*UNKNOWN\s*$/i.test(text)) return null;
  const hits = _findScales(_canonScaleText(text));
  return hits.length === 1 ? { upp: hits[0].upp, label: hits[0].label, multi: false } : null;
}
