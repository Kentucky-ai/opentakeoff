// Whole-floor detection dry-run on the bundled demo plan (real medical-center
// finish plan) — same inputs the canvas harness feeds: extractVectorGeometry →
// buildMask (for ws) → hardWallSegments(feet-true pitch cap) → detectAllRooms.
import { openPdf, OPS, positionedText } from "/Users/sfgprecon/dev/opentakeoff/mcp/src/pdf.ts";
import { detectScale } from "/Users/sfgprecon/dev/ot-worktrees/polygonize/web/src/lib/sheets.ts";
import { extractVectorGeometry, buildMask, MASK_MAX_DIM, HATCH_MAX_PITCH_FT } from "/Users/sfgprecon/dev/ot-worktrees/polygonize/web/src/lib/oneclick.ts";
import { hardWallSegments, detectAllRooms, detectAllRoomsDetailed } from "/Users/sfgprecon/dev/ot-worktrees/polygonize/web/src/lib/polygonize.ts";
import { roomLabelSeeds } from "/Users/sfgprecon/dev/ot-worktrees/polygonize/web/src/lib/detectRooms.ts";

const doc = await openPdf("/Users/sfgprecon/dev/opentakeoff/web/public/demo/sample-finish-plan.pdf");
const ph = await doc.page(1);
const ol = await ph.operatorList();
const geom = extractVectorGeometry(ol, ph.viewport.transform, OPS);
const det = detectScale(ph.textContent, ph.viewport);
const upp = det && (det as any).upp ? (det as any).upp : 0;    // ft per image px
const pxPerFt = upp ? 1 / upp : 0;
console.log(`sheet: ${Math.round(ph.viewport.width)}×${Math.round(ph.viewport.height)} px · segs ${geom.segs.length >> 2} · scale ${det ? (det as any).label : "UNKNOWN"} (pxPerFt ${pxPerFt.toFixed(2)})`);

const mo = buildMask(geom.segs, ph.viewport.width, ph.viewport.height, MASK_MAX_DIM, geom.meta, pxPerFt, 0, null, null);
const t0 = performance.now();
const wallInfo: any = {};
const hard = hardWallSegments(geom, (mo as any).ws, pxPerFt > 0 ? HATCH_MAX_PITCH_FT * pxPerFt * (mo as any).ws : undefined);
const tHard = performance.now();
const seedList = roomLabelSeeds(positionedText(ph));
const { rooms, culled } = detectAllRoomsDetailed(hard, { pxPerFt, minAreaSf: 8, labelPts: seedList.map((s: any) => s.seed) });
const t1 = performance.now();
console.log(`culled: ${culled.tags} tags · ${culled.floaters} floaters (islands/outside-anchor)`);
const named = rooms.filter((r) => r.labels?.length === 1).length;
const merged = rooms.filter((r) => (r.labels?.length ?? 0) > 1).length;
console.log(`named rooms ${named} · multi-tag (merged spaces) ${merged} · unlabeled ${rooms.length - named - merged}`);

const sf = (px2: number) => (pxPerFt > 0 ? px2 / (pxPerFt * pxPerFt) : px2);
const healed = rooms.filter((r) => r.healed).length;
const suspect = rooms.filter((r) => r.suspectOuter).length;
const areas = rooms.map((r) => sf(r.areaPx)).sort((a, b) => b - a);
const total = areas.reduce((s, a) => s + a, 0);
console.log(`mode ${wallInfo.mode} (coverage ${(wallInfo.coverage*100).toFixed(0)}%)`);
console.log(`hard segs ${hard.length >> 2}/${geom.segs.length >> 2} (${Math.round(tHard - t0)}ms classify) · rooms ${rooms.length} in ${Math.round(t1 - tHard)}ms (total ${Math.round(t1 - t0)}ms)`);
console.log(`healed ${healed} · suspectOuter ${suspect} · total ${Math.round(total)} SF`);
console.log(`largest 10 (SF): ${areas.slice(0, 10).map((a) => Math.round(a)).join(", ")}`);
console.log(`smallest 10 (SF): ${areas.slice(-10).map((a) => a.toFixed(1)).join(", ")}`);
// reference: how many rooms today's label-seeded batch path would even attempt
const seeds = roomLabelSeeds(positionedText(ph));
console.log(`room-number labels on sheet (detectRooms ceiling): ${seeds.length}`);

// distribution + threshold sensitivity
const buckets: [string, number][] = [["4-10 SF", 0], ["10-25 SF", 0], ["25-60 SF", 0], ["60-150 SF", 0], ["150-500 SF", 0], ["500+ SF", 0]];
for (const a of areas) {
  if (a < 10) buckets[0][1]++; else if (a < 25) buckets[1][1]++; else if (a < 60) buckets[2][1]++;
  else if (a < 150) buckets[3][1]++; else if (a < 500) buckets[4][1]++; else buckets[5][1]++;
}
console.log("distribution: " + buckets.map(([l, n]) => `${l}: ${n}`).join(" · "));
for (const minSf of [10, 15, 25]) {
  const r2 = detectAllRooms(hard, { pxPerFt, minAreaSf: minSf });
  console.log(`minAreaSf ${minSf}: ${r2.length} rooms, ${r2.filter((r) => r.healed).length} healed`);
}

// debug: who holds the tags, and where do the biggest faces sit?
const inRing = (x: number, y: number, ring: [number, number][]) => {
  let ins = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
};
const pts = seedList.map((s: any) => s.seed);
const counts = rooms.map((r) => pts.filter(([x, y]: any) => inRing(x, y, r.ring as any)).length);
const top = rooms.map((r, i) => ({ i, sf: Math.round(sf(r.areaPx)), tags: counts[i], so: r.suspectOuter }))
  .sort((a, b) => b.tags - a.tags).slice(0, 6);
console.log("top tag-holders:", JSON.stringify(top));
const bb = (r: any) => { const xs = r.ring.map((p: any) => p[0]), ys = r.ring.map((p: any) => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(Math.round); };
console.log("flagged faces bbox:", rooms.filter((r) => r.suspectOuter).map((r) => `${Math.round(sf(r.areaPx))}SF @ ${bb(r)}`));
console.log("unbound tags:", pts.filter(([x, y]: any) => !rooms.some((r) => inRing(x, y, r.ring as any))).length, "of", pts.length);
