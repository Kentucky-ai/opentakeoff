// The split read (#481): ppu-paddle-ocr's detection on one canvas, its
// recognition on another. The worker hands detection the tile as rendered and
// recognition a copy with its colored pixels grayed (ink.ts says why).
//
// ppu has no public way to do that, so this mirrors PaddleOcrService
// .recognize() of the pinned ppu 6.6.0 (core/base-paddle-ocr.service.js)
// through two of its protected fields, detector and recognitor, present at
// runtime. For a canvas with noCache it does: boxes = detector.run(canvas);
// no boxes gives the empty result; dict = options.recognition
// .charactersDictionary; strategy = the read's, else the service's, else
// "per-line"; results = recognitor.run(canvas, boxes, dict, strategy,
// options); then groupResultsByLine(results). This does the same, with
// recognition's canvas swapped. Not mirrored, because the worker uses none of
// them: ppu's result cache, flatten: true, a per-read dictionary, and string
// or ArrayBuffer images. test/ocrSplitRecognize.test.ts pins ppu's version
// and that source, so an upgrade that changes recognize() fails there.
//
// The package's exports map doesn't expose this subpath, so it's imported by
// path; the file has no imports of its own.
import { groupResultsByLine } from "../../../node_modules/ppu-paddle-ocr/core/recognition/line-grouping.js";
import type { OcrServiceLike } from "./workerCore";
import { checkCodes, type CodeRead, type MakeCodeCrop } from "./codeCheck";

type Results = Parameters<typeof groupResultsByLine>[0];

/** The parts of ppu's PaddleOcrService the split read uses. detector,
 * recognitor and options are protected in ppu's types, present at runtime. */
export interface PpuServiceInternals {
  detector: { run(canvas: unknown): Promise<unknown[]> } | null;
  recognitor: { run(canvas: unknown, boxes: unknown[], dict: unknown, strategy: string, opts: unknown): Promise<unknown[]> } | null;
  options: { recognition?: { charactersDictionary?: unknown; strategy?: string } };
  destroy(): Promise<void>;
}

/** Wrap a built ppu service so a read can run recognition on a different
 * canvas: recognize(canvas, { recognitionCanvas }) detects on canvas and
 * recognizes recognitionCanvas (canvas when it is left out) with the same
 * boxes. The two canvases must be the same size. */
export function splitRecognizer(svc: PpuServiceInternals, makeCodeCrop?: MakeCodeCrop): OcrServiceLike {
  return {
    async recognize(canvas, opts) {
      const { detector, recognitor } = svc;
      if (!detector || !recognitor) throw new Error("the OCR service isn't initialized");
      const { recognitionCanvas = canvas, verifyCodes, ...ppuOpts } = opts;
      const boxes = await detector.run(canvas);
      if (boxes.length === 0) return { text: "", lines: [], confidence: 0 };
      const dict = svc.options.recognition?.charactersDictionary;
      const strategy = ppuOpts.strategy ?? svc.options.recognition?.strategy ?? "per-line";
      let results = await recognitor.run(recognitionCanvas, boxes, dict, strategy, ppuOpts);
      if (verifyCodes) {
        if (!makeCodeCrop) throw new Error("code-check cropper unavailable");
        results = await checkCodes(results as CodeRead[], recognitionCanvas, makeCodeCrop,
          async (crop, box) => await recognitor.run(crop, [box], dict, "per-box", ppuOpts) as CodeRead[]);
      }
      return groupResultsByLine(results as Results);
    },
    destroy: () => svc.destroy(),
  };
}
