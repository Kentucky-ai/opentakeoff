// The door reader, from TypeScript: hand it a page's paths (doorVectors.ts),
// get back every door swing drawn on the page.
//
// The reader itself is Rust compiled to WebAssembly (engine/door-reader). The
// built module ships inside this repo as doorReaderWasm.ts (base64), so the
// app and the MCP server run it with no Rust toolchain; `npm run
// build:door-reader` rebuilds it from source and `npm run check:door-reader`
// proves the committed bytes are what the source builds to.
import { DOOR_READER_WASM_BASE64 } from "./doorReaderWasm.ts";
import { ITEM_F64, PATH_F64, type DoorVectors } from "./doorVectors.ts";

export interface DoorLeaf {
  hinge: [number, number];
  /** leaf length = swing radius, page points */
  radiusPt: number;
  /** far end of the leaf as drawn (for a leafless swing: the open end of its arc) */
  tip: [number, number];
  /** how the swing's arc is drawn */
  drawn: "curve" | "polyline" | "strokes" | "coarse";
  sweepDeg: number;
  /** mean distance of the arc's points off its circle, page points */
  misfitPt: number;
  /** wall thickness behind the hinge, feet; null = no wall found */
  jambFt: number | null;
  /** a wall runs on from the swing's closed end (the strike jamb) */
  strike: boolean;
  /** drawn leaf, dashed leaf, none (a quarter arc across an opening) or part-open */
  leaf: "drawn" | "dashed" | "none" | "part-open";
}

export interface ReadDoor {
  /** x0, y0, x1, y1 in page points (the frame the vectors were extracted in) */
  box: [number, number, number, number];
  /** two leaves hung in one opening */
  pair: boolean;
  /** a toilet-partition stall door (Division 10, never the door schedule's) */
  stall: boolean;
  /** drawn dashed: existing, or to be removed */
  dashed: boolean;
  leaves: DoorLeaf[];
  /** 1 minus the weights of the doubts below (engine/door-reader/src/confidence.rs) */
  confidence: number;
  /** what lowers it, in words: the reasons a withheld door was held back */
  doubts: string[];
}

/** The doubts the reader can raise, in its bit order (confidence.rs DOUBTS). */
export const DOOR_DOUBTS = [
  "arc drawn as a polyline", "arc drawn unlike the page's other swings", "arc off its circle", "no leaf drawn", "dashed leaf", "leaf under 2 ft",
  "leaf over 3'-7\"", "jamb under 3 in", "no wall at the hinge", "no wall past the strike", "toilet-partition stall", "swing of 60 to 80 degrees",
  "drawn dashed", "unlike the page's swings, one of 10+ alike", "under 2 ft, one of 10+ alike", "over 3'-7\", one of 10+ alike",
] as const;

/** Confidence cutoffs, chosen on development sheets and frozen with the reader. A door at or above the cutoff is committed; the rest are withheld. */
export const DOOR_CUTOFFS = { foundFirst: 0.0, balanced: 0.3, precisionFirst: 0.55 };

/** Committed doors (counted) and withheld ones (listed with their reasons), at a confidence cutoff. */
export function splitDoors(r: DoorReading, cutoff = DOOR_CUTOFFS.foundFirst): { committed: ReadDoor[]; withheld: ReadDoor[] } {
  const committed: ReadDoor[] = [], withheld: ReadDoor[] = [];
  for (const d of r.doors) (d.confidence >= cutoff - 1e-9 ? committed : withheld).push(d);
  return { committed, withheld };
}

export interface DoorReading {
  doors: ReadDoor[];
  /** feet per page point the doors were read at */
  fpp: number | null;
  /** given = the caller's scale; arcs = read from the swings themselves (most doors are 3 ft) */
  scaleSource: "none" | "given" | "arcs";
  /** arcs read on the page, door or not */
  arcs: number;
}

interface Exports {
  memory: WebAssembly.Memory;
  dr_alloc(n: number): number;
  dr_free(ptr: number, n: number): void;
  dr_read(items: number, nItems: number, paths: number, nPaths: number, fpp: number): number;
  dr_out_ptr(): number;
}

const HEAD_F64 = 4, LEAF_F64 = 11, DOOR_F64 = 10 + 2 * LEAF_F64;
const DRAWN = ["curve", "polyline", "strokes", "coarse"] as const;
const LEAF = ["drawn", "dashed", "none", "part-open"] as const;
let ready: Promise<Exports> | null = null;
let loaded: Exports | null = null;

function wasmBytes(): Uint8Array {
  const bin = atob(DOOR_READER_WASM_BASE64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Compile and instantiate the reader once (async: browsers refuse large synchronous compiles). */
export function loadDoorReader(): Promise<Exports> {
  if (!ready) {
    const bytes = wasmBytes();
    ready = (WebAssembly.instantiate(bytes.buffer as ArrayBuffer, {}) as Promise<WebAssembly.WebAssemblyInstantiatedSource>).then((r) => {
      loaded = r.instance.exports as unknown as Exports;
      return loaded;
    });
  }
  return ready;
}

function run(x: Exports, v: DoorVectors, fpp: number | null | undefined): DoorReading {
  const nI = v.nItems * ITEM_F64, nP = v.nPaths * PATH_F64;
  const pi = x.dr_alloc(nI), pp = x.dr_alloc(nP);
  try {
    // views made after both allocations: a grown memory detaches older ones
    new Float64Array(x.memory.buffer, pi, nI).set(v.items.subarray(0, nI));
    new Float64Array(x.memory.buffer, pp, nP).set(v.paths.subarray(0, nP));
    const n = x.dr_read(pi, v.nItems, pp, v.nPaths, fpp && fpp > 0 ? fpp : NaN);
    const o = new Float64Array(x.memory.buffer, x.dr_out_ptr(), n).slice();
    const doors: ReadDoor[] = [];
    for (let k = 0; k < o[0]; k++) {
      const b = HEAD_F64 + k * DOOR_F64;
      const leaves: DoorLeaf[] = [];
      for (let l = 0; l < o[b + 7]; l++) {
        const q = b + 10 + l * LEAF_F64;
        leaves.push({
          hinge: [o[q], o[q + 1]], radiusPt: o[q + 2], tip: [o[q + 3], o[q + 4]], drawn: DRAWN[o[q + 5]], sweepDeg: o[q + 6], misfitPt: o[q + 7],
          jambFt: Number.isFinite(o[q + 8]) ? o[q + 8] : null, strike: o[q + 9] === 1, leaf: LEAF[o[q + 10]],
        });
      }
      const bits = o[b + 9];
      doors.push({
        box: [o[b], o[b + 1], o[b + 2], o[b + 3]], pair: o[b + 4] === 1, stall: o[b + 5] === 1, dashed: o[b + 6] === 1, leaves,
        confidence: Math.round(o[b + 8] * 1e6) / 1e6, doubts: DOOR_DOUBTS.filter((_, k) => (bits >> k) & 1),
      });
    }
    return { doors, fpp: Number.isFinite(o[1]) ? o[1] : null, scaleSource: o[2] === 1 ? "given" : o[2] === 2 ? "arcs" : "none", arcs: o[3] };
  } finally {
    x.dr_free(pi, nI);
    x.dr_free(pp, nP);
  }
}

/** Every door on the page. `fpp`: feet per page point at the sheet's scale, when known (else read from the swings). */
export async function readDoors(v: DoorVectors, fpp?: number | null): Promise<DoorReading> {
  return run(await loadDoorReader(), v, fpp);
}

/** Same, synchronously, once loadDoorReader() has resolved. */
export function readDoorsSync(v: DoorVectors, fpp?: number | null): DoorReading {
  if (!loaded) throw new Error("door reader not loaded: await loadDoorReader() first");
  return run(loaded, v, fpp);
}
