// Cached on-device OCR reads of whole PDF pages (#471), in the meta store.
// Pure over injected metaGet/metaPut, so Node tests it with a Map.
//
//   key   ocr:v1:<sha256 of the PDF's bytes>:<page>
//   value { v: 1, rev, opts, rs, lines, ms, rasters, at }
//
// rev is the OCR model rev that read the page. It isn't in the key: a read by
// an older model is still used (the caller may offer "Read again" when it
// knows a newer rev), so a lookup never needs the network. opts is a short
// hash of everything else that shapes the read (engine options, target DPI,
// tile overlap, raster cap, seam rules version, ink preprocessing): a
// mismatch is a miss, except for an opts on STALE_OK_OPTS (a past engine
// whose reads are still worth searching), which is a stale hit. rs is the
// render scale the lines are in; a lookup at another rs gets them rescaled.
// Bump v1 (here and in pdfHash.ts's prefix) when the tile or unpad maths
// changes.
// A leaf module: no OCR engine, rasterizer or worker code comes with it.
import { OCR_ENGINE_OPTIONS, OCR_INK, OCR_READ_DPI, OCR_SCAN_MAX_DIM, OCR_SEAM_RULES_VERSION, OCR_TILE_OVERLAP_PT } from "./engineOptions";
import { isPdfHash, ocrCachePrefix } from "./pdfHash";
import type { OcrWord } from "./types";

/** Everything besides the model rev that shapes a page read. */
export const OCR_CACHE_PARAMS = {
  engine: OCR_ENGINE_OPTIONS,
  dpi: OCR_READ_DPI,
  overlapPt: OCR_TILE_OVERLAP_PT,
  maxDim: OCR_SCAN_MAX_DIM,
  seams: OCR_SEAM_RULES_VERSION,
  ink: OCR_INK,
};
export type OcrCacheParams = typeof OCR_CACHE_PARAMS;

// JSON with object keys sorted, so the hash doesn't depend on key order.
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** 8 hex chars (FNV-1a 32) of the canonical params. */
export function ocrCacheOpts(params: OcrCacheParams): string {
  const s = canonical(params);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export const OCR_CACHE_OPTS = ocrCacheOpts(OCR_CACHE_PARAMS);

/** Opts hashes of past reads kept, flagged stale, rather than dropped: the
 * lines stay in search and Copy and the Read control offers Read again. An
 * old hash goes here when serving its reads, marked stale, beats losing
 * search and Copy on every page read under it until each is read again; a
 * seam-rule or DPI fix stays a miss, so a read known to be wrong where it
 * matters isn't served. e2f8d8b4: per-line recognition at batch 6 with the
 * ink pass (#481), before #484 (it misread or dropped some rows; most of its
 * text still searches). d67721d4, the same engine before #481, stays a miss:
 * it read red and magenta text as blank. */
export const STALE_OK_OPTS: readonly string[] = ["e2f8d8b4"];

/** The meta key for one page (1-based) of one PDF. Throws on a bad hash or page. */
export function ocrCacheKey(hash: string, page: number): string {
  if (!Number.isInteger(page) || page < 1) throw new TypeError(`bad page number: ${page}`);
  return `${ocrCachePrefix(hash)}${page}`;
}

/** A cached line: an OcrWord, plus seams.ts's clipped flag when set. */
export type CachedLine = OcrWord & { clipped?: true };

export interface PageCacheEntry {
  v: 1;
  rev: string;
  opts: string;
  rs: number;
  lines: CachedLine[];
  ms: number;
  rasters: number;
  at: number;
}

export interface PageCacheHit {
  rev: string;
  /** the rs the lines are in: the one asked for */
  rs: number;
  lines: CachedLine[];
  ms: number;
  rasters: number;
  at: number;
  /** read by a model rev other than the current one (only when it's known),
   * or under STALE_OK_OPTS (whatever the rev) */
  stale: boolean;
}

export interface PageCacheDeps {
  metaGet(key: string): Promise<unknown>;
  metaPut(key: string, value: unknown): Promise<void>;
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const positive = (n: unknown): n is number => finite(n) && n > 0;
const nonNeg = (n: unknown): n is number => finite(n) && n >= 0;

function isLine(w: unknown): w is CachedLine {
  if (!w || typeof w !== "object") return false;
  const o = w as Record<string, unknown>;
  return typeof o.str === "string" && finite(o.x) && finite(o.y) && nonNeg(o.w) && nonNeg(o.h)
    && (o.confidence === undefined || finite(o.confidence))
    && (o.clipped === undefined || o.clipped === true);
}

function isEntry(v: unknown): v is PageCacheEntry {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return o.v === 1 && typeof o.rev === "string" && typeof o.opts === "string" && positive(o.rs)
    && Array.isArray(o.lines) && o.lines.every(isLine)
    && nonNeg(o.ms) && Number.isInteger(o.rasters) && (o.rasters as number) >= 0 && finite(o.at);
}

/** A stored line in `f`× its stored px, built field by field: nothing else a
 * stored object carries reaches the caller. clipped is seams.ts's flag for a
 * line longer than a patch holds. */
function scaleLine(w: CachedLine, f: number): CachedLine {
  const out: CachedLine = { str: w.str, x: w.x * f, y: w.y * f, w: w.w * f, h: w.h * f };
  if (w.confidence !== undefined) out.confidence = w.confidence;
  if (w.clipped) out.clipped = true;
  return out;
}

export function createPageCache(deps: PageCacheDeps, { opts = OCR_CACHE_OPTS }: { opts?: string } = {}) {
  return {
    /** The cached read of `page`, lines in `rs` px, or null (a miss, a bad
     * hash, a malformed entry, or one under other opts not on STALE_OK_OPTS). */
    async get(hash: string | null | undefined, page: number, { rs, rev }: { rs: number; rev?: string | null }): Promise<PageCacheHit | null> {
      if (!positive(rs)) throw new TypeError(`bad render scale: ${rs}`);
      if (!isPdfHash(hash)) return null;
      const e = await deps.metaGet(ocrCacheKey(hash, page));
      if (!isEntry(e)) return null;
      // checked without the rev: revOf is null offline, and the read is
      // from another engine either way
      const otherEngine = e.opts !== opts;
      if (otherEngine && !STALE_OK_OPTS.includes(e.opts)) return null;
      const f = rs / e.rs;
      return {
        rev: e.rev,
        rs,
        lines: e.lines.map((w) => scaleLine(w, f)),
        ms: e.ms,
        rasters: e.rasters,
        at: e.at,
        stale: otherEngine || (rev != null && e.rev !== rev),
      };
    },

    /** Store a page read. Throws (without writing) on a bad hash or value. */
    async put(hash: string | null | undefined, page: number, read: { rev: string; rs: number; lines: CachedLine[]; ms: number; rasters: number; at?: number }): Promise<void> {
      if (!isPdfHash(hash)) throw new TypeError("not a PDF sha256");
      const entry = { v: 1, rev: read.rev, opts, rs: read.rs, lines: read.lines, ms: read.ms, rasters: read.rasters, at: read.at ?? Date.now() };
      if (!isEntry(entry)) throw new TypeError("malformed OCR page read");
      await deps.metaPut(ocrCacheKey(hash, page), entry);
    },
  };
}

export type PageCache = ReturnType<typeof createPageCache>;
