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
