// The only module that touches pdf.js. The session works on the plain data
// handed out here; the geometry engine (web/src/lib) never sees a pdf.js object.
import "./hush.ts"; // must stay the first import — see hush.ts
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as pdfjs from "pdfjs-dist";
import type { OpList, OpsTable } from "../../web/src/lib/oneclick.ts";
import { RENDER_SCALE } from "../../web/src/lib/sheets.ts";

const requireHere = createRequire(import.meta.url);
const PDFJS_ROOT = path.dirname(requireHere.resolve("pdfjs-dist/package.json"));

/** pdf.js's op-code table, passed through to extractVectorGeometry. */
export const OPS = pdfjs.OPS as unknown as OpsTable;

export interface ViewportLike { width: number; height: number; transform: number[] }
interface TextItemLike { str?: string; transform: number[]; height?: number }
export interface TextContentLike { items: TextItemLike[] }

export interface PageHandle {
  pageNum: number;
  /** page size in PDF points */
  widthPt: number;
  heightPt: number;
  /** viewport at RENDER_SCALE — image-px space (pt × 2, origin top-left, y down) */
  viewport: ViewportLike;
  textContent: TextContentLike;
  operatorList(): Promise<OpList>;
  /** Rasterize the page at the given scale (px per PDF pt) to PNG bytes.
   * Needs @napi-rs/canvas (pdfjs-dist's own optional dependency); throws a
   * plain Error naming it when the platform has no prebuilt binary. */
  renderPng(scale: number): Promise<Uint8Array>;
}

/** pdf.js's modern build renders against DOM canvas globals that bare Node
 * lacks; @napi-rs/canvas provides them. Loaded lazily so a platform without
 * the optional native binary still runs every non-raster tool. */
async function ensureCanvasGlobals(): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  if (g.Path2D && g.DOMMatrix && g.ImageData) return;
  let napi: typeof import("@napi-rs/canvas");
  try {
    napi = await import("@napi-rs/canvas");
  } catch {
    throw new Error(
      "Page rendering needs @napi-rs/canvas (pdfjs-dist's optional dependency), which did not install on this platform. Reinstall with optional dependencies enabled.",
    );
  }
  g.Path2D ??= napi.Path2D;
  g.DOMMatrix ??= napi.DOMMatrix;
  g.ImageData ??= napi.ImageData;
}

export interface DocHandle {
  numPages: number;
  page(n: number): Promise<PageHandle>;
  destroy(): Promise<void>;
}

export async function openPdf(filePath: string): Promise<DocHandle> {
  const bytes = await readFile(filePath);
  const doc = await pdfjs.getDocument({
    // getDocument({ data }) may DETACH the buffer it is handed — always pass a
    // fresh copy (new Uint8Array(view) copies), never the read buffer itself.
    data: new Uint8Array(bytes),
    verbosity: 0,
    standardFontDataUrl: path.join(PDFJS_ROOT, "standard_fonts") + path.sep,
    cMapUrl: path.join(PDFJS_ROOT, "cmaps") + path.sep,
    cMapPacked: true,
    isEvalSupported: false,
  }).promise;
  return {
    numPages: doc.numPages,
    async page(n: number): Promise<PageHandle> {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: RENDER_SCALE });
      const vp1 = page.getViewport({ scale: 1 });
      const textContent = (await page.getTextContent()) as TextContentLike;
      return {
        pageNum: n,
        widthPt: vp1.width,
        heightPt: vp1.height,
        viewport: { width: vp.width, height: vp.height, transform: vp.transform },
        textContent,
        operatorList: async () => (await page.getOperatorList()) as unknown as OpList,
        async renderPng(scale: number): Promise<Uint8Array> {
          await ensureCanvasGlobals();
          const rvp = page.getViewport({ scale });
          // canvasFactory is the document's NodeCanvasFactory — present on the
          // proxy at runtime, absent from pdfjs-dist's public types
          const factory = (doc as unknown as { canvasFactory: { create(w: number, h: number): { canvas: { toBuffer(mime: "image/png"): Buffer }; context: object }; destroy(target: object): void } }).canvasFactory;
          const target = factory.create(Math.ceil(rvp.width), Math.ceil(rvp.height));
          try {
            await page.render({ canvasContext: target.context as never, viewport: rvp }).promise;
            return new Uint8Array(target.canvas.toBuffer("image/png"));
          } finally {
            factory.destroy(target);
          }
        },
      };
    },
    destroy: () => doc.destroy().then(() => undefined),
  };
}

/** Positioned page text in image px — the same viewport-transform math
 * detectScale uses (web/src/lib/sheets.ts). */
export function positionedText(ph: PageHandle): { str: string; x: number; y: number }[] {
  const out: { str: string; x: number; y: number }[] = [];
  for (const it of ph.textContent.items || []) {
    const str = it.str || "";
    if (!str.trim()) continue;
    const t = pdfjs.Util.transform(ph.viewport.transform, it.transform);
    out.push({ str, x: +t[4].toFixed(1), y: +t[5].toFixed(1) });
  }
  return out;
}
