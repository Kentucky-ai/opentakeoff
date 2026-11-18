// The whole "Find more doors" pass for one sheet, after the model has run:
// reader doors + detector boxes → the sheet's openings.
//   1. fusion (fuse.ts): rescue, veto, doorway line, detector adds;
//   2. swing boxes with a fitted line where nothing else is (swingAdd.ts);
//   3. door tags (tags.ts): pairs on one tag, doors a lone tag points at, untagged weak finds;
//   4. filters: toilet-partition stalls, legend symbols, second finds on one opening.
// Every cutoff comes from doorDetectSettings.json. Pure apart from `page`,
// which the caller fills from pdf.js (client.ts) or a saved fixture.
import SETTINGS from "./doorDetectSettings.json";
import type { Box, DetBox, Mask, Pred, Pt } from "./geom.ts";
import { fuseSheet, type FuseDoor, type FusionParams, type FuseStats } from "./fuse.ts";
import { addSwingBoxes, type SwingBoxParams } from "./swingAdd.ts";
import type { SwingFit } from "./swingfit.ts";
import { tagStage, type TagParams, type TagStageInfo, type TextLine } from "./tags.ts";
import { dedupe, modalWidth, stallDoors, type DedupeParams, type StallParams, type WallSegs } from "./filters.ts";
import { features, legend2, stall2, type Feat, type Legend2Params, type Stall2Params } from "./filters2.ts";
import type { DetectParams } from "./tiles.ts";

export interface DoorDetectSettings {
  version: string;
  model: { repo: string; revision: string; file: string; bytes: number; sha256: string; classes: string[] };
  detect: DetectParams;
  fusion: FusionParams & { swing_box: SwingBoxParams };
  tags: TagParams;
  filters: { stall?: StallParams | null; stall2?: Stall2Params | null; legend2?: Legend2Params | null; dedupe?: DedupeParams | null };
}
export const DOOR_DETECT_SETTINGS = SETTINGS as unknown as DoorDetectSettings;

/** What the pass needs to know about the page besides the doors and boxes. */
export interface DetectPage {
  /** page points per foot at the sheet's scale */
  ppf: number;
  /** the page's ink for line tests (darker than 150), and its pixels per foot */
  ink: Mask;
  inkPxf: number;
  /** the page's ink for wall thickness and fixture ovals (darker than 160) */
  wallInk: Mask;
  /** fit a swing box's doorway line (renders a 32 px/ft clip around it) */
  fitSwing: (b: DetBox) => SwingFit | null | Promise<SwingFit | null>;
  lines: TextLine[];
  /** centres of restroom words and of legend-label lines (filters2.ts restroomWords / legendLabels) */
  rest: Pt[];
  labels: Pt[];
  segs: WallSegs;
}

export interface PipelineResult {
  /** the sheet's openings */
  preds: Pred[];
  /** predictions a filter or the tag stage took out, with the rule */
  dropped: Array<{ pred: Pred; why: string }>;
  /** reader door index → why the fusion left it out */
  readerOut: Record<number, string>;
  stats: { fuse: FuseStats; swingAdded: number; tags: TagStageInfo; share: number; filtered: Record<string, number> };
  /** stage outputs, for parity checks */
  stages: { fused: Pred[]; swing: Pred[]; tagged: Pred[]; feats: Feat[]; drop: Record<number, string> };
}

export async function runDoorPipeline(doors: FuseDoor[], det: DetBox[], page: DetectPage, S: DoorDetectSettings = DOOR_DETECT_SETTINGS): Promise<PipelineResult> {
  const { ppf } = page;
  const fuse = fuseSheet(doors, det, ppf, S.fusion);
  const swing = await addSwingBoxes(fuse.preds, det, ppf, S.fusion.swing_box, page.fitSwing, () => ({ mask: page.ink, pxf: page.inkPxf }));
  const tg = tagStage(swing, page.lines, doors, det, ppf, S.tags, page.ink, page.inkPxf);
  const pred = tg.preds;
  const dropped: Array<{ pred: Pred; why: string }> = Object.entries(tg.dropped).map(([i, why]) => ({ pred: swing[Number(i)], why }));
  const drop: Record<number, string> = {};
  const F = S.filters;
  let feats: Feat[] = [], share = -1;
  if (F.stall2) {
    ({ feats, share } = features(pred, page.wallInk, ppf, page.rest));
    const v1 = new Set<number>();
    if (F.stall && share >= F.stall2.min_share) for (const i of stallDoors(pred, page.segs, ppf, modalWidth(page.segs), F.stall)) v1.add(i);
    for (const i of v1) drop[i] = "stall v1";
    for (const [i, why] of stall2(pred, feats, share, ppf, v1, F.stall2)) drop[i] = "stall2 " + why;
  } else if (F.stall) {
    for (const i of stallDoors(pred, page.segs, ppf, modalWidth(page.segs), F.stall)) drop[i] = "stall v1";
  }
  if (F.legend2) {
    const live = pred.map((_, i) => i).filter((i) => !(i in drop));
    for (const k of legend2(live.map((i) => pred[i]), page.labels, ppf, F.legend2)) drop[live[k]] = "legend2";
  }
  if (F.dedupe) {
    const live = pred.map((_, i) => i).filter((i) => !(i in drop));
    for (const k of dedupe(live.map((i) => pred[i]), ppf, F.dedupe)) drop[live[k]] = "dedupe";
  }
  const filtered: Record<string, number> = {};
  for (const [i, why] of Object.entries(drop)) { dropped.push({ pred: pred[Number(i)], why }); filtered[why] = (filtered[why] ?? 0) + 1; }
  return {
    preds: pred.filter((_, i) => !(i in drop)), dropped, readerOut: fuse.out,
    stats: { fuse: fuse.stats, swingAdded: swing.length - fuse.preds.length, tags: tg.info, share, filtered },
    stages: { fused: fuse.preds, swing, tagged: pred, feats, drop },
  };
}

export type { Box };
