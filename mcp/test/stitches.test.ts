import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtemp, copyFile, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../server.ts";
import { Session } from "../src/session.ts";

const SAMPLE_PLAN = fileURLToPath(new URL("../../demo/sample-plan.pdf", import.meta.url));
const SAMPLE_FINISH_PLAN = fileURLToPath(new URL("../../demo/sample-finish-plan.pdf", import.meta.url));

async function pair() {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = buildServer(new Session(), { oneClick: true });
  await server.connect(st);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(ct);
  return client;
}

interface Reply { isError: boolean; data: any }
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Reply> {
  const res: any = await client.callTool({ name, arguments: args });
  assert.ok(Array.isArray(res.content) && res.content.length >= 1, `${name}: has content`);
  const textItem = res.content.find((c: any) => c.type === "text");
  const imageItem = res.content.find((c: any) => c.type === "image");
  let data: any = {};
  if (textItem) {
    try {
      data = JSON.parse(textItem.text);
    } catch {
      data = { error: textItem.text };
    }
  }
  if (imageItem) {
    data.has_image = true;
    data.image_data = imageItem.data;
  }
  return { isError: !!res.isError, data };
}

async function setupTwoSheets() {
  const dir = await mkdtemp(path.join(tmpdir(), "opentakeoff-stitch-test-"));
  const p1 = path.join(dir, "plan-west.pdf");
  const p2 = path.join(dir, "plan-east.pdf");
  await copyFile(SAMPLE_PLAN, p1);
  await copyFile(SAMPLE_PLAN, p2);
  return { dir, p1, p2, k1: "plan-west.pdf", k2: "plan-east.pdf" };
}

/** Creates authentic split West and East plans from VA Dublin Bldg 9A floor plan.
 * Seam sits at x = 2900 px with 145 real wall lines crossing the match line. */
async function setupSplitFixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "opentakeoff-split-va-"));
  const srcBytes = await readFile(SAMPLE_FINISH_PLAN);
  const src = await PDFDocument.load(srcBytes);

  const west = await PDFDocument.create();
  const [pWest] = await west.copyPages(src, [0]);
  pWest.setCropBox(0, 0, 1700, 2160);
  pWest.setMediaBox(0, 0, 1700, 2160);
  west.addPage(pWest);
  const p1 = path.join(dir, "plan-west.pdf");
  await writeFile(p1, await west.save());

  const east = await PDFDocument.create();
  const [pEast] = await east.copyPages(src, [0]);
  pEast.setCropBox(1200, 0, 1824, 2160);
  pEast.setMediaBox(1200, 0, 1824, 2160);
  east.addPage(pEast);
  const p2 = path.join(dir, "plan-east.pdf");
  await writeFile(p2, await east.save());

  return { dir, p1, p2, k1: "plan-west.pdf", k2: "plan-east.pdf" };
}

test("stitch_sheets: input validation and scale matching", async () => {
  const client = await pair();
  // No plan loaded
  const noPlan = await call(client, "stitch_sheets", { sheets: ["a.pdf", "b.pdf"] });
  assert.equal(noPlan.isError, true);
  assert.match(noPlan.data.error, /No plan loaded/);

  const { p1, p2, k1, k2 } = await setupTwoSheets();
  await call(client, "load_plan", { path: p1 });
  await call(client, "load_plan", { path: p2, merge: true });

  // Less than 2 sheets (Zod schema rejects min(2))
  const oneSheet = await call(client, "stitch_sheets", { sheets: [k1] });
  assert.equal(oneSheet.isError, true);

  // Duplicate sheets
  const dup = await call(client, "stitch_sheets", { sheets: [k1, k1] });
  assert.equal(dup.isError, true);
  assert.match(dup.data.error, /unique/);

  // Unknown sheet
  const unknown = await call(client, "stitch_sheets", { sheets: [k1, "missing.pdf"] });
  assert.equal(unknown.isError, true);
  assert.match(unknown.data.error, /Unknown sheet/);

  // Uncalibrated sheets rejected with clear guidance
  const uncal = await call(client, "stitch_sheets", { sheets: [k1, k2] });
  assert.equal(uncal.isError, true);
  assert.match(uncal.data.error, /not calibrated|no calibrated scale/i);

  // Mismatched scales rejected with both scales reported
  await call(client, "set_scale", { sheet: k1, label: '1/4" = 1\'-0"' });
  await call(client, "set_scale", { sheet: k2, label: '1/8" = 1\'-0"' });
  const mismatch = await call(client, "stitch_sheets", { sheets: [k1, k2] });
  assert.equal(mismatch.isError, true);
  assert.match(mismatch.data.error, /Scale mismatch/);
  assert.match(mismatch.data.error, /1\/4/);
  assert.match(mismatch.data.error, /1\/8/);
});

test("stitch_sheets: creation, alignment, seam view, and measurement", async () => {
  const client = await pair();
  const { dir, p1, p2, k1, k2 } = await setupSplitFixture();
  await call(client, "load_plan", { path: p1 });
  await call(client, "load_plan", { path: p2, merge: true });

  // Calibrate both sheets to identical scale
  await call(client, "set_scale", { sheet: k1, label: '1/8" = 1\'-0"' });
  await call(client, "set_scale", { sheet: k2, label: '1/8" = 1\'-0"' });

  // West: width 3400. East: width 3648.
  const s1Info = await call(client, "sheet_info", { sheet: k1 });
  const w1 = s1Info.data.width_px;
  assert.equal(w1, 3400);

  // Stitch sheets (auto-butt)
  const res = await call(client, "stitch_sheets", {
    sheets: [k1, k2],
    name: "Floor Plan Overall",
  });
  assert.equal(res.isError, false);
  assert.ok(res.data.stitch_id.startsWith("stitch:"));
  assert.equal(res.data.name, "Floor Plan Overall");
  assert.equal(res.data.extent.width_px, 3400 + 3648);
  assert.equal(res.data.members.length, 2);
  assert.equal(res.data.aligned, false, "auto-butt starts with aligned: false");
  assert.ok(typeof res.data.scale.upp === "number");

  const stitchId = res.data.stitch_id;

  // Refuse measurement across seam on unaligned stitch
  const unalignedPoly = await call(client, "measure_polygon", {
    sheet: stitchId,
    verts: [
      [3300, 1500],
      [3500, 1500],
      [3500, 1600],
      [3300, 1600],
    ],
    condition: "CPT-1",
  });
  assert.equal(unalignedPoly.isError, true);
  assert.match(unalignedPoly.data.error, /unaligned stitch/);

  // Align the stitch with align_stitch:
  // Anchor on West: [2800, 1500].
  // Moving on East: East starts at dx=3400, feature is at local x=400 -> stitch coords [3800, 1500].
  const alignRes = await call(client, "align_stitch", {
    stitch: stitchId,
    anchor: [2800, 1500],
    moving: [3800, 1500],
  });
  assert.equal(alignRes.isError, false);
  assert.equal(alignRes.data.aligned, true);
  assert.equal(alignRes.data.seam_check.passed, true);
  assert.equal(alignRes.data.seam_check.max_in, 0);
  assert.ok(alignRes.data.seam_check.sample_count > 50, "has real verified wall linework samples");

  // Inspect existing composite panels via list_stitches
  const list = await call(client, "list_stitches");
  assert.equal(list.isError, false);
  assert.equal(list.data.stitches.length, 1);
  assert.equal(list.data.stitches[0].id, stitchId);
  assert.equal(list.data.stitches[0].aligned, true);

  // sheet_info on the stitch key: extent is 6048 px
  const stInfo = await call(client, "sheet_info", { sheet: stitchId });
  assert.equal(stInfo.isError, false);
  assert.equal(stInfo.data.width_px, 6048);
  assert.ok(stInfo.data.seg_count > 0, "has merged vector segments");

  // view_sheet succeeds on stitch composite, supports crop, overlay and grid
  const viewRes = await call(client, "view_sheet", {
    sheet: stitchId,
    region: { x0: 2700, y0: 1400, x1: 3100, y1: 1800 },
    grid: "1/8",
    overlay: true,
  });
  assert.equal(viewRes.isError, false);
  assert.equal(viewRes.data.has_image, true);
  assert.equal(viewRes.data.overlay, true);

  // Measure polygon across the stitch seam on aligned stitch: Room 170
  const poly = await call(client, "measure_polygon", {
    sheet: stitchId,
    verts: [
      [2800, 1550],
      [2920, 1550],
      [2920, 1630],
      [2800, 1630],
    ],
    condition: "CPT-1",
  });
  assert.equal(poly.isError, false);
  assert.ok(poly.data.area_sf > 0);

  // Export takeoff preserves stitch definitions
  const takeoffPath = path.join(dir, "takeoff.json");
  const exp = await call(client, "export_takeoff", { path: takeoffPath });
  assert.equal(exp.isError, false);
  assert.ok(Array.isArray(exp.data.stitches));
  assert.equal(exp.data.stitches.length, 1);
  assert.equal(exp.data.stitches[0].id, stitchId);
  assert.equal(exp.data.stitches[0].aligned, true);

  // Round-trip: import into fresh session
  const client2 = await pair();
  await call(client2, "load_plan", { path: p1 });
  await call(client2, "load_plan", { path: p2, merge: true });

  const imp = await call(client2, "import_takeoff", { path: takeoffPath });
  assert.equal(imp.isError, false);

  const listAfterImport = await call(client2, "list_stitches");
  assert.equal(listAfterImport.isError, false);
  assert.equal(listAfterImport.data.stitches.length, 1);
  assert.equal(listAfterImport.data.stitches[0].id, stitchId);
  assert.equal(listAfterImport.data.stitches[0].aligned, true);
});

test("stitch_sheets: offset tests catch 1\", 3\", 6\" misalignments", async () => {
  const client = await pair();
  const { p1, p2, k1, k2 } = await setupSplitFixture();
  await call(client, "load_plan", { path: p1 });
  await call(client, "load_plan", { path: p2, merge: true });

  await call(client, "set_scale", { sheet: k1, label: '1/8" = 1\'-0"' });
  await call(client, "set_scale", { sheet: k2, label: '1/8" = 1\'-0"' });

  // In 1/8" = 1'-0", 1 ft = 18 px, 1 in = 1.5 px
  const testCases = [
    { inches: 1, offsetPx: 1.5 },
    { inches: 3, offsetPx: 4.5 },
    { inches: 6, offsetPx: 9.0 },
  ];

  for (const tc of testCases) {
    const st = await call(client, "stitch_sheets", { sheets: [k1, k2] });
    assert.equal(st.isError, false);

    const aligned = await call(client, "align_stitch", {
      stitch: st.data.stitch_id,
      anchor: [2800, 1500],
      moving: [3800 + tc.offsetPx, 1500],
      tolerance_in: 0.5,
    });
    assert.equal(aligned.isError, false);
    assert.equal(aligned.data.aligned, true);
    assert.equal(aligned.data.seam_check.passed, false);
    assert.equal(aligned.data.seam_check.withheld, true);
    assert.ok(aligned.data.seam_check.max_in >= tc.inches * 0.9, `catches ${tc.inches}" displacement`);
    assert.ok(aligned.data.seam_check.discrepancies.length > 0);

    // Cross-seam measurement is refused on withheld stitch
    const refused = await call(client, "measure_polygon", {
      sheet: st.data.stitch_id,
      verts: [
        [2800, 1550],
        [2950, 1550],
        [2950, 1650],
        [2800, 1650],
      ],
      condition: "CPT-1",
    });
    assert.equal(refused.isError, true);
    assert.match(refused.data.error, /seam check withheld/);
  }
});

test("stitch_sheets: security bounds, cutout, and marked pdf export", async () => {
  const client = await pair();
  const { dir, p1, p2, k1, k2 } = await setupTwoSheets();
  await call(client, "load_plan", { path: p1 });
  await call(client, "load_plan", { path: p2, merge: true });

  await call(client, "set_scale", { sheet: k1, label: '1/4" = 1\'-0"' });
  await call(client, "set_scale", { sheet: k2, label: '1/4" = 1\'-0"' });

  // 1. Excessive offset rejected
  const badOffset = await call(client, "stitch_sheets", {
    sheets: [k1, k2],
    members: [
      { key: k1, dx: 0, dy: 0 },
      { key: k2, dx: 1e8, dy: 0 },
    ],
  });
  assert.equal(badOffset.isError, true);
  assert.match(badOffset.data.error, /excessive/);

  // 2. Non-finite align rejected
  const badAlign = await call(client, "stitch_sheets", {
    sheets: [k1, k2],
    align: {
      anchor: [NaN, 100],
      moving: [100, 100],
    },
  });
  assert.equal(badAlign.isError, true);
  assert.match(badAlign.data.error, /expected number|finite/);

  // 3. Valid stitch creation and alignment
  const s1Info = await call(client, "sheet_info", { sheet: k1 });
  const w1 = s1Info.data.width_px;

  const stitchRes = await call(client, "stitch_sheets", { sheets: [k1, k2] });
  assert.equal(stitchRes.isError, false);
  const stitchId = stitchRes.data.stitch_id;

  const alignRes = await call(client, "align_stitch", {
    stitch: stitchId,
    anchor: [w1 - 50, 100],
    moving: [w1 + 50, 100],
  });
  assert.equal(alignRes.isError, false);

  // 4. Measure polygon and cutout on stitch
  const poly = await call(client, "measure_polygon", {
    sheet: stitchId,
    verts: [[100, 100], [500, 100], [500, 500], [100, 500]],
    condition: "CPT-1",
  });
  assert.equal(poly.isError, false);
  const parentId = poly.data.shape_id;
  assert.ok(parentId);

  const cut = await call(client, "cut_out", {
    parent_shape_id: parentId,
    verts: [[200, 200], [300, 200], [300, 300], [200, 300]],
  });
  assert.equal(cut.isError, false);
  assert.ok(cut.data.hole_sf > 0);

  // 5. export_marked_pdf includes stitch composite sheet
  const markedPdfPath = path.join(dir, "marked-output.pdf");
  const expMarked = await call(client, "export_marked_pdf", { path: markedPdfPath });
  assert.equal(expMarked.isError, false);
  assert.ok(expMarked.data.pages >= 2);
  assert.ok(expMarked.data.sheets_marked >= 1);
  assert.ok(expMarked.data.shapes_drawn >= 1);

  // 6. Undo cutout
  const undo = await call(client, "undo_last", { n: 1 });
  assert.equal(undo.isError, false);
  assert.equal(undo.data.undone, 1);
});

test("stitch_sheets: imported stitch without aligned or seam_check refuses cross-seam measurement", async () => {
  const client = await pair();
  const { dir, p1, p2, k1, k2 } = await setupTwoSheets();
  await call(client, "load_plan", { path: p1 });
  await call(client, "load_plan", { path: p2, merge: true });
  await call(client, "set_scale", { sheet: k1, label: '1/4" = 1\'-0"' });
  await call(client, "set_scale", { sheet: k2, label: '1/4" = 1\'-0"' });

  const stitchRes = await call(client, "stitch_sheets", { sheets: [k1, k2] });
  assert.equal(stitchRes.isError, false);
  const stitchId = stitchRes.data.stitch_id;

  const takeoffPath = path.join(dir, "canvas-stitch.json");
  const exp = await call(client, "export_takeoff", { path: takeoffPath });
  assert.equal(exp.isError, false);
  const raw = JSON.parse(await readFile(takeoffPath, "utf8"));
  // Strip aligned and seam_check (as a canvas-authored takeoff JSON would lack them)
  delete raw.stitches[0].aligned;
  delete raw.stitches[0].seam_check;
  await writeFile(takeoffPath, JSON.stringify(raw, null, 2));

  const client2 = await pair();
  await call(client2, "load_plan", { path: p1 });
  await call(client2, "load_plan", { path: p2, merge: true });
  const imp = await call(client2, "import_takeoff", { path: takeoffPath });
  assert.equal(imp.isError, false);

  const s1Info = await call(client2, "sheet_info", { sheet: k1 });
  const w1 = s1Info.data.width_px;
  const crossSeam = await call(client2, "measure_polygon", {
    sheet: stitchId,
    verts: [[w1 - 50, 1500], [w1 + 50, 1500], [w1 + 50, 1600], [w1 - 50, 1600]],
    condition: "CPT-1",
  });
  assert.equal(crossSeam.isError, true);
  assert.match(crossSeam.data.error, /Align the stitch across match lines/);
});

test("stitch_sheets: seam gate enforced on edit_shape/revise_proposal, align_stitch verify-only + work guard, scale consistency, text/spans, and merge refresh", async () => {
  const client = await pair();
  const { dir, p1, p2, k1, k2 } = await setupSplitFixture();
  await call(client, "load_plan", { path: p1 });
  await call(client, "load_plan", { path: p2, merge: true });
  await call(client, "set_scale", { sheet: k1, label: '1/8" = 1\'-0"' });
  await call(client, "set_scale", { sheet: k2, label: '1/8" = 1\'-0"' });

  const unaligned = await call(client, "stitch_sheets", { sheets: [k1, k2], name: "VA Split" });
  assert.equal(unaligned.isError, false);
  const stitchId = unaligned.data.stitch_id;

  // Vertical (top/bottom) unaligned stitch allows single-member polygon straddling x = mid (no false vertical-seam block)
  const s1Info = await call(client, "sheet_info", { sheet: k1 });
  const w1 = s1Info.data.width_px;
  const h1 = s1Info.data.height_px;
  const vertUnaligned = await call(client, "stitch_sheets", {
    sheets: [k1, k2],
    members: [{ key: k1, dx: 0, dy: 0 }, { key: k2, dx: 0, dy: h1 }],
    name: "Top Bottom",
  });
  assert.equal(vertUnaligned.isError, false);
  const topPoly = await call(client, "measure_polygon", {
    sheet: vertUnaligned.data.stitch_id,
    verts: [[w1 / 2 - 40, 100], [w1 / 2 + 40, 100], [w1 / 2 + 40, 200], [w1 / 2 - 40, 200]],
    condition: "CPT-1",
  });
  assert.equal(topPoly.isError, false);

  // Measure a single-member shape on unaligned horizontal stitch, then try edit_shape across seam -> refused
  const leftPoly = await call(client, "measure_polygon", {
    sheet: stitchId,
    verts: [[100, 100], [200, 100], [200, 200], [100, 200]],
    condition: "CPT-1",
  });
  assert.equal(leftPoly.isError, false);
  const crossEdit = await call(client, "edit_shape", {
    shape_id: leftPoly.data.shape_id,
    verts: [[w1 - 50, 1500], [w1 + 50, 1500], [w1 + 50, 1600], [w1 - 50, 1600]],
  });
  assert.equal(crossEdit.isError, true);
  assert.match(crossEdit.data.error, /Align the stitch across match lines/);

  // revise_proposal crossing seam on unaligned stitch refuses atomically
  const prop = await call(client, "propose_takeoff", { label: "P1", rationale: "Test" });
  assert.equal(prop.isError, false);
  const rev = await call(client, "revise_proposal", {
    proposal_id: prop.data.proposal_id,
    shapes: [{
      sheet: stitchId,
      condition: "CPT-1",
      role: "floor_area",
      verts: [[w1 - 50, 1500], [w1 + 50, 1500], [w1 + 50, 1600], [w1 - 50, 1600]],
    }],
  });
  assert.equal(rev.isError, true);
  assert.match(rev.data.error, /Align the stitch across match lines/);

  // Realigning when shapes exist is refused, while verify-only align_stitch (no anchor/moving) is allowed
  const blockedRealign = await call(client, "align_stitch", {
    stitch: stitchId,
    anchor: [2900, 1000],
    moving: [3900, 1000],
  });
  assert.equal(blockedRealign.isError, true);
  assert.match(blockedRealign.data.error, /after shapes or annotations exist/);

  // Create clean correctly aligned stitch to test read_sheet_text, find_text, scale consistency, and verify-only
  const valid = await call(client, "stitch_sheets", {
    sheets: [k1, k2],
    members: [{ key: k1, dx: 0, dy: 0 }, { key: k2, dx: 2400, dy: 0 }],
    name: "Valid Align",
  });
  assert.equal(valid.isError, false);
  const vId = valid.data.stitch_id;

  const verifyOnly = await call(client, "align_stitch", { stitch: vId });
  assert.equal(verifyOnly.isError, false);
  assert.equal(verifyOnly.data.seam_check.passed, true);

  const compText = await call(client, "read_sheet_text", { sheet: vId });
  assert.equal(compText.isError, false);
  assert.ok(compText.data.items.length > 0);
  const sampleNeedle = compText.data.items.find((it: any) => String(it.str || "").trim().length >= 2)?.str.trim().slice(0, 4);
  assert.ok(sampleNeedle);
  const found = await call(client, "find_text", { q: sampleNeedle, sheet: vId });
  assert.equal(found.isError, false);
  assert.ok(found.data.hits.length >= 1);

  // Conflicting scale directly on composite is refused
  const badCompScale = await call(client, "set_scale", { sheet: vId, label: '1/4" = 1\'-0"' });
  assert.equal(badCompScale.isError, true);
  assert.match(badCompScale.data.error, /member sheet/);

  // Recalibrating member k1 invalidates composite scale & seam_check; recalibrating k2 restores composite scale
  const recal1 = await call(client, "set_scale", { sheet: k1, label: '1/4" = 1\'-0"' });
  assert.equal(recal1.isError, false);
  const listedMid = await call(client, "list_stitches");
  const stMid = listedMid.data.stitches.find((x: any) => x.id === vId);
  assert.equal(stMid.scale.upp, null);
  assert.equal(stMid.seam_check, undefined);

  const recal2 = await call(client, "set_scale", { sheet: k2, label: '1/4" = 1\'-0"' });
  assert.equal(recal2.isError, false);
  const listedSynced = await call(client, "list_stitches");
  const stSynced = listedSynced.data.stitches.find((x: any) => x.id === vId);
  assert.ok(stSynced.scale.upp > 0);
  assert.equal(stSynced.seam_check, undefined); // still requires re-verification at new scale

  // Export valid takeoff and verify partial-load + load_plan merge refresh + composite scale adoption
  const expPath = path.join(dir, "valid-stitch.json");
  await call(client, "export_takeoff", { path: expPath });

  const clientMerge = await pair();
  await call(clientMerge, "load_plan", { path: p1 });
  const impPartial = await call(clientMerge, "import_takeoff", { path: expPath });
  assert.equal(impPartial.isError, false);
  const beforeMergeList = await call(clientMerge, "list_stitches");
  const wPartial = beforeMergeList.data.stitches.find((x: any) => x.id === vId).extent.width_px;

  await call(clientMerge, "load_plan", { path: p2, merge: true });
  const afterMergeList = await call(clientMerge, "list_stitches");
  const stAfterMerge = afterMergeList.data.stitches.find((x: any) => x.id === vId);
  assert.ok(stAfterMerge.extent.width_px > wPartial);
  const verifyImported = await call(clientMerge, "align_stitch", { stitch: vId });
  assert.equal(verifyImported.isError, false);
  assert.equal(verifyImported.data.seam_check.passed, true);

  // Conflicting composite vs member scale in import_takeoff refuses cleanly without partial state
  const badExpPath = path.join(dir, "bad-scale-stitch.json");
  const badRaw = JSON.parse(await readFile(expPath, "utf8"));
  badRaw.sheets = badRaw.sheets.map((row: any) => (row.sheet_id === vId ? { ...row, units_per_px: 0.0999 } : row));
  await writeFile(badExpPath, JSON.stringify(badRaw, null, 2));
  const clientBad = await pair();
  await call(clientBad, "load_plan", { path: p1 });
  await call(clientBad, "load_plan", { path: p2, merge: true });
  const badImp = await call(clientBad, "import_takeoff", { path: badExpPath });
  assert.equal(badImp.isError, true);
  assert.match(badImp.data.error, /Import scale conflict on stitch/);
});

/** One three-page set: a filler page, then the West and East halves — so a
 * reorder moves both stitch members to different sheet keys. */
async function setupPagedSplitFixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "opentakeoff-stitch-pages-"));
  const src = await PDFDocument.load(await readFile(SAMPLE_FINISH_PLAN));
  const out = await PDFDocument.create();
  const [filler, west, east] = await out.copyPages(src, [1, 0, 0]);
  west.setCropBox(0, 0, 1700, 2160);
  west.setMediaBox(0, 0, 1700, 2160);
  east.setCropBox(1200, 0, 1824, 2160);
  east.setMediaBox(1200, 0, 1824, 2160);
  out.addPage(filler);
  out.addPage(west);
  out.addPage(east);
  const file = path.join(dir, "set.pdf");
  await writeFile(file, await out.save());
  return { dir, file, base: "set.pdf" };
}

test("page tools keep stitches on their pages: reorder remaps members, rotate is gated, extract/merge carry whole stitches only", async () => {
  const { dir, file, base } = await setupPagedSplitFixture();
  const upp = 0.027777777777777776;
  const session = new Session();
  await session.loadPlan(file);
  const west = `${base}#2`, east = `${base}#3`;
  session.setScale(west, { upp });
  session.setScale(east, { upp });

  const made = await session.stitchSheets({ sheets: [west, east], name: "Overall" });
  const id = made.stitch_id;
  const aligned = await session.alignStitch({ stitch: id, anchor: [2800, 1500], moving: [3800, 1500] });
  assert.equal(aligned.seam_check.passed, true);
  const poly = session.measurePolygon(id, [[2800, 1550], [2920, 1550], [2920, 1630], [2800, 1630]], { condition: "CPT-1", role: "floor_area" });
  const textCount = session.sheet(id).text.length;
  assert.ok(textCount > 0, "composite carries member text");

  // a member under a stitch that carries takeoff does not turn; neither does the composite
  await assert.rejects(session.rotatePage(west, 90, path.join(dir, "r.pdf")), /belongs to stitch/);
  await assert.rejects(session.rotatePage(id, 90, path.join(dir, "r.pdf")), /stitched composite/);

  // reorder: West and East move from pages 2,3 to pages 1,2
  await session.reorderPages(base, [2, 3, 1], path.join(dir, "reordered.pdf"));
  const st = session.stitch(id);
  assert.deepEqual(st.members.map((m) => m.key), [base, `${base}#2`], "members follow their pages");
  assert.equal(st.aligned, true);
  assert.equal(st.seam_check?.passed, true);
  const comp = session.sheet(id);
  assert.equal(comp.widthPx, 6048, "composite sheet survives the reorder with its extent");
  assert.equal(comp.text.length, textCount, "composite text is rebuilt from the same two pages");
  assert.equal(session.shapes.find((x) => x.id === poly.shape_id)!.sheet_id, id);
  assert.equal(session.listStitches().stitches[0].shape_count, 1);
  // the stitch still verifies against the pages it now names
  const again = await session.alignStitch({ stitch: id });
  assert.equal(again.seam_check.passed, true);
  assert.equal(again.seam_check.max_in, 0);

  // extract both members: the stitch and its shape ride along under the new keys
  const both = await session.extractPages(base, [1, 2], path.join(dir, "both.pdf"));
  const bothDoc = JSON.parse(await readFile(both.takeoff_file, "utf8"));
  assert.deepEqual(bothDoc.stitches[0].members.map((m: any) => m.key), ["both.pdf", "both.pdf#2"]);
  assert.equal(bothDoc.shapes.filter((x: any) => x.sheet_id === id).length, 1);
  assert.ok(bothDoc.sheets.some((x: any) => x.sheet_id === id), "composite scale carried");

  // extract one member: half a stitch is not carried, nor the takeoff on it
  const one = await session.extractPages(base, [1], path.join(dir, "one.pdf"));
  const oneDoc = JSON.parse(await readFile(one.takeoff_file, "utf8"));
  assert.equal((oneDoc.stitches ?? []).length, 0);
  assert.equal(oneDoc.shapes.filter((x: any) => x.sheet_id === id).length, 0);

  // merge: members land at the merged page numbers
  const merged = await session.mergeDocuments([path.join(dir, "one.pdf"), file], path.join(dir, "merged.pdf"));
  const mergedDoc = JSON.parse(await readFile(merged.takeoff_file, "utf8"));
  assert.deepEqual(mergedDoc.stitches[0].members.map((m: any) => m.key), ["merged.pdf#2", "merged.pdf#3"]);
  assert.equal(mergedDoc.shapes.filter((x: any) => x.sheet_id === id).length, 1);

  // an empty stitch lets its member turn, and gives up the alignment it had
  const s2 = new Session();
  await s2.loadPlan(file);
  s2.setScale(west, { upp });
  s2.setScale(east, { upp });
  const made2 = await s2.stitchSheets({ sheets: [west, east] });
  await s2.alignStitch({ stitch: made2.stitch_id, anchor: [2800, 1500], moving: [3800, 1500] });
  await s2.rotatePage(west, 90, path.join(dir, "rot.pdf"));
  const st2 = s2.stitch(made2.stitch_id);
  assert.equal(st2.aligned, false);
  assert.equal(st2.seam_check, undefined);
  assert.throws(
    () => s2.measurePolygon(made2.stitch_id, [[10, 10], [5000, 10], [5000, 60], [10, 60]], { condition: "CPT-1", role: "floor_area" }),
    /unaligned stitch/,
  );
});
