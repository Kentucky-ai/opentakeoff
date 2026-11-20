// Premium-import fixtures, produced by the open-source app's own code.
//
// Every number and record here comes from running OpenTakeoff, not from a
// hand-written file:
//   - geometry and quantities: the MCP server's Session (mcp/src/session.ts),
//     the same engine the canvas uses (one-click flood, room detection with
//     the finish schedule, derive_base, cut_out, counts, wall surfaces),
//     on the bundled demo plans;
//   - the takeoff document: buildTakeoffDocument via Session.exportPayload;
//   - storage: web/src/lib/store.js on fake-indexeddb (plans, revisions,
//     snapshots, libraries), cloudStore.js + snapshotSync.js on an in-memory
//     Drive for the Drive-style folder;
//   - files: browserExport.js (.otkx), projectArchive.js (.otk),
//     profile.js (.otprofile), the canvas's Export takeoff format (.takeoff.json);
//   - expected numbers: totals.js conditionTotals + estimate.js priceEstimate,
//     cross-checked against the Session's own estimate_summary.
//
// Run from the repo root (needs `npm ci` in web/ and mcp/):
//   node --import ./web/node_modules/tsx/dist/loader.mjs test-fixtures/premium-import/generate.mts
// or: cd mcp && node --import tsx ../test-fixtures/premium-import/generate.mts
//
// Ids and timestamps are minted at run time, so a re-run produces equivalent
// but not byte-identical files.

import "../../web/node_modules/fake-indexeddb/auto/index.mjs";
import { mkdirSync, writeFileSync, readFileSync, statSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "../../web/node_modules/fflate/esm/index.mjs";
import { createRequire } from "node:module";
const webRequire = createRequire(new URL("../../web/package.json", import.meta.url));
const { PDFDocument, StandardFonts, rgb } = webRequire("pdf-lib");

// localStorage for the browser-global modules (identity, companySetup,
// assemblies, report setup) — installed before they load
class MemStorage {
  m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
const storage = new MemStorage();
(globalThis as any).localStorage = storage;
(globalThis as any).window ??= { addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } };

const { Session } = await import("../../mcp/src/session.ts");
const { localStore, createLocalStore, withStoreDb } = await import("../../web/src/lib/store.js");
const { createCloudStore } = await import("../../web/src/lib/cloudStore.js");
const { createSnapshotSync } = await import("../../web/src/lib/google/snapshotSync.js");
const { writeBrowserExport, blobSink } = await import("../../web/src/lib/browserExport.js");
const { buildProjectArchive } = await import("../../web/src/lib/projectArchive.js");
const { buildProfile } = await import("../../web/src/lib/profile.js");
const { conditionTotals, grandTotals, materialsSummary } = await import("../../web/src/lib/totals.js");
const { priceEstimate } = await import("../../web/src/lib/estimate.js");
const { buildTakeoffDocument } = await import("../../web/src/lib/takeoffDocument.js");
const { applyApprovalCommand } = await import("../../web/src/lib/approvals.js");
const { applyShapeCommand } = await import("../../web/src/lib/shapeCommands.js");
const { captureRectToImageGeom } = await import("../../web/src/lib/markupImage.ts");
const { conditionToAssembly, saveAssemblies } = await import("../../web/src/lib/assemblies.js");
const { saveEstimatingDefaults } = await import("../../web/src/lib/companySetup.js");
const { loadProfiles, addProfile, saveProfiles } = await import("../../web/src/lib/identity.js");
const { seedStampLibrary, markupToStampElement } = await import("../../web/src/lib/stamps.js");

const HERE = dirname(fileURLToPath(import.meta.url));
const DEMO = join(HERE, "../../demo");
const OUT = HERE;
const sizes: Record<string, number> = {};
const write = (name: string, data: Uint8Array | string) => {
  const p = join(OUT, name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
  sizes[name] = statSync(p).size;
};
const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

// ── plans ──────────────────────────────────────────────────────────────────
const SMALL = "sample-plan.pdf";
const FINISH = "sample-finish-plan.pdf";
const smallV1 = new Uint8Array(readFileSync(join(DEMO, SMALL)));
const finishBytes = new Uint8Array(readFileSync(join(DEMO, FINISH)));
// a real revision of the small plan: the same sheet with a revision cloud
// note in the title block, so the bytes (and hash) differ
async function revise(bytes: Uint8Array, note: string) {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(0);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(note, { x: 865, y: 96, size: 12, font, color: rgb(0.7, 0.1, 0.1) });
  page.drawRectangle({ x: 140, y: 420, width: 120, height: 60, borderColor: rgb(0.7, 0.1, 0.1), borderWidth: 1.5 });
  doc.setModificationDate(new Date("2026-11-02T15:00:00Z"));
  doc.setCreationDate(new Date("2026-11-02T15:00:00Z"));
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}
const smallV2 = await revise(smallV1, "REV 1 — 2026-11-02 — COLUMN ADDED AT OFFICE 101");
const tmpDir = mkdtempSync(join(tmpdir(), "ot-fixtures-"));
writeFileSync(join(tmpDir, SMALL), smallV2);

// a tiny real PNG (8x8, two-tone) for the image markup, as the canvas stores it
const { zlibSync } = await import("../../web/node_modules/fflate/esm/index.mjs");
function pngDataUrl(w: number, h: number) {
  const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(strToU8(type), 4);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 2;
  const raw = new Uint8Array(h * (1 + w * 3));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * (1 + w * 3) + 1 + x * 3;
    const on = (x + y) % 2 === 0;
    raw[o] = on ? 31 : 240; raw[o + 1] = on ? 63 : 240; raw[o + 2] = on ? 199 : 235;
  }
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlibSync(raw)), chunk("IEND", new Uint8Array())];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { png.set(p, o); o += p.length; }
  return "data:image/png;base64," + Buffer.from(png).toString("base64");
}

const AUTHOR = "Fixture Estimator";
const nowIso = () => new Date().toISOString();

// canvas-shaped extras the MCP has no verb for (image markup, estimator seal)
function imageMarkup(sheetId: string, sheetW: number, sheetH: number, rect: { x0: number; y0: number; x1: number; y1: number }, name: string) {
  const g = captureRectToImageGeom(rect, sheetW, sheetH);
  return { id: `mk-${crypto.randomUUID()}`, created_at: nowIso(), sheet_id: sheetId, rfi_id: "", condition_id: "", type: "image", src: pngDataUrl(8, 8), at: g.at, w: g.w, aspect: g.aspect, text: name, author: AUTHOR };
}
// the estimator accepted the agent's work in the canvas (the Accept gate,
// shapeCommands "review"), except any batch still open as a proposal
function acceptAllButProposals(shapes: any[]) {
  const ids = shapes.filter((x) => x.origin?.reviewed === false && !x.origin?.proposal_id).map((x) => x.id);
  return applyShapeCommand(shapes, { type: "review", ids }).shapes;
}
function estimatorSeal(approvals: any[], sheetId: string, at: [number, number], shapeId?: string) {
  return applyApprovalCommand(approvals, { type: "add", approvals: [{ actor: "estimator", sheet_id: sheetId, at, ...(shapeId ? { shape_id: shapeId } : {}) }] }).approvals;
}

// ── project 1: the synthetic office plan, every measure role ──────────────
// sheet px = pt x 2, y flipped: building 240..2200 x 204..1364; partitions at
// x=1220 and y=784; 1/4" = 1'-0" → 1/36 ft per px.
async function projectOffice() {
  const s = new Session();
  await s.loadPlan(join(tmpDir, SMALL));
  const K = SMALL;
  s.setScale(K, { use_detected: true } as any);
  const SNAP: any[] = [];

  // floors (one-click flood fill, the canvas's tool)
  const o101 = await s.oneClick(K, 600, 1084, { condition: "CPT-1", role: "floor_area", returnVerts: true });
  const o102 = await s.oneClick(K, 1700, 1084, { condition: "CPT-1", role: "floor_area", returnVerts: true });
  const brk = await s.oneClick(K, 600, 500, { condition: "VCT-1", role: "floor_area", returnVerts: true });
  SNAP.push({ label: "Rooms traced — before deducts and base", doc: s.exportPayload() });
  // deducts: a drawn deduct shape (a 2'x2' column, the revision's change) and a
  // cut_out reconciled into office 102 (a 4'x6' casework footprint)
  s.measurePolygon(K, [[700, 1000], [772, 1000], [772, 1072], [700, 1072]], { condition: "CPT-1", role: "deduct" });
  s.cutOut({ parent_shape_id: (o102 as any).shape_id, verts: [[1900, 1200], [2116, 1200], [2116, 1344], [1900, 1344]] });
  // linear: base derived from the carpet rooms (two door openings stated),
  // a transition hand-drawn at the break-room door, a reducer strip
  const base = s.deriveBase({ source_condition: "CPT-1", condition: "RB-1", openings: [{ shape_id: (o101 as any).shape_id, lf: 3 }, { shape_id: (o102 as any).shape_id, lf: 3 }] });
  s.measureLine(K, [[1100, 784], [1208, 784]], { condition: "TR-1" });
  s.measureLine(K, [[240, 784], [420, 784]], { condition: "VB-1" });
  // count: floor boxes and transition reducers
  s.placeCount(K, [[800, 1150], [1000, 1150], [1600, 1150], [1800, 1000]], { condition: "FB-1" });
  // surface: FRP wainscot on the break room's north and west walls, 4 ft high
  s.measureSurface(K, [[240, 220], [1208, 220]], { condition: "FRP-1", height_ft: 4 });
  s.measureSurface(K, [[256, 204], [256, 770]], { condition: "FRP-1", height_ft: 4 });
  // condition knobs and materials
  s.editCondition("CPT-1", { waste_pct: 8 });
  s.editCondition("VCT-1", { waste_pct: 5 });
  s.editCondition("RB-1", { waste_pct: 5 });
  s.editMaterials("CPT-1", { add: [{ name: "Carpet tile adhesive", per: 200, basis: "floor", unit: "gal" }, { name: "Seam sealer", per: 500, basis: "floor", unit: "tube" }] });
  s.editMaterials("VCT-1", { add: [{ name: "VCT adhesive", per: 150, basis: "floor", unit: "gal" }, { name: "Floor finish", per: 1500, basis: "floor", unit: "gal" }] });
  s.editMaterials("RB-1", { add: [{ name: "Cove base adhesive", per: 60, basis: "linear", unit: "tube" }] });
  // an agent proposal left pending: the corridor, in LVT-1
  const prop = s.proposeTakeoff("Corridor 104 per finish legend", "The corridor reads LVT-1 on the legend; traced wall face to wall face.");
  const corr = await s.oneClick(K, 1700, 500, { condition: "LVT-1", role: "floor_area", returnVerts: true });
  // markups and an RFI on a conflict
  const cloud: any = s.annotate({ sheet: K, type: "cloud", text: "Column at 101 not on structural", rect: [[680, 980], [800, 1090]] });
  s.annotate({ sheet: K, type: "text", text: "Match existing base color", at: [400, 1300] });
  s.annotate({ sheet: K, type: "callout", text: "Transition TR-1 here", at: [1000, 700], target: [1150, 784] });
  s.annotate({ sheet: K, type: "arrow", text: "Install direction", from: [1400, 1250], to: [1600, 1250] });
  s.annotate({ sheet: K, type: "dimension", text: "", from: [240, 1380], to: [1220, 1380] });
  const rfi: any = s.createRfi({ title: "Column at Office 101", question: "Rev 1 adds a 2'x2' column in Office 101 that the structural sheets don't show. Confirm the column and its finish wrap.", sheet: K, markup_ids: [cloud.id ?? cloud.markup_id] });
  // an agent verdict and pricing
  s.markVerdict({ shape_id: (o101 as any).shape_id, text: "Ring checked against wall faces" });
  s.setPricing("CPT-1", { unit: "SY", material: 28.5, labor: 6.75, materials: [{ name: "Carpet tile adhesive", price: 42 }, { name: "Seam sealer", price: 9.5 }] });
  s.setPricing("VCT-1", { unit: "SF", material: 1.85, labor: 1.4, materials: [{ name: "VCT adhesive", price: 31 }, { name: "Floor finish", price: 38 }] });
  s.setPricing("LVT-1", { unit: "SF", material: 4.2, labor: 1.9 });
  s.setPricing("RB-1", { unit: "LF", material: 1.35, labor: 1.1, materials: [{ name: "Cove base adhesive", price: 6.25 }] });
  s.setPricing("TR-1", { unit: "LF", material: 7.5, labor: 4 });
  s.setPricing("VB-1", { unit: "LF", material: 3.1, labor: 2 });
  s.setPricing("FB-1", { unit: "EA", material: 85, labor: 45 });
  s.setPricing("FRP-1", { unit: "SF", material: 2.6, labor: 2.25 });
  s.setEstimateSettings({
    tax_pct: 6, overhead_pct: 10, profit_pct: 12, profit_mode: "markup",
    proposal: { itemized: true, scope_note: "Furnish and install flooring, base and FRP per finish legend.", inclusions: "Floor prep up to 1/8\"\nTransitions at finish changes", exclusions: "Moisture mitigation\nFurniture moving", terms: "Net 30. Progress billing monthly.", valid_days: 45 },
    client: { name: "Northside Property Group", address: "1200 Commerce Dr, Lexington KY", reference: "Bid 26-114" },
  });
  const sheetPx = { w: 2448, h: 1584 };
  let doc: any = s.exportPayload();
  const approvals = estimatorSeal(doc.approvals || [], K, [600 / sheetPx.w, 1084 / sheetPx.h], (o101 as any).shape_id);
  doc = buildTakeoffDocument({
    ...doc,
    project_name: "Northside Office Fit-out",
    shapes: acceptAllButProposals(doc.shapes),
    markups: [...doc.markups, imageMarkup(K, sheetPx.w, sheetPx.h, { x0: 1900, y0: 260, x1: 2140, y1: 500 }, "A-101-01 site photo")],
    approvals,
  });
  return { s, doc, snaps: SNAP, ids: { o101, o102, brk, corr, base, prop, rfi } };
}

// ── project 2: the VA finish plan, rooms from the finish schedule ─────────
async function projectFinish() {
  const s = new Session();
  await s.loadPlan(join(DEMO, FINISH));
  const K = FINISH;
  s.setScale(K, { use_detected: true } as any);
  const SNAP: any[] = [];
  const det: any = await s.detectRooms(K, { role: "floor_area", returnVerts: true, assignFromSchedule: true });
  SNAP.push({ label: "Rooms from the finish schedule", doc: s.exportPayload() });
  const tags = [...new Set(det.rooms.map((r: any) => r.condition))] as string[];
  const cpt = det.rooms.find((r: any) => r.condition === "CPT-1");
  if (cpt) {
    s.deriveBase({ source_condition: "CPT-1", condition: "RB-1", openings: [{ shape_id: cpt.shape_id, lf: 3 }] });
    // a deduct inside the carpet room (a 2' x 2' chase at 1/8" scale = 32 px)
    const [x, y] = cpt.verts[0];
    s.measurePolygon(K, [[x + 20, y + 30], [x + 52, y + 30], [x + 52, y + 62], [x + 20, y + 62]], { condition: "CPT-1", role: "deduct" });
  }
  s.placeCount(K, [[4200, 1500], [4250, 1520], [4380, 1580]], { condition: "DS-1" });
  s.measureSurface(K, [[4165, 1427], [4317, 1427]], { condition: "WT-1", height_ft: 7 });
  s.editCondition("RB-1", { waste_pct: 5 });
  s.editMaterials("RB-1", { add: [{ name: "Cove base adhesive", per: 60, basis: "linear", unit: "tube" }] });
  for (const t of tags) s.setPricing(t, { unit: "SF", material: 3.25, labor: 1.75 });
  s.setPricing("RB-1", { unit: "LF", material: 1.35, labor: 1.1, materials: [{ name: "Cove base adhesive", price: 6.25 }] });
  s.setPricing("DS-1", { unit: "EA", material: 40, labor: 25 });
  s.setEstimateSettings({ tax_pct: 7.25, overhead_pct: 8, profit_pct: 15, profit_mode: "margin", client: { name: "St. Cloud VA Medical Center", reference: "656-19-306" } });
  // a pending condition edit (agent asks to change waste) and markups/RFI
  s.proposeConditionEdit("RB-1", { waste_pct: 10 } as any, "Schedule calls for 4\" coved base with outside corners; 10% is the shop standard.");
  const cloud: any = s.annotate({ sheet: K, type: "cloud", text: "Room 133 has no schedule finish", rect: [[2540, 1380], [2720, 1530]] });
  s.annotate({ sheet: K, type: "bubble", text: "1", at: [4300, 1600], r: 30 });
  s.createRfi({ title: "Room 133 finish", question: "Room 133 is tagged EXIST on the plan and has no schedule row. Confirm the existing floor stays.", sheet: K, markup_ids: [cloud.id ?? cloud.markup_id] });
  let doc: any = s.exportPayload();
  doc = buildTakeoffDocument({
    ...doc,
    project_name: "St. Cloud VA Bldg 28 RRTP",
    shapes: acceptAllButProposals(doc.shapes),
    markups: [...doc.markups, imageMarkup(K, 6048, 4320, { x0: 5200, y0: 300, x1: 5800, y1: 700 }, "AF101-01 existing floor photo")],
    approvals: estimatorSeal(doc.approvals || [], K, [cpt ? cpt.verts[0][0] / 6048 : 0.5, cpt ? cpt.verts[0][1] / 4320 : 0.5], cpt?.shape_id),
  });
  return { s, doc, snaps: SNAP, tags };
}

const p1 = await projectOffice();
const p2 = await projectFinish();
const FOLDER_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz-va28";

// ── the browser: store.js on fake-indexeddb ───────────────────────────────
// project 1 is this browser's default workspace ("annotations"); project 2 a
// Drive-backed project ("annotations:<folderId>"). Plans are one browser-global
// store keyed by file name; a project reaches its plans through sheet_id.
await localStore.addPdf(new File([smallV1], SMALL, { type: "application/pdf" }));
await localStore.addPdf(new File([smallV2], SMALL, { type: "application/pdf" }));   // archives rev 1, current rev 2
await localStore.addPdf(new File([finishBytes], FINISH, { type: "application/pdf" }));
for (const sn of p1.snaps) await localStore.saveSnapshot(sn.label, sn.doc);
await localStore.saveAnnotations(p1.doc);
const p2Store = createLocalStore(FOLDER_ID);
for (const sn of p2.snaps) await localStore.saveSnapshot(sn.label, sn.doc, FOLDER_ID);
await p2Store.saveAnnotations(p2.doc);

// libraries: templates are conditions minus ids (the canvas's Save as template),
// the material library holds library rows the conditions link to
const tplFrom = (c: any) => { const { id, pricing, ...rest } = c; void id; void pricing; return { ...rest, materials: (rest.materials || []).map(({ id: _i, ...m }: any) => m) }; };
const templates = p1.doc.conditions.filter((c: any) => ["CPT-1", "VCT-1", "RB-1", "LVT-1"].includes(c.finish_tag)).map(tplFrom);
await localStore.saveTemplates(templates);
const matLib = p1.doc.conditions.flatMap((c: any) => (c.materials || []).map((m: any, i: number) => ({ ...m, id: `lib-${c.finish_tag.toLowerCase()}-${i + 1}` })));
await localStore.saveMaterialLibrary(matLib);
const stamps = seedStampLibrary({ stamps: [], sets: [] });
const arrow = p1.doc.markups.find((m: any) => m.type === "arrow");
stamps.stamps.push({ id: "stmp-install-dir", name: "Install direction (office)", elements: [markupToStampElement({ ...arrow, from: [-0.04, 0], to: [0.04, 0] })].filter(Boolean) });
await localStore.saveStampLibrary(stamps);
const asm = ["CPT-1", "VCT-1"].map((t, i) => conditionToAssembly(p1.doc.conditions.find((c: any) => c.finish_tag === t), `${t} standard install`, `asm-${i + 1}`)).filter(Boolean);
saveAssemblies(asm);
saveEstimatingDefaults({ overhead_pct: 10, profit_pct: 12, tax_pct: 6, profit_mode: "markup", valid_days: 30, inclusions: "Floor prep up to 1/8\"\nTransitions at finish changes", exclusions: "Moisture mitigation\nAsbestos abatement", terms: "Net 30." });
saveProfiles(addProfile(loadProfiles(), { name: "Bluegrass Flooring LLC", address: "88 Main St, Lexington KY 40507", phone: "859-555-0142", email: "bids@example.com", license: "KY-FL-20391" }).state);
assert.equal(loadProfiles().profiles.length, 1);
storage.setItem("opentakeoff_units", "imperial");
storage.setItem("ot-author", AUTHOR);
storage.setItem("opentakeoff_recent_projects", JSON.stringify([{ id: FOLDER_ID, name: "St. Cloud VA Bldg 28 RRTP", at: nowIso() }]));
storage.setItem("opentakeoff_ai_key", "sk-fixture-never-exported");

// ── 1. .otkx ──────────────────────────────────────────────────────────────
const sink = blobSink();
const manifest: any = await writeBrowserExport({ withDb: withStoreDb, sink, storage, buildProfile, appVersion: "0.1.0" });
write("browser-backup.otkx", new Uint8Array(await sink.blob().arrayBuffer()));
assert.equal(manifest.complete, true);
assert.equal(manifest.counts.projects, 2);
assert.equal(manifest.counts.pdf_revs, 1);

// ── 2. .otk per project ───────────────────────────────────────────────────
const loadPdfData = (n: string) => localStore.loadPdfData(n);
const p1Sheets = [{ name: SMALL }];
const p2Sheets = [{ name: FINISH }];
write("northside-office.otk", await buildProjectArchive({ takeoff: p1.doc, sheets: p1Sheets, loadPdfData, projectName: p1.doc.project_name }));
write("va-bldg-28.otk", await buildProjectArchive({ takeoff: p2.doc, sheets: p2Sheets, loadPdfData, projectName: p2.doc.project_name }));

// ── 3. .takeoff.json (Export takeoff: the payload, pretty-printed) ───────
write("northside-office.takeoff.json", JSON.stringify(p1.doc, null, 2));
write("va-bldg-28.takeoff.json", JSON.stringify(p2.doc, null, 2));

// ── 4. .otprofile ─────────────────────────────────────────────────────────
write("estimator.otprofile", JSON.stringify(await buildProfile("Bluegrass Flooring"), null, 2));

// ── 5. Drive-style project folder (cloudStore + snapshotSync on a fake Drive)
function fakeDrive() {
  const byId = new Map<string, any>();
  let seq = 0;
  const newId = () => `drv_${String(++seq).padStart(4, "0")}`;
  byId.set(FOLDER_ID, { id: FOLDER_ID, name: "St. Cloud VA Bldg 28 RRTP", mimeType: "application/vnd.google-apps.folder", parent: "root" });
  const find = (folderId: string, name: string) => [...byId.values()].find((r) => r.name === name && r.parent === folderId) || null;
  const meta = (r: any) => ({ id: r.id, name: r.name, mimeType: r.mimeType, modifiedTime: r.modifiedTime, size: r.bytes?.length });
  const touch = (r: any) => { r.modifiedTime = nowIso(); return r; };
  return {
    _byId: byId,
    async listChildren(folderId: string, { mimeType }: any = {}) { return [...byId.values()].filter((r) => r.parent === folderId && (!mimeType || r.mimeType === mimeType)).map(meta); },
    async findChild(folderId: string, name: string) { const r = find(folderId, name); return r ? meta(r) : null; },
    async createFolder(parentId: string, name: string) { const id = newId(); byId.set(id, touch({ id, name, parent: parentId, mimeType: "application/vnd.google-apps.folder" })); return { id, name }; },
    async getFileBytes(id: string) { return new Uint8Array(byId.get(id).bytes); },
    async getJson(id: string) { return JSON.parse(new TextDecoder().decode(byId.get(id).bytes)); },
    async uploadFile({ name, parentId, mimeType, bytes }: any) { const id = newId(); byId.set(id, touch({ id, name, parent: parentId, mimeType, bytes: new Uint8Array(bytes) })); return { id, name }; },
    async updateFileBytes(id: string, bytes: Uint8Array, mimeType?: string) { const r = touch(byId.get(id)); r.bytes = new Uint8Array(bytes); if (mimeType) r.mimeType = mimeType; return { id }; },
    async putJson({ folderId, name, data, existingId }: any) {
      const bytes = strToU8(JSON.stringify(data));
      if (existingId) return this.updateFileBytes(existingId, bytes, "application/json");
      return this.uploadFile({ name, parentId: folderId, mimeType: "application/json", bytes });
    },
    async deleteFile(id: string) { byId.delete(id); },
  };
}
const drive = fakeDrive();
const cloud: any = createCloudStore(FOLDER_ID, drive, { local: localStore });
await cloud.addPdf(new File([finishBytes], FINISH, { type: "application/pdf" }));
await cloud.saveAnnotations(p2.doc);
const snapSync: any = createSnapshotSync({ base: localStore, provider: drive, folderId: FOLDER_ID, ensureSidecarId: cloud.ensureSidecarId });
for (const sn of p2.snaps) await snapSync.saveSnapshot(sn.label, sn.doc);
await snapSync.whenIdle?.();
const pathOf = (r: any): string => (r.id === FOLDER_ID ? r.name : `${pathOf(drive._byId.get(r.parent))}/${r.name}`);
const tree: Record<string, Uint8Array | [Uint8Array, any]> = {};
for (const r of drive._byId.values()) {
  if (!r.bytes) continue;
  tree[pathOf(r)] = r.mimeType === "application/pdf" ? [r.bytes, { level: 0 }] : r.bytes;
}
write("drive-project-folder.zip", zipSync(tree as any));
const driveListing = Object.keys(tree).sort();

// ── expected.json: the app's own numbers ──────────────────────────────────
function expectedFor(doc: any, s: any) {
  const rows = conditionTotals(doc.conditions, doc.shapes);
  const est = priceEstimate({ rows, conditions: doc.conditions, settings: doc.estimate_settings });
  const summary = s.estimateSummary();
  // the canvas formula and the agent's estimate_summary must agree
  assert.equal(est.total, summary.total, `${doc.project_name}: totals.js/estimate.js vs Session.estimateSummary`);
  const byRole: Record<string, number> = {};
  for (const sh of doc.shapes) byRole[sh.measure_role] = (byRole[sh.measure_role] || 0) + 1;
  return {
    project_name: doc.project_name,
    sheets: doc.sheets,
    counts: {
      conditions: doc.conditions.length, shapes: doc.shapes.length, shapes_by_role: byRole,
      shapes_pending_review: doc.shapes.filter((x: any) => x.origin?.reviewed === false).length,
      markups: doc.markups.length, image_markups: doc.markups.filter((m: any) => m.type === "image").length,
      rfis: (doc.rfis || []).length, approvals: (doc.approvals || []).length,
      proposals: (doc.proposals || []).length, condition_edit_proposals: (doc.condition_edit_proposals || []).length,
    },
    conditions: rows.map((r: any) => ({ id: r.id, finish_tag: r.finish_tag, ...Object.fromEntries(Object.entries(r).filter(([k]) => k !== "id" && k !== "finish_tag")) })),
    grand_totals: grandTotals(rows),
    materials_summary: materialsSummary(rows),
    estimate: {
      settings: est.settings,
      lines: est.lines,
      material: est.material, labor: est.labor, tax: est.tax, cost: est.cost,
      overhead: est.overhead, profit: est.profit, total: est.total,
      complete: est.complete, unpriced: est.unpriced, warnings: est.warnings,
    },
    report_json: s.exportReport(doc.project_name),
  };
}
const expected = {
  generated_by: "test-fixtures/premium-import/generate.mts — open-source OpenTakeoff code, not hand-written",
  app_version: "0.1.0",
  takeoff_schema: p1.doc.schema,
  notes: [
    "conditions[] is web/src/lib/totals.js conditionTotals(doc.conditions, doc.shapes). floor_sf / wall_sf / border_sf / lf / ea / total_sf are MEASURED quantities (multiplier applied, deduct shapes netted, cut_out deducts already inside their parent's ring). The *_net fields and sy_net are ORDER quantities: measured x (1 + waste_pct/100) — the suffix is the app's documented naming debt, it means 'with waste', not 'net of deducts'. materials[].qty is the rounded buy quantity.",
    "estimate is web/src/lib/estimate.js priceEstimate over those rows with doc.estimate_settings; it equals the MCP Session's estimate_summary total (asserted at generation).",
    "Shapes pending review (origin.reviewed === false, the agent proposal) are included in these totals, as the app counts them; the canvas shows them dashed until accepted.",
  ],
  projects: {
    "northside-office": { files: ["northside-office.otk", "northside-office.takeoff.json", "browser-backup.otkx (meta: annotations)"], ...expectedFor(p1.doc, p1.s) },
    "va-bldg-28": { files: ["va-bldg-28.otk", "va-bldg-28.takeoff.json", "drive-project-folder.zip", `browser-backup.otkx (meta: annotations:${FOLDER_ID})`], drive_folder_id: FOLDER_ID, ...expectedFor(p2.doc, p2.s) },
  },
  browser_backup: { manifest_counts: manifest.counts, projects: manifest.projects, excluded: manifest.excluded, pdf_revisions: { [SMALL]: "current rev 2 (revised bytes), rev 1 archived in pdf_revs" } },
  drive_folder_listing: driveListing,
  profile: { templates: templates.length, materials: matLib.length, stamps: stamps.stamps.length, assemblies: asm.length, company_profiles: (loadProfiles().profiles || []).length },
};
write("expected.json", json(expected));

// ── read every artifact back with the app's own readers ───────────────────
{
  const { parseProjectArchive } = await import("../../web/src/lib/projectArchive.js");
  const { parseProfile } = await import("../../web/src/lib/profile.js");
  const { parseTakeoffImport } = await import("../../web/src/lib/importTakeoff.js");
  const { openBrowserExport, applyBrowserExport } = await import("../../web/src/lib/browserExport.js");
  const { IDBFactory } = await import("../../web/node_modules/fake-indexeddb/build/esm/index.js");
  const { unzipSync, strFromU8 } = await import("../../web/node_modules/fflate/esm/index.mjs");
  const read = (n: string) => new Uint8Array(readFileSync(join(OUT, n)));
  for (const [file, doc] of [["northside-office.otk", p1.doc], ["va-bldg-28.otk", p2.doc]] as const) {
    const a = await parseProjectArchive(read(file));
    assert.deepEqual(a.takeoff, doc, file);
    assert.equal(a.pdfs.length, 1, file);
  }
  for (const [file, doc] of [["northside-office.takeoff.json", p1.doc], ["va-bldg-28.takeoff.json", p2.doc]] as const) {
    parseTakeoffImport(readFileSync(join(OUT, file), "utf8"));
    assert.deepEqual(JSON.parse(readFileSync(join(OUT, file), "utf8")), doc, file);
  }
  const prof = parseProfile(readFileSync(join(OUT, "estimator.otprofile"), "utf8"));
  assert.equal(prof.condition_templates.length, templates.length);
  assert.equal(prof.assembly_library.length, asm.length);
  assert.ok(prof.estimating_defaults && prof.company_profiles.profiles.length === 1);
  // the .otkx restores into an empty browser with both projects intact
  (globalThis as any).indexedDB = new IDBFactory();
  const fresh = new MemStorage();
  const bundle = await openBrowserExport(new Blob([read("browser-backup.otkx")]));
  await applyBrowserExport(bundle, { withDb: withStoreDb, storage: fresh });
  assert.deepEqual(await localStore.loadAnnotations(), { ...p1.doc, schema: p1.doc.schema });
  assert.deepEqual(await createLocalStore(FOLDER_ID).loadAnnotations(), p2.doc);
  assert.deepEqual((await localStore.listPdfRevisions(SMALL)).map((r: any) => r.rev), [2, 1]);
  assert.equal((await localStore.listSnapshots()).length >= 1, true);
  assert.equal(fresh.getItem("opentakeoff_ai_key"), null, "credentials stay out of the backup");
  // the Drive folder's annotations.json is the project document
  const dz = unzipSync(read("drive-project-folder.zip"));
  const ann = JSON.parse(strFromU8(dz["St. Cloud VA Bldg 28 RRTP/.opentakeoff/annotations.json"]));
  assert.deepEqual(ann, { ...p2.doc, schema: p2.doc.schema });
  console.log("verified: .otk x2, .takeoff.json x2, .otprofile, .otkx restore, Drive folder");
}

console.log(JSON.stringify(sizes, null, 2));
console.log(JSON.stringify(Object.fromEntries(Object.entries(expected.projects).map(([k, v]: any) => [k, { total: v.estimate.total, counts: v.counts }])), null, 2));
