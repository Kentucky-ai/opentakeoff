// The pipeline's openings, as the Doors suite reads doors.
// The suite works on a list of the reader's doors, each either counted or
// withheld (asked about). After "Find more doors" the list is:
//   - every reader door, in its own place (so answers keyed by door stay put):
//     kept ones with the line the fusion settled on; ones a filter took out
//     become withheld, with the reason as their doubt; second finds of an
//     opening that is already listed are hidden;
//   - then the doors the detector added, each a door with no leaves unless a
//     swing was fitted, marked `added`.
// Pure.
import type { DoorLeaf, ReadDoor } from "../doorReader.ts";
import type { FitLeaf, Pred } from "./geom.ts";
import type { PipelineResult } from "./pipeline.ts";

export interface FoundDoors {
  doors: ReadDoor[];
  /** per door: asked about, not counted until answered */
  withheld: boolean[];
  /** per door: the same opening as another door in the list; not shown, not counted, not asked */
  hidden: boolean[];
  /** how many doors the detector added, brought back, and set aside */
  added: number;
  rescued: number;
  setAside: number;
  /** added doors by kind ("opening", "swing", …) */
  byKind: Record<string, number>;
}

const REASONS: Array<[RegExp, string]> = [
  [/^vetoed$/, "weak swing with no detector box near it"],
  [/^stall/, "toilet-partition stall"],
  [/^legend/, "door symbol in a legend"],
  [/^no door tag/, "no door tag on a sheet whose doors are tagged"],
];
const SAME_OPENING = /^(duplicate of door|dedupe|joined as a pair|second line)/;

function leafFromFit(f: FitLeaf, ppf: number): DoorLeaf {
  const a = Math.atan2(f.tip[1] - f.hinge[1], f.tip[0] - f.hinge[0]), b = Math.atan2(f.closed[1] - f.hinge[1], f.closed[0] - f.hinge[0]);
  let sweep = (Math.abs(a - b) * 180) / Math.PI;
  if (sweep > 180) sweep = 360 - sweep;
  return { hinge: f.hinge, radiusPt: f.rFt * ppf, tip: f.tip, drawn: "curve", sweepDeg: sweep, misfitPt: 0, jambFt: null, strike: false, leaf: "drawn" };
}

export function applyPipeline(doors: ReadDoor[], r: PipelineResult, classes: string[], ppf: number): FoundDoors {
  const n = doors.length;
  const owner = new Map<number, { pred: Pred; first: boolean }>();
  for (const p of r.preds) if (p.src === "reader") (p.doors ?? []).forEach((k, j) => { if (!owner.has(k)) owner.set(k, { pred: p, first: j === 0 }); });
  const why = new Map<number, string>();
  for (const d of r.dropped) if (d.pred.src === "reader") for (const k of d.pred.doors ?? []) if (!owner.has(k) && !why.has(k)) why.set(k, d.why);
  const out: ReadDoor[] = [], withheld: boolean[] = [], hidden: boolean[] = [];
  let rescued = 0, setAside = 0;
  for (let i = 0; i < n; i++) {
    const d = doors[i], o = owner.get(i);
    if (o && o.first) {
      const p = o.pred, ids = p.doors ?? [i];
      const leaves = ids.length > 1 ? ids.flatMap((k) => doors[k].leaves) : d.leaves;
      out.push({ ...d, box: p.box, jambLine: [p.p1, p.p2], pair: d.pair || ids.length > 1, leaves });
      // a door the reader itself marks as a toilet-partition stall stays held out until answered (lib/doorSuite.ts heldBack)
      withheld.push(!!d.stall); hidden.push(false);
      if (d.confidence < 0 && !d.stall) rescued++;
      continue;
    }
    if (o) { out.push(d); withheld.push(false); hidden.push(true); continue; }
    const w = why.get(i) ?? r.readerOut[i] ?? "withheld";
    if (SAME_OPENING.test(w)) { out.push(d); withheld.push(false); hidden.push(true); continue; }
    const reason = REASONS.find(([re]) => re.test(w))?.[1];
    out.push(reason ? { ...d, doubts: [reason, ...d.doubts.filter((x) => x !== reason)] } : d);
    withheld.push(true); hidden.push(false);
    if (d.confidence >= 0) setAside++;
  }
  const byKind: Record<string, number> = {};
  let added = 0;
  for (const p of r.preds) {
    if (p.src !== "det") continue;
    const kind = classes[p.cls ?? 0] ?? "door";
    const leaves = p.pairFit ? p.pairFit.map((f) => leafFromFit(f, ppf)) : p.fit ? [leafFromFit(p.fit, ppf)] : [];
    out.push({
      box: p.box, jambLine: [p.p1, p.p2], pair: !!p.pairFit || /pair/.test(p.how ?? ""), stall: false, dashed: false, leaves,
      confidence: p.score ?? 0, doubts: [], added: { kind, score: p.score ?? 0, how: p.how ?? "" },
    });
    withheld.push(false); hidden.push(false);
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    added++;
  }
  return { doors: out, withheld, hidden, added, rescued, setAside, byKind };
}
