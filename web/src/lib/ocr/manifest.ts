// The OCR model manifest (#469), written last by scripts/stage-ocr-model.mjs,
// and the Cache Storage names derived from it. Pure; the main thread's probe
// and the worker both import it, so they always agree on a key.

/** Where the stage script writes the manifest, same-origin. */
export const MANIFEST_URL = "/models/ocr/manifest.json";

/** One file the engine needs. `ort-wasm` has no url: the worker fetches it
 * from Vite's `?url` import and checks it against bytes and sha256. */
export interface ManifestEntry {
  name: string;
  url?: string;
  bytes: number;
  sha256: string;
}

export interface OcrManifest {
  /** model rev + ORT version; names the cache */
  rev: string;
  files: ManifestEntry[];
}

const EXT: Record<string, string> = { det: ".onnx", rec: ".onnx", dict: ".txt", "ort-wasm": ".wasm" };

/** A stable, content-addressed Cache Storage key, independent of the URL the
 * bytes came from (a hashed `?url` changes between builds; the bytes don't). */
export const cacheKey = (e: ManifestEntry): string =>
  `/models/ocr/${e.name}-${e.sha256.slice(0, 12)}${EXT[e.name] ?? ""}`;

/** Every OCR cache name starts with this; the worker deletes the ones that
 * aren't the current rev's. */
export const CACHE_PREFIX = "opentakeoff-ocr-";

/** One cache per manifest rev, so a model or ORT bump starts clean. */
export const cacheName = (rev: string): string => `${CACHE_PREFIX}${rev}`;

/** The four files the engine needs, one entry each. */
const NAMES = ["det", "rec", "dict", "ort-wasm"] as const;
/** Largest file size accepted: far above any real model, far below a
 * size that would make the download notice meaningless. */
export const MAX_FILE_BYTES = 256 * 2 ** 20;
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** A model file is a plain file name under /models/ocr/ on this site. */
const MODEL_URL = /^\/models\/ocr\/[\w-][\w.-]*$/;

/** A parsed manifest, or null unless it is exactly what the stage script
 * writes: det, rec and dict each with a /models/ocr/ url, ort-wasm with
 * none (the worker uses its own `?url`), every size a positive whole number
 * of bytes up to MAX_FILE_BYTES, every sha256 lowercase hex. */
export function asManifest(v: unknown): OcrManifest | null {
  const m = v as OcrManifest;
  if (!m || typeof m.rev !== "string" || !m.rev || !Array.isArray(m.files) || m.files.length !== NAMES.length) return null;
  const seen = new Set<string>();
  for (const f of m.files) {
    if (!f || !(NAMES as readonly string[]).includes(f.name) || seen.has(f.name)) return null;
    seen.add(f.name);
    if (!Number.isSafeInteger(f.bytes) || f.bytes <= 0 || f.bytes > MAX_FILE_BYTES) return null;
    if (typeof f.sha256 !== "string" || !SHA256_HEX.test(f.sha256)) return null;
    if (f.name === "ort-wasm" ? f.url !== undefined : typeof f.url !== "string" || !MODEL_URL.test(f.url)) return null;
  }
  return m;
}
