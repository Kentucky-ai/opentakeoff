// The door-detector worker's logic (lib/doorDetect/workerCore.ts) with fake
// fetch, cache and runtime: the model is downloaded only when allowed,
// checked against its pinned length and sha256, cached, and never started
// without WebGPU. And what the Doors suite does with doors the detector adds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createDetectCore, cacheNameFor, CACHE_KEY, type DetectCoreDeps, type SessionLike } from "../src/lib/doorDetect/workerCore.ts";
import { DOOR_DETECT_SETTINGS as S } from "../src/lib/doorDetect/pipeline.ts";
import { buildDoorSuite, countMarkPoints, doorCenter, estimateGroups, matchDoorTags } from "../src/lib/doorSuite.ts";
import type { ReadDoor } from "../src/lib/doorReader.ts";

const MODEL = new Uint8Array(1000).map((_, i) => i % 251);
const SHA = createHash("sha256").update(MODEL).digest("hex");
const spec = { url: "https://example.test/model.onnx", bytes: MODEL.length, sha256: SHA, nClasses: 8 };

function rig(over: Partial<DetectCoreDeps> = {}, body: Uint8Array = MODEL) {
  const posted: Array<Record<string, unknown>> = [];
  const store = new Map<string, Map<string, ArrayBuffer>>();
  let fetches = 0, sessions = 0;
  const session: SessionLike = {
    run: async () => ({
      dets: { data: Float32Array.from([0.5, 0.5, 0.1, 0.1, 0.2, 0.2, 0.1, 0.1]), dims: [1, 2, 4] },
      labels: { data: Float32Array.from([3, -9, -9, -9, -9, -9, -9, -9, -9, -9, -9, -9, -9, -9, -9, 2, -9, 5]), dims: [1, 2, 9] },
    }),
  };
  const deps: DetectCoreDeps = {
    fetchImpl: async () => { fetches++; return new Response(body.slice().buffer as ArrayBuffer); },
    cacheStorage: {
      open: async (name) => {
        const m = store.get(name) ?? new Map<string, ArrayBuffer>();
        store.set(name, m);
        return { match: async (k) => (m.has(k) ? new Response(m.get(k)!.slice(0)) : undefined), put: async (k, r) => { m.set(k, await r.arrayBuffer()); } };
      },
      keys: async () => [...store.keys()],
      delete: async (n) => store.delete(n),
    },
    hasWebGpu: async () => true,
    createSession: async () => { sessions++; return session; },
    makeTensor: (data, dims) => ({ data, dims }),
    post: (m) => posted.push(m as Record<string, unknown>),
    ...over,
  };
  const core = createDetectCore(deps, spec, S.detect);
  return { core, posted, store, counts: () => ({ fetches, sessions }) };
}

test("worker: the model is not downloaded until the person allows it", async () => {
  const r = rig();
  await r.core.handle({ type: "init", allowNetwork: false });
  assert.deepEqual(r.posted.map((m) => [m.type, m.code]), [["error", "consent-required"]]);
  assert.equal(r.counts().fetches, 0);
});

test("worker: allowed, it downloads once, checks, caches; the next start needs no network", async () => {
  const r = rig();
  r.store.set("opentakeoff-door-detector-oldoldoldoldoldo", new Map());
  await r.core.handle({ type: "init", allowNetwork: true });
  const last = r.posted[r.posted.length - 1];
  assert.deepEqual([last.type, last.cached], ["ready", false]);
  assert.ok(r.posted.some((m) => m.type === "progress" && m.loaded === MODEL.length && m.total === MODEL.length));
  assert.equal(r.store.get(cacheNameFor(SHA))!.get(CACHE_KEY)!.byteLength, MODEL.length);
  await new Promise((res) => setTimeout(res, 5));
  assert.deepEqual([...r.store.keys()], [cacheNameFor(SHA)], "an older model's cache is dropped");
  // a second core (another visit) finds it in the cache
  const posted2: Array<Record<string, unknown>> = [];
  const again = createDetectCore({
    fetchImpl: async () => { throw new Error("no network"); }, cacheStorage: { open: async (n) => { const m = r.store.get(n)!; return { match: async (k) => (m.has(k) ? new Response(m.get(k)!.slice(0)) : undefined), put: async () => {} }; } },
    hasWebGpu: async () => true, createSession: async () => ({ run: async () => ({}) }), makeTensor: (d, dims) => ({ d, dims }), post: (m) => posted2.push(m as Record<string, unknown>),
  }, spec, S.detect);
  await again.handle({ type: "init", allowNetwork: false });
  assert.deepEqual([posted2[0].type, posted2[0].cached], ["ready", true]);
});

test("worker: a file that is not the pinned model is refused and not cached", async () => {
  const bad = Uint8Array.from(MODEL); bad[10] ^= 1;
  const r = rig({}, bad);
  await r.core.handle({ type: "init", allowNetwork: true });
  assert.equal(r.posted[r.posted.length - 1].code, "integrity");
  assert.equal(r.store.get(cacheNameFor(SHA))?.has(CACHE_KEY) ?? false, false);
  assert.equal(r.counts().sessions, 0);
  const short = rig({}, MODEL.slice(0, 500));
  await short.core.handle({ type: "init", allowNetwork: true });
  assert.equal(short.posted[short.posted.length - 1].code, "integrity");
});

test("worker: no WebGPU, no download and no model", async () => {
  const r = rig({ hasWebGpu: async () => false });
  await r.core.handle({ type: "init", allowNetwork: true });
  assert.equal(r.posted[0].code, "no-webgpu");
  assert.deepEqual(r.counts(), { fetches: 0, sessions: 0 });
});

test("worker: a tile's boxes come back in page-render pixels; a tile before the model is an error", async () => {
  const r = rig();
  await r.core.handle({ type: "tile", id: 1, px: new Uint8Array(640 * 640).fill(255), x: 0, y: 0 });
  assert.equal(r.posted[0].code, "not-ready");
  await r.core.handle({ type: "init", allowNetwork: true });
  await r.core.handle({ type: "tile", id: 2, px: new Uint8Array(640 * 640).fill(255), x: 480, y: 960 });
  const m = r.posted[r.posted.length - 1] as { type: string; id: number; boxes: number[][] };
  assert.equal(m.type, "boxes");
  // query 0 class 0 (logit 3) and query 1 class 6 (logit 2); the extra ninth column (logit 5) is ignored
  assert.deepEqual(m.boxes.map((b) => b[5]), [0, 6]);
  assert.deepEqual(m.boxes[0].slice(0, 4).map(Math.round), [480 + 288, 960 + 288, 480 + 352, 960 + 352]);
});

const leaf = (x: number, y: number, r = 27) => ({ hinge: [x, y] as [number, number], tip: [x, y - r] as [number, number], radiusPt: r, sweepDeg: 90, drawn: "curve" as const, misfitPt: 0, jambFt: 0.5, strike: true, leaf: "drawn" as const });
const door = (x: number, y: number): ReadDoor => ({ box: [x, y - 27, x + 27, y], jambLine: [[x, y], [x + 27, y]], pair: false, stall: false, dashed: false, leaves: [leaf(x, y)], confidence: 1, doubts: [] });
const cased = (x: number, y: number): ReadDoor => ({ box: [x, y - 3, x + 36, y + 3], jambLine: [[x, y], [x + 36, y]], pair: false, stall: false, dashed: false, leaves: [], confidence: 0.8, doubts: [], added: { kind: "opening", score: 0.8, how: "" } });

test("suite: a cased opening the detector added is an opening and a frame with no door leaf", () => {
  const doors = [door(100, 100), cased(300, 100), door(500, 100)];
  const v = buildDoorSuite({ doors, withheld: [false, false, false], hidden: [false, false, true], marks: [null, null, null], schedule: null, sets: [], answers: {}, sheetLabel: "A101", fpp: 1 / 9 });
  assert.deepEqual(v.counts.openings, 2);
  assert.deepEqual(v.counts.leaves, 1);
  assert.equal(v.openings[1].leaves, 0);
  assert.equal(v.openings[1].added, "opening");
  assert.equal(v.openings[1].drawnFt, 4);
  assert.deepEqual([v.openings[2].hidden, v.openings[2].leftOut], [true, true]);
  assert.equal(v.questions.length, 0, "a hidden door asks nothing");
  const g = estimateGroups(v.openings);
  assert.deepEqual(g.map((x) => [x.type, x.openings.length, x.leaves]), [["Single", 1, 1], ["Cased opening", 1, 0]]);
});

test("suite: a door with no swing still has a centre, a reach and count marks on its opening line", () => {
  const d = cased(300, 100);
  assert.deepEqual(doorCenter(d), { x: 318, y: 100, r: 36 });
  const pts = countMarkPoints(d);
  assert.deepEqual(pts.frame, [318, 100]);
  assert.deepEqual(pts.hardware, [309, 100]);
  assert.equal(pts.leaves.length, 1);
});

test("suite: a hidden second find takes no tag from the door that is shown", () => {
  const doors = [door(100, 100), door(104, 100)];
  const runs = [{ str: "101", x: 100, y: 110, w: 14, h: 8 }];
  assert.deepEqual(matchDoorTags(doors, runs, new Set(["101"]), { skip: [true, false] }).marks, [null, "101"]);
});
