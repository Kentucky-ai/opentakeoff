// Scan/OCR half of "Import from schedule". PURE and DOM-free on purpose (the
// sheets.ts / oneclick.ts precedent): the canvas rasterizes the marqueed region
// and POSTs it to the optional AI sandbox (POST /ai/parse-schedule); this module
// turns whatever loosely-typed JSON the server/adapter returns into the SAME
// ScheduleRow[] the vector path produces, so both feed the one approval dialog.
//
// The server is bring-your-own-model and may return partial/garbage rows, so
// every field is coerced and validated here — a malformed row is dropped, never
// crashes the dialog. Kept out of the canvas so this coercion is node-testable.

import type { ScheduleRow, Category } from "./scheduleParse.js";

// The one AI endpoint this path calls. Dev proxies /ai/* → localhost:8000
// (see web/vite.config.js); in prod it's dormant unless a backend is wired up.
export const SCAN_ENDPOINT = "/ai/parse-schedule";

// Longest side (px) the scan raster may be. MATCHED PAIR: this MUST equal
// MAX_IMAGE_DIM in netlify/functions/parse-schedule.mjs — the server 400s
// ("invalid image dimensions") anything larger, so the client must downscale to
// fit or a big marquee (≈ a whole sheet) fails. Same "keep client & server caps
// in sync" hazard as the org-gate (#91), just for pixels.
export const SCAN_MAX_DIM = 4096;

// Downscale factor for a marqueed region so neither side exceeds `maxDim`. Never
// upscales (≤ 1), so a small crop is sent at full render resolution and only an
// oversized one is shrunk — and only as far as the cap, never more (keeps the
// most resolution the pipeline will accept, which matters for the model reading
// small schedule text). Pure/testable; the canvas calls it in rasterizeRegion.
export function scanRasterScale(regW: number, regH: number, maxDim: number = SCAN_MAX_DIM): number {
  const w = Math.max(1, regW), h = Math.max(1, regH);
  return Math.min(1, maxDim / w, maxDim / h);
}

// Netlify's synchronous function cap (measured ~30s on this deployment's plan)
// returns a 504 gateway page — HTML, not our JSON — when a COLD start plus a slow
// vision call overruns it; the immediately-following WARM call succeeds (#102).
// So retry a 504 exactly ONCE against the now-warm instance before surfacing
// failure. Only 504 (the platform timeout) is retried — NOT the function's own
// JSON 5xx (a Gemini/auth failure a retry won't fix and that already spent the
// call), so cold-start cost is capped at 2× on genuine timeouts only, never on
// real errors.
export const SCAN_RETRY_STATUS = 504;

/**
 * Run a scan POST, retrying ONCE on a 504 (cold-start gateway timeout) or a thrown
 * network error. `post` performs one attempt and resolves to its Response (or
 * throws on a network failure). Returns the first NON-504 Response (a success or a
 * real error the caller should handle); if both attempts 504, returns the 504 so
 * the caller shows its normal "couldn't reach the reader" copy; if both throw,
 * rethrows the last error. `onRetry` fires before the second attempt (e.g. to
 * surface "warming up — retrying…"). Pure/injectable (sleep + post) so the retry
 * branch is node-testable without a real network or timer.
 */
export async function postScanWithRetry(
  post: () => Promise<Response>,
  opts: { delayMs?: number; onRetry?: () => void; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Response> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last504: Response | undefined;
  let lastErr: unknown;
  let threw = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) { opts.onRetry?.(); await sleep(opts.delayMs ?? 700); }
    try {
      const res = await post();
      if (res.status !== SCAN_RETRY_STATUS) return res;  // success OR a non-retryable error
      last504 = res;                                     // 504 → eligible for the one retry
    } catch (e) {
      lastErr = e; threw = true;                         // network error → eligible for the one retry
    }
  }
  if (last504) return last504;   // at least one attempt reached the gateway timeout
  if (threw) throw lastErr;      // both attempts failed to reach the server
  // unreachable: the loop always returns, sets last504, or sets threw
  throw new Error("scan retry: no response");
}

// Mirror of scheduleParse's category vocabulary + which categories the dialog
// pre-checks. Duplicated (not imported) so the parser's internals stay private;
// the ScheduleRow *type* is the shared contract, this is just its value domain.
const CATEGORIES: readonly Category[] = ["floor", "base", "wall", "transition", "ceiling", "other"];
const SUGGESTED: Record<Category, boolean> = {
  floor: true, base: true, wall: true, transition: true, ceiling: false, other: false,
};

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function toCategory(v: unknown): Category {
  const c = str(v).toLowerCase();
  return (CATEGORIES as readonly string[]).includes(c) ? (c as Category) : "other";
}

// Coerce one loosely-typed server object into a ScheduleRow, or null if it has
// no finish tag (an untagged row can't become a condition — drop it).
function toRow(raw: unknown): ScheduleRow | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const finish_tag = str(o.finish_tag).toUpperCase();
  if (!finish_tag) return null;
  const category = toCategory(o.category);
  return {
    finish_tag,
    section: str(o.section).toUpperCase(),
    category,
    description: str(o.description),
    manufacturer: str(o.manufacturer),
    style: str(o.style),
    spec_color: str(o.spec_color),
    size: str(o.size),
    // trust the server's checkbox intent only if it sent a real boolean;
    // otherwise fall back to the category default (ceiling/other start off).
    suggested: typeof o.suggested === "boolean" ? o.suggested : SUGGESTED[category],
  };
}

/**
 * Normalize a /ai/parse-schedule response ({ rows: [...] }, or a bare array)
 * into validated ScheduleRow[]. Unknown/malformed shapes → [] so the caller
 * shows "no schedule found" rather than inventing rows. De-dupes by finish_tag
 * (first wins) since the dialog keys on it.
 */
export function normalizeScanRows(payload: unknown): ScheduleRow[] {
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { rows?: unknown }).rows)
      ? (payload as { rows: unknown[] }).rows
      : [];
  const out: ScheduleRow[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const row = toRow(item);
    if (!row || seen.has(row.finish_tag)) continue;
    seen.add(row.finish_tag);
    out.push(row);
  }
  return out;
}
