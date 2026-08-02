// THE PARITY PROOF (RFC #60 / PR #179) — the MCP server's one_click measures
// what the canvas measures, judged against the bench corpus's own pinned
// goldens rather than against a copy of the engine's output.
//
// Why this test exists: this server used to run the raw floodRegion on
// scale-unpinned masks while the canvas ran floodRegionSealed with feet-true
// arguments derived from the sheet scale (seal radii up to a door width,
// door-swing wedges, the minimum-passage rule). Two surfaces, one
// origin.method ("one_click_v1"), DIFFERENT square footage — measured on the
// VA finish plan as mean IoU 0.817 vs 0.999 against these same goldens, with
// 16.6% of the sheet's proposed floor double-counted through unsealed
// doorways (issue #184 round 9, the batch-parity fix's numbers). The session
// now floods through floodAtSeed — the ONE entry point every non-canvas
// surface shares (web/src/lib/detectRooms.ts) — on masks built with
// buildMask's full scale-pinned signature, and this test is what keeps it
// there.
//
// The answer key is web/bench/corpus/va-finish-plan.json, read directly: the
// same seeds, the same golden rings, the same real plan
// (demo/sample-finish-plan.pdf), the same scale (image px at render scale 2 —
// the MCP session's native space, so corpus seeds ARE one_click coordinates).
// The tolerance is the corpus's own per-room ABSOLUTE gate
// (bench/run.mts THRESHOLDS.maxRoomSfAbs = 1.0 SF; actual engine divergence
// from these pins is ≤ 0.05 SF) — deliberately NOT a relative band, which
// goes blind on large rooms. If a probe cannot reach parity, this test fails
// loudly; loosening the assertion is never the fix.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Session } from "../src/session.ts";
import { ringArea, type Point } from "../../web/src/lib/oneclick.ts";

const CORPUS = fileURLToPath(new URL("../../web/bench/corpus/va-finish-plan.json", import.meta.url));

/** bench/run.mts THRESHOLDS.maxRoomSfAbs — the corpus's per-room gate. */
const MAX_ROOM_SF_ABS = 1.0;

/** Three probes spanning the engine's sealed features on the real plan:
 *  a door-swing room, a dense-hatch toilet room, and the vestibule whose
 *  measurement EXISTS because of the minimum-passage rule (its verbatim
 *  flood conjoins the ward room through two open door leaves). */
const PROBES = ["patient-room-137", "patient-toilet-137a", "ward-vestibule"];

interface CorpusProbe { name: string; seed: Point; expect: string; golden?: Point[]; tags?: string[] }

test("one_click parity: three VA probes match the bench corpus's pinned goldens within the corpus's own per-room gate", async () => {
  const c = JSON.parse(readFileSync(CORPUS, "utf8")) as {
    pdf: string; scale: number; ptPerFt: number; probes: CorpusProbe[];
  };
  // corpus coordinates are image px at this render scale; the session speaks
  // image px at RENDER_SCALE 2.0 — if the corpus ever re-pins at another
  // scale this test must transform, not silently mis-seed
  assert.equal(c.scale, 2, "corpus pins image px at the MCP session's native render scale");

  const pdf = path.resolve(path.dirname(CORPUS), c.pdf);
  const key = path.basename(pdf);
  const s = new Session();
  await s.loadPlan(pdf);
  // the corpus's own scale, stated as upp (real ft per image px) — no
  // dependence on the title-block detector agreeing with the pin
  s.setScale(key, { upp: 1 / c.ptPerFt });

  for (const name of PROBES) {
    const p = c.probes.find((x) => x.name === name);
    assert.ok(p?.golden && p.golden.length >= 3, `corpus carries golden probe ${name}`);
    const goldenSF = Math.abs(ringArea(p.golden)) / (c.ptPerFt * c.ptPerFt);
    const r = (await s.oneClick(key, p.seed[0], p.seed[1], { role: "floor_area", returnVerts: false })) as Record<string, unknown>;
    const area = r.area_sf as number;
    assert.ok(typeof area === "number" && area > 0, `${name}: traced with real quantities`);
    assert.ok(
      Math.abs(area - goldenSF) <= MAX_ROOM_SF_ABS,
      `${name}: mcp ${area} SF vs corpus golden ${goldenSF.toFixed(2)} SF — off by ${(area - goldenSF).toFixed(2)} SF, over the corpus's ${MAX_ROOM_SF_ABS} SF per-room gate. Do NOT loosen this: the engine wiring has drifted from the canvas.`,
    );
    // the engine account rides the reply (RFC #60 item D): a scored trace,
    // never a bare number
    const conf = r.confidence as number;
    assert.ok(typeof conf === "number" && conf > 0 && conf <= 1, `${name}: confidence rides the reply (got ${String(conf)})`);
    if (p.tags?.includes("door-swing")) {
      assert.ok((r.door_wedges as number) >= 1, `${name}: the corpus tags this probe door-swing — the sealed engine's wedge inclusion must have run (door_wedges absent means the raw flood is back)`);
    }
  }

  // ward-vestibule is the sharpest parity witness: WITHOUT the feet-true
  // minimum-passage rule its flood conjoins the ward room through two open
  // door leaves and measures the pair as one space — the exact double-count
  // class the sealed wiring removes. The engine must both run the rule and
  // say so.
  const wv = c.probes.find((x) => x.name === "ward-vestibule")!;
  const r = (await s.oneClick(key, wv.seed[0], wv.seed[1], { role: "floor_area", returnVerts: false })) as Record<string, unknown>;
  assert.ok((r.min_pass_delta as number) > 0, "ward-vestibule: the minimum-passage rule changed the answer and disclosed it (min_pass_delta)");
  assert.ok((r.confidence_factors as string[]).some((f) => f.startsWith("min-passage-rule")), "…and the factor names it");
});
