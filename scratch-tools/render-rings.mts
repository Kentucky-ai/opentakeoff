// Render detected rings over the demo sheet — see the junk, not guess at it.
import { createCanvas, loadImage } from "@napi-rs/canvas";
import fs from "node:fs";
import { openPdf, OPS, positionedText } from "/Users/sfgprecon/dev/opentakeoff/mcp/src/pdf.ts";
import { detectScale } from "/Users/sfgprecon/dev/ot-worktrees/polygonize/web/src/lib/sheets.ts";
import { extractVectorGeometry, buildMask, MASK_MAX_DIM, HATCH_MAX_PITCH_FT } from "/Users/sfgprecon/dev/ot-worktrees/polygonize/web/src/lib/oneclick.ts";
import { hardWallSegments, detectAllRoomsDetailed } from "/Users/sfgprecon/dev/ot-worktrees/polygonize/web/src/lib/polygonize.ts";
import { roomLabelSeeds } from "/Users/sfgprecon/dev/ot-worktrees/polygonize/web/src/lib/detectRooms.ts";

const doc = await openPdf("/Users/sfgprecon/dev/opentakeoff/web/public/demo/sample-finish-plan.pdf");
const ph = await doc.page(1);
const geom = extractVectorGeometry(await ph.operatorList(), ph.viewport.transform, OPS);
const det = detectScale(ph.textContent, ph.viewport) as any;
const pxPerFt = det?.upp ? 1 / det.upp : 0;
const mo: any = buildMask(geom.segs, ph.viewport.width, ph.viewport.height, MASK_MAX_DIM, geom.meta, pxPerFt, 0, null, null);
const hard = hardWallSegments(geom, mo.ws, pxPerFt > 0 ? Math.max(HATCH_MAX_PITCH_FT, 2.25) * pxPerFt * mo.ws : undefined, pxPerFt);
const seeds = roomLabelSeeds(positionedText(ph));
const { rooms } = detectAllRoomsDetailed(hard, { pxPerFt, minAreaSf: 25, labelPts: seeds.map((s) => s.seed) });
console.log("rendering", rooms.length, "rooms");
const scale = 0.35;
const png = await ph.renderPng(2 * scale);   // RENDER_SCALE=2 baseline
const img = await loadImage(Buffer.from(png));
const cv = createCanvas(img.width, img.height);
const ctx = cv.getContext("2d");
ctx.drawImage(img, 0, 0);
for (const r of rooms) {
  const big = r.suspectOuter;
  ctx.beginPath();
  r.ring.forEach(([x, y], i) => { const px = x * scale, py = y * scale; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
  ctx.closePath();
  ctx.fillStyle = big ? "rgba(220,40,40,0.10)" : r.labels?.length ? "rgba(30,120,240,0.25)" : r.healed ? "rgba(230,150,20,0.30)" : "rgba(40,180,90,0.30)";
  ctx.fill();
  ctx.strokeStyle = big ? "#dc2828" : r.labels?.length ? "#1e78f0" : r.healed ? "#e69614" : "#28b45a";
  ctx.lineWidth = big ? 3 : 1.5;
  ctx.stroke();
}
fs.writeFileSync("/private/tmp/claude-501/-Users-sfgprecon/9d660fb1-f966-4c00-aaa2-af54628635b7/scratchpad/rings.png", cv.toBuffer("image/png"));
console.log("done");
