// Plan-set search over the gallery's index map — planSearch.ts is pure (no
// DOM, no pdf.js), so it runs straight under node. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSheetIndex, isHybrid, isScan, searchPlan, type IndexedTextItem, type Rect, type SheetIndex } from "../src/lib/planIndex.ts";
import {
  runPlanSearch, ocrWordsToItems, ocrSheetIndex, putSheetIndex, filesToIndex, pagesToIndex, galleryEscStep, createChangeSignal,
  needsRead, keysToLookUp, canLookUp, galleryReadView, unreadLine, createWalkFailures, searchFailedLine, retryWalk, seedFromThumb, thumbTextUnknown, galleryCountLine, thumbIndexStep, isIndexed, needsTextPass,
  readPlanOf, readWhat, mayLookUp, adoptEntry, readableFromIndex, acceptsMeasuredPass, acceptsTextPass,
} from "../src/lib/planSearch.ts";
import { pageTextIndex } from "../src/lib/pageTextIndex.ts";
import { readFileSync } from "node:fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { measurePage, type MeasurablePage } from "../src/lib/pictures.ts";
import type { OpList } from "../src/lib/oneclick.ts";
import { buildHybridPlan, PICTURE } from "./fixtures/hybridPlan.ts";

const runs = (...strs: string[]): IndexedTextItem[] => strs.map((str) => ({ str }));
const mapOf = (...ixs: SheetIndex[]) => new Map(ixs.map((ix) => [ix.key, ix]));

// ── ordering: planSearch adds no ranking of its own ──────────────────────────

test("runPlanSearch: hits come back in searchPlan's order, not re-sorted", () => {
  const map = mapOf(
    buildSheetIndex("a.pdf", runs("CPT-1")),
    buildSheetIndex("a.pdf#2", runs("CPT-1 CPT-1 CPT-1")),
    buildSheetIndex("a.pdf#10", runs("CPT-1 CPT-1")),
  );
  const keys = [...map.keys()];
  const r = runPlanSearch("cpt-1", map, keys);
  assert.deepEqual(r.hits, searchPlan(map.values(), "cpt-1"));
  assert.deepEqual(r.hits.map((h) => h.key), ["a.pdf#2", "a.pdf#10", "a.pdf"]);
});

test("runPlanSearch: an OCR hit ranks below every text hit, even with a higher score", () => {
  const map = mapOf(
    buildSheetIndex("scan.pdf", runs("CORRIDOR CORRIDOR CORRIDOR CORRIDOR"), "ocr"),
    buildSheetIndex("vec.pdf", runs("CORRIDOR")),
  );
  const r = runPlanSearch("corridor", map, ["scan.pdf", "vec.pdf"]);
  assert.deepEqual(r.hits.map((h) => h.key), ["vec.pdf", "scan.pdf"]);
  assert.deepEqual([...r.ocrKeys], ["scan.pdf"]);
});

// ── allKeys filter ───────────────────────────────────────────────────────────

test("runPlanSearch: a key outside allKeys never surfaces (a closed file's leftovers)", () => {
  const map = mapOf(
    buildSheetIndex("gone.pdf", runs("CPT-1")),
    buildSheetIndex("live.pdf", runs("CPT-1")),
  );
  const r = runPlanSearch("cpt-1", map, ["live.pdf"]);
  assert.deepEqual(r.hits.map((h) => h.key), ["live.pdf"]);
  assert.deepEqual(Object.keys(r.chipsByKey), ["live.pdf"]);
});

test("runPlanSearch: a stale entry can't change how live sheets match", () => {
  // The stale sheet has CPT-1 exactly. Were it handed to searchPlan, it would
  // turn off digit extension for "CPT-1" and the live CPT-12 sheet would vanish.
  const map = mapOf(
    buildSheetIndex("gone.pdf", runs("CPT-1")),
    buildSheetIndex("live.pdf", runs("CPT-12")),
  );
  const r = runPlanSearch("cpt-1", map, ["live.pdf"]);
  assert.deepEqual(r.hits.map((h) => h.key), ["live.pdf"]);
  assert.deepEqual(r.chipsByKey["live.pdf"], ["CPT-12"]);
});

test("runPlanSearch: a live key with no index yet is simply not a hit", () => {
  const map = mapOf(buildSheetIndex("a.pdf", runs("LOBBY")));
  const r = runPlanSearch("lobby", map, ["a.pdf", "a.pdf#2"]);
  assert.deepEqual(r.hits.map((h) => h.key), ["a.pdf"]);
});

// ── chips ────────────────────────────────────────────────────────────────────

test("runPlanSearch: chips are the matched terms per key, in query order", () => {
  const map = mapOf(buildSheetIndex("a.pdf", runs("CPT-1 CORRIDOR")));
  const r = runPlanSearch("corr cpt-1", map, ["a.pdf"]);
  assert.deepEqual(r.chipsByKey["a.pdf"], ["CORRIDOR", "CPT-1"]);
});

test("runPlanSearch: a term two query tokens both matched is chipped once", () => {
  // "CPT" prefix-matches CPT-1, and "CPT-1" matches it exactly
  const map = mapOf(buildSheetIndex("a.pdf", runs("CPT-1")));
  const r = runPlanSearch("cpt cpt-1", map, ["a.pdf"]);
  assert.deepEqual(r.chipsByKey["a.pdf"], ["CPT-1"]);
});

test("runPlanSearch: ocrKeys holds only OCR hits, not OCR sheets that missed", () => {
  const map = mapOf(
    buildSheetIndex("s1.pdf", runs("LOBBY"), "ocr"),
    buildSheetIndex("s2.pdf", runs("STAIR"), "ocr"),
  );
  const r = runPlanSearch("lobby", map, ["s1.pdf", "s2.pdf"]);
  assert.deepEqual([...r.ocrKeys], ["s1.pdf"]);
});

// ── empty query ──────────────────────────────────────────────────────────────

test("runPlanSearch: an empty or punctuation-only query has no hits", () => {
  const map = mapOf(buildSheetIndex("a.pdf", runs("LOBBY")));
  for (const q of ["", "   ", "--"]) {
    const r = runPlanSearch(q, map, ["a.pdf"]);
    assert.deepEqual(r.hits, [], `query ${JSON.stringify(q)}`);
    assert.deepEqual(r.chipsByKey, {});
    assert.equal(r.ocrKeys.size, 0);
  }
});

// ── unread count (feeds the unread line) ─────────────────────────────────────

// a text layer: nine runs, one more than a scan may carry (SCAN_MAX_TEXT_LINES)
const nineRuns = (first: string) => runs(first, ...Array.from({ length: 8 }, (_, i) => `NOTE ${i}`));

test("runPlanSearch: unreadCount counts indexed scans (little or no text layer) in the set", () => {
  const map = mapOf(
    buildSheetIndex("scan.pdf", []),                   // text-less, no OCR → unread
    buildSheetIndex("scan.pdf#2", runs("—", "  ")),    // only punctuation → still text-less
    buildSheetIndex("read.pdf", runs("LOBBY"), "ocr"), // has an OCR entry → read
    buildSheetIndex("blank.pdf", [], "ocr"),           // OCR ran and found nothing → read
    buildSheetIndex("vec.pdf", nineRuns("LOBBY")),     // has a text layer
    buildSheetIndex("gone.pdf", []),                   // text-less but not in the set
  );
  const keys = ["scan.pdf", "scan.pdf#2", "read.pdf", "blank.pdf", "vec.pdf", "later.pdf"];
  const r = runPlanSearch("", map, keys);
  assert.equal(r.unreadCount, 2);
});

test("runPlanSearch: unreadCount doesn't depend on the query", () => {
  const map = mapOf(buildSheetIndex("scan.pdf", []), buildSheetIndex("vec.pdf", nineRuns("LOBBY")));
  const keys = ["scan.pdf", "vec.pdf"];
  assert.equal(runPlanSearch("lobby", map, keys).unreadCount, 1);
  assert.equal(runPlanSearch("nothing-here", map, keys).unreadCount, 1);
});

// ── ocrWordsToItems ──────────────────────────────────────────────────────────

test("ocrWordsToItems: keeps each word's string and drops blank ones", () => {
  const words = [
    { str: "CPT-1", x: 1, y: 2, w: 3, h: 4, confidence: 0.9 },
    { str: "  ", x: 0, y: 0, w: 0, h: 0 },
    { str: "OFFICE 101", x: 5, y: 6, w: 7, h: 8 },
  ];
  assert.deepEqual(ocrWordsToItems(words), [{ str: "CPT-1" }, { str: "OFFICE 101" }]);
});

test("ocrSheetIndex: a page read's lines become its OCR entry, replacing the empty text entry", () => {
  const map = mapOf(buildSheetIndex("scan.pdf#2", [], "text"));
  const ix = ocrSheetIndex("scan.pdf#2", [{ str: "LOBBY 101", x: 0, y: 0, w: 1, h: 1 }, { str: " ", x: 0, y: 0, w: 0, h: 0 }]);
  assert.deepEqual(ix, buildSheetIndex("scan.pdf#2", [{ str: "LOBBY 101" }], "ocr"));
  assert.equal(ix.source, "ocr");
  assert.equal(putSheetIndex(map, "scan.pdf#2", ix), true);
  assert.equal(runPlanSearch("lobby", map, ["scan.pdf#2"]).ocrKeys.has("scan.pdf#2"), true);
});

test("ocrWordsToItems: OCR words index and search like text runs, tagged OCR", () => {
  const ix = buildSheetIndex("scan.pdf", ocrWordsToItems([{ str: "OFFICE 101", x: 0, y: 0, w: 1, h: 1 }]), "ocr");
  const r = runPlanSearch("101", mapOf(ix), ["scan.pdf"]);
  assert.deepEqual(r.hits.map((h) => h.key), ["scan.pdf"]);
  assert.deepEqual([...r.ocrKeys], ["scan.pdf"]);
  assert.equal(r.unreadCount, 0);
});

// ── putSheetIndex: what may replace what in the gallery's index map ──────────

test("putSheetIndex: stores a new entry and says so", () => {
  const map = new Map<string, SheetIndex>();
  assert.equal(putSheetIndex(map, "a.pdf", buildSheetIndex("a.pdf", runs("LOBBY"))), true);
  assert.equal(map.get("a.pdf")?.terms.LOBBY, 1);
});

test("putSheetIndex: a text pass never replaces an existing entry", () => {
  // The canvas re-reads the lead page's text on every render; that must not
  // wipe an OCR read of the same text-less sheet, nor churn a text entry.
  const ocr = buildSheetIndex("scan.pdf", runs("LOBBY"), "ocr");
  const map = mapOf(ocr);
  assert.equal(putSheetIndex(map, "scan.pdf", buildSheetIndex("scan.pdf", [])), false);
  assert.equal(map.get("scan.pdf")!.source, "ocr");
  assert.deepEqual(map.get("scan.pdf")!.terms, ocr.terms, "the read stays; the pass is only recorded (needsTextPass)");
  const text = buildSheetIndex("vec.pdf", runs("STAIR"));
  map.set("vec.pdf", text);
  assert.equal(putSheetIndex(map, "vec.pdf", buildSheetIndex("vec.pdf", runs("STAIR"))), false);
  assert.equal(map.get("vec.pdf"), text);
});

test("putSheetIndex: an OCR read replaces the text-less entry, and a re-read replaces OCR", () => {
  const map = mapOf(buildSheetIndex("scan.pdf", []));
  assert.equal(putSheetIndex(map, "scan.pdf", buildSheetIndex("scan.pdf", runs("LOBBY"), "ocr")), true);
  assert.equal(map.get("scan.pdf")?.source, "ocr");
  assert.equal(putSheetIndex(map, "scan.pdf", buildSheetIndex("scan.pdf", runs("STAIR"), "ocr")), true);
  assert.equal(map.get("scan.pdf")?.terms.STAIR, 1);
});

test("putSheetIndex: the entry is stored under the key it was given", () => {
  const map = new Map<string, SheetIndex>();
  putSheetIndex(map, "b.pdf#2", buildSheetIndex("b.pdf#2", runs("LOBBY")));
  assert.deepEqual([...map.keys()], ["b.pdf#2"]);
});

// ── pageTextIndex: one page's text layer → its index entry ───────────────────

// pdf.js-shaped viewport: y flipped, scale 2 (RENDER_SCALE-like)
const PAGE_H = 1000;
const VP = { width: 1600, height: PAGE_H * 2, transform: [2, 0, 0, -2, 0, PAGE_H * 2] };
const item = (str: string, x: number, y: number) => ({ str, transform: [10, 0, 0, 10, x, y], width: 40, height: 10 });

test("pageTextIndex: indexes every run on the page, corners included", () => {
  const tc = { items: [item("CPT-1", 0, 1000), item("CORRIDOR", 400, 500), item("A101", 790, 1)] };
  const ix = pageTextIndex("a.pdf", tc, VP);
  assert.equal(ix.key, "a.pdf");
  assert.equal(ix.source, "text");
  assert.deepEqual(Object.keys(ix.terms).sort(), ["A101", "CORRIDOR", "CPT-1"]);
});

test("pageTextIndex: a page with no text still gets an entry, with tokenCount 0", () => {
  const ix = pageTextIndex("scan.pdf", { items: [item("   ", 10, 10)] }, VP);
  assert.equal(ix.tokenCount, 0);
  assert.deepEqual(ix.terms, {});
  assert.equal(runPlanSearch("", mapOf(ix), ["scan.pdf"]).unreadCount, 1);
});

// ── the gallery's indexing walk: which files, which pages ────────────────────

const hasIn = (...keys: string[]) => { const set = new Set(keys); return (k: string) => set.has(k); };

test("filesToIndex: a file whose known pages are all indexed is skipped (no document load)", () => {
  const counts: Record<string, number> = { "a.pdf": 2, "b.pdf": 1 };
  const plan = filesToIndex(["a.pdf", "b.pdf"], (f) => counts[f], hasIn("a.pdf", "a.pdf#2", "b.pdf"));
  assert.deepEqual(plan, []);
});

test("filesToIndex: a file with no known page count is walked, expecting 0 pages", () => {
  const plan = filesToIndex(["new.pdf"], () => undefined, hasIn());
  assert.deepEqual(plan, [{ file: "new.pdf", knownPages: 0 }]);
  // a count of 0 (unreadable last try) is "unknown" too — its doc is asked again
  assert.deepEqual(filesToIndex(["bad.pdf"], () => 0, hasIn()), [{ file: "bad.pdf", knownPages: 0 }]);
});

test("filesToIndex: a partly indexed file is walked; order follows the file list", () => {
  const counts: Record<string, number> = { "a.pdf": 3, "b.pdf": 2, "c.pdf": 1 };
  const plan = filesToIndex(["c.pdf", "a.pdf", "b.pdf"], (f) => counts[f], hasIn("a.pdf", "a.pdf#3", "b.pdf", "b.pdf#2"));
  assert.deepEqual(plan, [{ file: "c.pdf", knownPages: 1 }, { file: "a.pdf", knownPages: 3 }]);
});

test("pagesToIndex: the missing sheet keys of a file, page order, page 1 keyed by the bare name", () => {
  assert.deepEqual(pagesToIndex("a.pdf", 4, hasIn("a.pdf#2")), ["a.pdf", "a.pdf#3", "a.pdf#4"]);
  assert.deepEqual(pagesToIndex("a.pdf", 2, hasIn("a.pdf", "a.pdf#2")), []);
  assert.deepEqual(pagesToIndex("a.pdf", 0, hasIn()), []);
});

// ── Esc in the gallery: a typed search clears first ──────────────────────────

test("galleryEscStep: a typed query clears before anything else", () => {
  for (const mode of ["plan", "browse", "manage"]) {
    assert.equal(galleryEscStep({ query: "cpt", mode, canClose: true }), "clear-query");
    assert.equal(galleryEscStep({ query: "cpt", mode, canClose: false }), "clear-query");
  }
});

test("galleryEscStep: with no query, browse/manage go to plan, plan exits only when it can", () => {
  assert.equal(galleryEscStep({ query: "", mode: "browse", canClose: true }), "to-plan");
  assert.equal(galleryEscStep({ query: "", mode: "manage", canClose: false }), "to-plan");
  assert.equal(galleryEscStep({ query: "", mode: "plan", canClose: true }), "exit");
  assert.equal(galleryEscStep({ query: "", mode: "plan", canClose: false }), null);
});

// ── change signal: one listener call per frame, none with no listener ────────

const manualFrames = () => {
  const queue: (() => void)[] = [];
  return { schedule: (fn: () => void) => { queue.push(fn); }, flush: () => { for (const fn of queue.splice(0)) fn(); }, get size() { return queue.length; } };
};

test("createChangeSignal: many notifies in one frame call each listener once", () => {
  const f = manualFrames();
  const sig = createChangeSignal(f.schedule);
  let calls = 0;
  sig.subscribe(() => { calls++; });
  sig.notify(); sig.notify(); sig.notify();
  assert.equal(calls, 0);
  assert.equal(f.size, 1);
  f.flush();
  assert.equal(calls, 1);
  sig.notify(); f.flush();
  assert.equal(calls, 2);
});

test("createChangeSignal: with no listener, notify schedules nothing", () => {
  const f = manualFrames();
  const sig = createChangeSignal(f.schedule);
  sig.notify();
  assert.equal(f.size, 0);
});

test("createChangeSignal: unsubscribe stops calls, even for a frame already scheduled", () => {
  const f = manualFrames();
  const sig = createChangeSignal(f.schedule);
  let calls = 0;
  const off = sig.subscribe(() => { calls++; });
  sig.notify();
  off();
  f.flush();
  assert.equal(calls, 0);
});

// ── the gallery's OCR side ───────────────────────────────────────────────────

const textless = (key: string) => buildSheetIndex(key, runs("-", "  "));
// a vector sheet carries hundreds of runs (~1k on the demo finish plan)
const vector = (key: string) => buildSheetIndex(key, [...runs("CPT-1"), ...Array.from({ length: 200 }, (_, i) => ({ str: `ROOM ${100 + i}` }))]);
// a scan with a few stray runs on it: a scanner label, a stamp, a typed title-block field
const strayScan = (key: string, n = 3) => buildSheetIndex(key, Array.from({ length: n }, (_, i) => ({ str: `SCANNED BY OP${i}` })));
const read = (key: string, strs: string[] = ["ROOM"]) => buildSheetIndex(key, runs(...strs), "ocr");

test("needsRead: a checked text-less sheet with no OCR entry, nothing else", () => {
  assert.equal(needsRead(textless("a.pdf")), true);
  assert.equal(needsRead(vector("a.pdf")), false);
  assert.equal(needsRead(read("a.pdf")), false);
  assert.equal(needsRead(read("a.pdf", [])), false, "a read that found nothing is still read");
  assert.equal(needsRead(undefined), false, "not indexed yet: unknown, not unread");
});

test("runPlanSearch's unreadCount is needsRead's count", () => {
  const map = mapOf(textless("a.pdf"), vector("b.pdf"), read("c.pdf"), textless("d.pdf"));
  assert.equal(runPlanSearch("x", map, ["a.pdf", "b.pdf", "c.pdf", "d.pdf"]).unreadCount, 2);
});

test("keysToLookUp: every live sheet that needs a read, whatever indexed it; none outside the set", () => {
  const map = mapOf(textless("a.pdf"), vector("b.pdf"), read("c.pdf"), textless("d.pdf"), textless("gone.pdf"));
  assert.deepEqual(keysToLookUp(["a.pdf", "b.pdf", "c.pdf", "d.pdf", "new.pdf"], map), ["a.pdf", "d.pdf"]);
});

test("canLookUp: the cache is asked unless OCR is off or not installed; offline or erroring still reads the cache", () => {
  assert.equal(canLookUp(true, "available"), true);
  assert.equal(canLookUp(true, "error"), true);
  assert.equal(canLookUp(true, "disabled"), false);
  assert.equal(canLookUp(true, "uninstalled"), false);
  assert.equal(canLookUp(false, "available"), false, "a build with OCR off asks nothing");
});

test("galleryReadView: Read on an unread text-less card when OCR is available; never on a vector sheet", () => {
  assert.deepEqual(galleryReadView(textless("a.pdf"), "available", undefined), { kind: "read", what: "page" });
  assert.deepEqual(galleryReadView(textless("a.pdf"), "error", undefined), { kind: "unreachable", text: "The on-device text reader (OCR) couldn't be reached", what: "page" });
  assert.deepEqual(galleryReadView(textless("a.pdf"), "disabled", undefined), { kind: "hidden", what: "page" });
  assert.deepEqual(galleryReadView(textless("a.pdf"), null, undefined), { kind: "hidden", what: "page" }, "not probed yet");
  assert.deepEqual(galleryReadView(vector("a.pdf"), "available", undefined), { kind: "hidden", what: "page" });
  assert.deepEqual(galleryReadView(undefined, "available", undefined), { kind: "hidden", what: "page" }, "not indexed yet");
});

test("galleryReadView: progress and Cancel while reading, Stopping… after, the time once read (labelled OCR)", () => {
  assert.deepEqual(galleryReadView(textless("a.pdf"), "available", { state: "reading", progress: { phase: "tiles", done: 1, total: 4, rastersDone: 1, rastersPlanned: 4 } }), { kind: "reading", text: "Reading tiles 1/4", what: "page" });
  assert.deepEqual(galleryReadView(textless("a.pdf"), "available", { state: "stopping" }), { kind: "stopping", text: "Stopping…", what: "page" });
  // once read, its index entry is OCR: still a text-less sheet
  const done = galleryReadView(read("a.pdf"), "available", { state: "done", ms: 3200, rasters: 6, stale: false, cached: false });
  assert.equal(done.kind, "done");
  assert.match(done.kind === "done" ? done.text : "", /OCR/);
});

test("unreadLine: only when OCR is available and a sheet is unread; singular and plural", () => {
  assert.equal(unreadLine(3, "available"), "3 sheets with scans or pictures that haven't been read");
  assert.equal(unreadLine(1, "available"), "1 sheet with a scan or a picture that hasn't been read");
  assert.equal(unreadLine(0, "available"), null);
  for (const a of ["disabled", "uninstalled", null]) assert.equal(unreadLine(2, a), null);
  assert.equal(unreadLine(2, "error"), "The on-device text reader (OCR) couldn't be reached", "a probe error says so (with Retry)");
  assert.equal(unreadLine(0, "error"), null);
});

// ── seeding the index from a thumbnail record ────────────────────────────────

test("seedFromThumb: a record that says no text layer seeds the empty text entry, which needsRead", () => {
  const ix = seedFromThumb({ textLayer: false }, "scan.pdf#2", () => false);
  assert.ok(ix);
  assert.deepEqual(ix, { ...buildSheetIndex("scan.pdf#2", [], "text"), textLayer: false, seeded: true }, "the entry pageTextIndex gives a page with no tokens (no text layer), marked provisional");
  assert.equal(needsRead(ix), true);
});

test("seedFromThumb: a sheet with text, an already indexed sheet, or an old record seeds nothing", () => {
  assert.equal(seedFromThumb({ textLayer: true }, "vec.pdf", () => false), null);
  assert.equal(seedFromThumb({ textLayer: false }, "scan.pdf", () => true), null, "never over an existing entry (an OCR read included)");
  assert.equal(seedFromThumb({}, "old.pdf", () => false), null);
  assert.equal(seedFromThumb({ textLayer: undefined }, "old.pdf", () => false), null);
  assert.equal(seedFromThumb(null, "x.pdf", () => false), null);
});

test("thumbTextUnknown: only a record saved before the flag existed needs its page's text read", () => {
  assert.equal(thumbTextUnknown({}), true);
  assert.equal(thumbTextUnknown({ textLayer: undefined }), true);
  assert.equal(thumbTextUnknown({ textLayer: false }), false);
  assert.equal(thumbTextUnknown({ textLayer: true }), false);
});

test("galleryCountLine: the hit count beside the search box, not in the subtitle", () => {
  assert.equal(galleryCountLine(null, 4), null, "no search: nothing");
  assert.equal(galleryCountLine({ hits: 3 }, 4), "3 of 4 sheets match");
  assert.equal(galleryCountLine({ hits: 1 }, 1), "1 of 1 sheet matches");
});

// ── sheets the search walk couldn't read ─────────────────────────────────────

test("walk failures: a failed sheet isn't counted as checked; a later success clears it", () => {
  const f = createWalkFailures();
  assert.equal(f.count(), 0);
  f.fail("a.pdf#2");
  f.fail("a.pdf#2");
  f.failFile("b.pdf", 3);
  assert.equal(f.count(), 4, "a page once, an unreadable file as the pages it was expected to have");
  f.ok("a.pdf#2");
  f.okFile("b.pdf");
  assert.equal(f.count(), 0);
});

test("searchFailedLine: how many sheets search couldn't read, or that it didn't finish", () => {
  assert.equal(searchFailedLine({ sheets: 0, incomplete: false }), null);
  assert.equal(searchFailedLine({ sheets: 1, incomplete: false }), "1 sheet couldn't be read for search");
  assert.equal(searchFailedLine({ sheets: 3, incomplete: true }), "3 sheets couldn't be read for search");
  assert.equal(searchFailedLine({ sheets: 0, incomplete: true }), "Search couldn't read every sheet");
});

test("retryWalk: a new query retries only when something failed", () => {
  assert.equal(retryWalk({ sheets: 0, incomplete: false }), false);
  assert.equal(retryWalk({ sheets: 2, incomplete: false }), true);
  assert.equal(retryWalk({ sheets: 0, incomplete: true }), true);
});

test("thumbIndexStep: seed a scan's record, read an old record's (or an unmeasured vector record's) page once, else nothing", () => {
  const none = () => undefined;
  const loaded = () => true;
  assert.deepEqual(thumbIndexStep({ textLayer: false }, "scan.pdf", none, loaded), { kind: "seed", ix: seedFromThumb({ textLayer: false }, "scan.pdf", () => false) });
  assert.deepEqual(thumbIndexStep({}, "old.pdf", none, loaded), { kind: "read" });
  assert.deepEqual(thumbIndexStep({ textLayer: true }, "vec.pdf", none, loaded), { kind: "read" }, "its pictures aren't measured (#489)");
  assert.deepEqual(thumbIndexStep({ textLayer: true, pictures: [] }, "vec.pdf", none, loaded), { kind: "none" });
  assert.deepEqual(thumbIndexStep({ textLayer: false }, "scan.pdf", () => vector("scan.pdf"), loaded), { kind: "none" }, "already indexed: nothing");
});

test("thumbIndexStep: an old record whose sheet is already indexed takes its flag from the entry, no page read", () => {
  const loaded = () => true;
  assert.deepEqual(thumbIndexStep({}, "vec.pdf", () => vector("vec.pdf"), loaded), { kind: "flag", textLayer: true });
  assert.deepEqual(thumbIndexStep({}, "scan.pdf", () => textless("scan.pdf"), loaded), { kind: "flag", textLayer: false });
  // a read that carries no flag (placed over nothing) is no evidence: it may
  // be a hybrid's, so it is never flagged a scan; the page is read (#489 review)
  assert.deepEqual(thumbIndexStep({}, "read.pdf", () => read("read.pdf", ["ROOM 101"]), loaded), { kind: "read" });
  assert.deepEqual(thumbIndexStep({}, "read.pdf", () => read("read.pdf", ["ROOM 101"]), () => false), { kind: "none" });
  // a seeded entry is no evidence: read the page
  const seeded = seedFromThumb({ textLayer: false }, "s.pdf", () => false)!;
  assert.deepEqual(thumbIndexStep({}, "s.pdf", () => seeded, loaded), { kind: "read" });
});

test("thumbIndexStep: an old record's page is read only from a document already loaded; else its flag stays unknown", () => {
  const asked: string[] = [];
  const notLoaded = (file: string) => { asked.push(file); return false; };
  assert.deepEqual(thumbIndexStep({}, "old.pdf#3", () => undefined, notLoaded), { kind: "none" });
  assert.deepEqual(asked, ["old.pdf"], "asked by file, not by sheet key");
  const seeded = seedFromThumb({ textLayer: false }, "s.pdf", () => false)!;
  assert.deepEqual(thumbIndexStep({}, "s.pdf", () => seeded, () => false), { kind: "none" });
  // the entry is evidence whether or not the document is loaded
  assert.deepEqual(thumbIndexStep({}, "vec.pdf", () => vector("vec.pdf"), () => false), { kind: "flag", textLayer: true });
});

// ── a seeded entry is provisional ────────────────────────────────────────────

test("a seeded entry is marked, needs a read, and counts as not indexed", () => {
  const ix = seedFromThumb({ textLayer: false }, "scan.pdf", () => false)!;
  assert.equal(ix.seeded, true);
  assert.equal(needsRead(ix), true);
  const map = new Map([["scan.pdf", ix], ["vec.pdf", vector("vec.pdf")]]);
  assert.equal(isIndexed(map, "scan.pdf"), false);
  assert.equal(isIndexed(map, "vec.pdf"), true);
  assert.equal(isIndexed(map, "nope.pdf"), false);
});

test("a real text pass replaces a seeded entry (a stale thumbnail flag can't block indexing)", () => {
  const map = new Map<string, SheetIndex>();
  assert.equal(putSheetIndex(map, "a.pdf", seedFromThumb({ textLayer: false }, "a.pdf", () => false)!), true);
  // a real pass carries its own flag (pageTextIndex), so nothing of the seed's is kept
  const real = { ...buildSheetIndex("a.pdf", runs("CPT-1 CORRIDOR")), textLayer: false };
  assert.equal(putSheetIndex(map, "a.pdf", real), true, "the seed is provisional");
  assert.equal(map.get("a.pdf"), real);
  assert.equal(runPlanSearch("corridor", map, ["a.pdf"]).hits.length, 1);
  // a real entry is final as before, and a seed never replaces anything
  assert.equal(putSheetIndex(map, "a.pdf", buildSheetIndex("a.pdf", runs("OTHER"))), false);
  assert.equal(putSheetIndex(map, "a.pdf", seedFromThumb({ textLayer: false }, "a.pdf", () => false)!), false);
  assert.equal(map.get("a.pdf"), real);
  // nor over a read (an OCR entry): a stale thumbnail never undoes a read
  const ocr = read("b.pdf");
  map.set("b.pdf", ocr);
  assert.equal(putSheetIndex(map, "b.pdf", seedFromThumb({ textLayer: false }, "b.pdf", () => false)!), false);
  assert.equal(map.get("b.pdf"), ocr);
});

test("the search walk includes seeded sheets: their text is read for real", () => {
  const map = new Map<string, SheetIndex>([["a.pdf", vector("a.pdf")], ["a.pdf#2", seedFromThumb({ textLayer: false }, "a.pdf#2", () => false)!]]);
  const has = (k: string) => isIndexed(map, k);
  assert.deepEqual(filesToIndex(["a.pdf"], () => 2, has), [{ file: "a.pdf", knownPages: 2 }]);
  assert.deepEqual(pagesToIndex("a.pdf", 2, has), ["a.pdf#2"]);
});

// ── a scan with a few stray text runs is a scan (#471) ──────────────────────

test("needsRead: a scan carrying a few stray lines (up to 8) needs a read; 9 is a text layer", () => {
  assert.equal(needsRead(strayScan("a.pdf", 3)), true, "3 runs");
  assert.equal(needsRead(strayScan("a.pdf", 8)), true, "8 runs");
  assert.equal(needsRead(strayScan("a.pdf", 9)), false, "9 runs");
});

test("runPlanSearch: a stray-text scan counts as unread, and its stray text is searchable until it is read", () => {
  const map = mapOf(strayScan("scan.pdf"), vector("vec.pdf"));
  const before = runPlanSearch("scanned", map, ["scan.pdf", "vec.pdf"]);
  assert.equal(before.unreadCount, 1);
  assert.deepEqual(before.hits.map((h) => [h.key, h.source]), [["scan.pdf", "text"]]);
  // the read replaces the stray-text entry
  assert.equal(putSheetIndex(map, "scan.pdf", buildSheetIndex("scan.pdf", runs("SCANNED BY OP0", "CORRIDOR"), "ocr")), true);
  const after = runPlanSearch("corridor", map, ["scan.pdf", "vec.pdf"]);
  assert.equal(after.unreadCount, 0);
  assert.deepEqual([...after.ocrKeys], ["scan.pdf"]);
});

test("galleryReadView: a stray-text scan is offered Read; a 9-line sheet and a vector sheet are not", () => {
  assert.deepEqual(galleryReadView(strayScan("a.pdf", 3), "available", undefined), { kind: "read", what: "page" });
  assert.deepEqual(galleryReadView(strayScan("a.pdf", 8), "available", undefined), { kind: "read", what: "page" });
  assert.deepEqual(galleryReadView(strayScan("a.pdf", 9), "available", undefined), { kind: "hidden", what: "page" });
  assert.deepEqual(galleryReadView(vector("a.pdf"), "available", undefined), { kind: "hidden", what: "page" });
});

test("pageTextIndex: a page whose text layer is three stray runs is unread", () => {
  const tc = { items: [item("SCANNED 2024-01-02", 10, 990), item("RECEIVED", 700, 20), item("PLAN ROOM COPY", 300, 500)] };
  const ix = pageTextIndex("scan.pdf", tc, VP);
  assert.equal(ix.lineCount, 3);
  assert.equal(runPlanSearch("", mapOf(ix), ["scan.pdf"]).unreadCount, 1);
});

test("thumbIndexStep: an old record over a stray-text scan's entry flags no text layer", () => {
  assert.deepEqual(thumbIndexStep({}, "scan.pdf", () => strayScan("scan.pdf"), () => true), { kind: "flag", textLayer: false });
});

test("putSheetIndex: a read of a scan keeps the stray text-layer terms OCR missed, as an OCR entry", () => {
  const map = mapOf(strayScan("scan.pdf"));
  assert.equal(putSheetIndex(map, "scan.pdf", buildSheetIndex("scan.pdf", runs("CORRIDOR", "SCANNED"), "ocr")), true);
  const ix = map.get("scan.pdf")!;
  assert.equal(ix.source, "ocr", "ranked as OCR, below every text hit");
  assert.equal(ix.terms.CORRIDOR, 1);
  assert.equal(ix.terms.OP2, 1, "the stamp's term OCR missed is still searchable");
  assert.equal(ix.terms.SCANNED, 3, "a term both have keeps the larger count, not the sum");
  assert.deepEqual(runPlanSearch("op2", map, ["scan.pdf"]).hits.map((h) => [h.key, h.source]), [["scan.pdf", "ocr"]]);
  assert.equal(runPlanSearch("", map, ["scan.pdf"]).unreadCount, 0);
});

test("putSheetIndex: a scan's text pass arriving after its read (a cached read seeded first) merges into the OCR entry, once", () => {
  const map = mapOf(buildSheetIndex("scan.pdf", runs("CORRIDOR"), "ocr"));
  assert.equal(putSheetIndex(map, "scan.pdf", strayScan("scan.pdf")), true);
  assert.equal(map.get("scan.pdf")!.source, "ocr");
  assert.equal(map.get("scan.pdf")!.terms.OP1, 1);
  assert.equal(map.get("scan.pdf")!.terms.CORRIDOR, 1);
  assert.equal(putSheetIndex(map, "scan.pdf", strayScan("scan.pdf")), false, "the same pass again changes nothing");
});

test("putSheetIndex: reading a scan again keeps its stray text-layer terms", () => {
  const map = mapOf(strayScan("scan.pdf"));
  putSheetIndex(map, "scan.pdf", buildSheetIndex("scan.pdf", runs("CORRIDOR"), "ocr"));
  assert.equal(putSheetIndex(map, "scan.pdf", buildSheetIndex("scan.pdf", runs("LOBBY"), "ocr")), true);
  assert.equal(map.get("scan.pdf")!.terms.LOBBY, 1);
  assert.equal(map.get("scan.pdf")!.terms.OP2, 1, "the stamp survives the second read");
  assert.equal(map.get("scan.pdf")!.terms.CORRIDOR, undefined, "the first read's own text is replaced");
});

test("putSheetIndex: a sheet with a text layer folds its whole text layer into an OCR entry, in either order (#489)", () => {
  const map = mapOf(vector("v.pdf"));
  putSheetIndex(map, "v.pdf", buildSheetIndex("v.pdf", runs("CORRIDOR"), "ocr"));
  assert.equal(map.get("v.pdf")!.terms["CPT-1"], 1);
  assert.equal(map.get("v.pdf")!.terms.CORRIDOR, 1);
  const map2 = mapOf(buildSheetIndex("w.pdf", runs("CORRIDOR"), "ocr"));
  assert.equal(putSheetIndex(map2, "w.pdf", vector("w.pdf")), true);
  assert.equal(map2.get("w.pdf")!.terms["CPT-1"], 1);
  assert.equal(putSheetIndex(map2, "w.pdf", vector("w.pdf")), false, "the same pass again changes nothing");
});

// ── after a reload: the cached read lands on the thumbnail's seed (#471) ────

const seedOf = (key: string) => seedFromThumb({ textLayer: false }, key, () => false)!;

test("needsTextPass: not indexed or seeded → yes; a read of a scan with no text pass yet → yes; a read with its text pass, or a text entry → no", () => {
  assert.equal(needsTextPass(undefined), true);
  assert.equal(needsTextPass(seedOf("s.pdf")), true);
  // a cached read replacing the seed: the scan's text layer hasn't been seen
  const map = mapOf(seedOf("s.pdf"));
  putSheetIndex(map, "s.pdf", buildSheetIndex("s.pdf", runs("CORRIDOR"), "ocr"));
  assert.equal(needsTextPass(map.get("s.pdf")), true);
  // a thumbnail's seed arriving again is no text pass
  assert.equal(putSheetIndex(map, "s.pdf", seedOf("s.pdf")), false);
  assert.equal(needsTextPass(map.get("s.pdf")), true);
  // its text pass merges, and then none is needed
  putSheetIndex(map, "s.pdf", strayScan("s.pdf"));
  assert.equal(needsTextPass(map.get("s.pdf")), false);
  // a read over the scan's own text entry (flagged, as every real pass is,
  // #489) has had its text pass
  const m2 = mapOf({ ...strayScan("t.pdf"), textLayer: false });
  putSheetIndex(m2, "t.pdf", buildSheetIndex("t.pdf", runs("CORRIDOR"), "ocr"));
  assert.equal(needsTextPass(m2.get("t.pdf")), false);
  // a read placed over a sheet with a text layer, measured: its text pass
  // happened too (unmeasured, it still needs one, #489 review)
  const m3 = mapOf({ ...vector("x.pdf"), textLayer: true, pictures: [] });
  putSheetIndex(m3, "x.pdf", buildSheetIndex("x.pdf", runs("CORRIDOR"), "ocr"));
  assert.equal(needsTextPass(m3.get("x.pdf")), false);
  assert.equal(needsTextPass(strayScan("u.pdf")), false);
  assert.equal(needsTextPass({ ...vector("v.pdf"), pictures: [] }), false, "measured (an unmeasured one needs a pass, #489)");
  assert.equal(needsTextPass(textless("w.pdf")), false);
});

test("after a reload a stamp OCR missed is searchable again once the text pass runs (seed → cached read → text pass)", () => {
  const map = mapOf(seedOf("scan.pdf"));
  putSheetIndex(map, "scan.pdf", buildSheetIndex("scan.pdf", runs("CORRIDOR"), "ocr"));
  assert.equal(runPlanSearch("op2", map, ["scan.pdf"]).hits.length, 0, "not yet: the text layer hasn't been read");
  assert.equal(putSheetIndex(map, "scan.pdf", strayScan("scan.pdf")), true);
  assert.deepEqual(runPlanSearch("op2", map, ["scan.pdf"]).hits.map((h) => [h.key, h.source]), [["scan.pdf", "ocr"]]);
});

test("a text pass with nothing to add still records itself on a read, so it isn't asked for again", () => {
  const map = mapOf(seedOf("blank.pdf"));
  putSheetIndex(map, "blank.pdf", buildSheetIndex("blank.pdf", runs("CORRIDOR"), "ocr"));
  assert.equal(putSheetIndex(map, "blank.pdf", textless("blank.pdf")), false, "nothing search can see changed");
  assert.equal(needsTextPass(map.get("blank.pdf")), false);
  // a page that turns out to have a text layer: its terms fold in (#489), pass recorded
  const m2 = mapOf(seedOf("v.pdf"));
  putSheetIndex(m2, "v.pdf", buildSheetIndex("v.pdf", runs("CORRIDOR"), "ocr"));
  assert.equal(putSheetIndex(m2, "v.pdf", vector("v.pdf")), true);
  assert.equal(m2.get("v.pdf")!.terms["CPT-1"], 1);
  assert.equal(needsTextPass(m2.get("v.pdf")), false);
});

test("the search walk reopens a file only for a read still waiting for its text pass", () => {
  const map = mapOf(seedOf("pending.pdf"), { ...strayScan("done.pdf"), textLayer: false }, { ...vector("vec.pdf"), pictures: [] });
  putSheetIndex(map, "pending.pdf", buildSheetIndex("pending.pdf", runs("CORRIDOR"), "ocr"));
  putSheetIndex(map, "done.pdf", buildSheetIndex("done.pdf", runs("LOBBY"), "ocr"));
  const has = (k: string) => !needsTextPass(map.get(k));
  assert.deepEqual(filesToIndex(["pending.pdf", "done.pdf", "vec.pdf"], () => 1, has).map((f) => f.file), ["pending.pdf"]);
  assert.deepEqual(pagesToIndex("pending.pdf", 1, has), ["pending.pdf"]);
});


// ── pictures on a vector sheet (#489) ───────────────────────────────────────

const P: Rect = { x0: 640, y0: 1320, x1: 1584, y1: 1569.8 };
// a text pass's entry: what pageTextIndex gives (textLayer set), measured or not
const labelled = (key: string): SheetIndex => ({ ...vector(key), textLayer: true });
const measured = (key: string, pictures: Rect[] | "failed" = []): SheetIndex => ({ ...vector(key), textLayer: true, pictures });
const hyb = (key: string) => measured(key, [P]);
const hybSeed = (key: string) => seedFromThumb({ textLayer: true, pictures: [P] }, key, () => false)!;
const ocrOver = (key: string, strs = ["VCT-1", "CPT-1"]) => buildSheetIndex(key, runs(...strs), "ocr");

test("isScan: the text pass's flag when set, else the line rule; a hybrid seed isn't one", () => {
  assert.equal(isScan(textless("a.pdf")), true);
  assert.equal(isScan(strayScan("a.pdf", 8)), true);
  assert.equal(isScan(vector("a.pdf")), false);
  assert.equal(isScan({ ...vector("a.pdf"), textLayer: false }), true, "the flag wins over the count");
  assert.equal(isScan({ ...textless("a.pdf"), textLayer: true }), false);
  assert.equal(isScan(hybSeed("a.pdf")), false, "no terms, but its record said text layer");
});

test("isHybrid: not a scan, with at least one unread picture measured", () => {
  assert.equal(isHybrid(hyb("a.pdf")), true);
  assert.equal(isHybrid(hybSeed("a.pdf")), true);
  assert.equal(isHybrid(measured("a.pdf")), false, "measured, no picture");
  assert.equal(isHybrid(measured("a.pdf", "failed")), false, "unreadable op list: none");
  assert.equal(isHybrid(labelled("a.pdf")), false, "not measured");
  assert.equal(isHybrid({ ...textless("a.pdf"), pictures: [P] }), false, "a scan is read whole, not a hybrid");
});

test("needsRead and keysToLookUp: a hybrid text entry or seed needs a read; its read, a measured vector sheet and a stitch don't", () => {
  assert.equal(needsRead(hyb("a.pdf")), true);
  assert.equal(needsRead(hybSeed("a.pdf")), true);
  assert.equal(needsRead(measured("a.pdf")), false);
  assert.equal(needsRead(measured("a.pdf", "failed")), false);
  assert.equal(needsRead(labelled("a.pdf")), false);
  const map = mapOf(hyb("h.pdf"));
  putSheetIndex(map, "h.pdf", ocrOver("h.pdf"));
  assert.equal(needsRead(map.get("h.pdf")), false, "read");
  assert.equal(needsRead(hyb("stitch:abc")), false, "a stitch is never readable");
  assert.equal(needsRead(textless("stitch:abc")), false);
  const all = mapOf(hyb("a.pdf"), measured("b.pdf"), textless("c.pdf"), hybSeed("d.pdf"));
  assert.deepEqual(keysToLookUp(["a.pdf", "b.pdf", "c.pdf", "d.pdf"], all), ["a.pdf", "c.pdf", "d.pdf"]);
  assert.equal(runPlanSearch("x", all, ["a.pdf", "b.pdf", "c.pdf", "d.pdf"]).unreadCount, 3, "one count for both kinds");
});

test("galleryReadView: a hybrid offers a read of its picture, a scan of its page; a stitch never", () => {
  assert.deepEqual(galleryReadView(hyb("a.pdf"), "available", undefined), { kind: "read", what: "picture" });
  assert.deepEqual(galleryReadView(hybSeed("a.pdf"), "available", undefined), { kind: "read", what: "picture" });
  assert.deepEqual(galleryReadView(textless("a.pdf"), "available", undefined), { kind: "read", what: "page" });
  assert.deepEqual(galleryReadView(measured("a.pdf"), "available", undefined), { kind: "hidden", what: "page" });
  assert.deepEqual(galleryReadView(hyb("stitch:abc"), "available", undefined), { kind: "hidden", what: "page" }, "a stitch reads nothing; hidden either way");
  // once read, a hybrid's OCR entry keeps its picture (carried) and stays readable
  const map = mapOf(hyb("h.pdf"));
  putSheetIndex(map, "h.pdf", ocrOver("h.pdf"));
  const done = galleryReadView(map.get("h.pdf"), "available", { state: "done", ms: 3200, rasters: 1, stale: false, cached: false });
  assert.equal(done.kind, "done");
  assert.equal(done.what, "picture");
});

test("putSheetIndex: a read over a hybrid's text entry folds in ALL its terms and keeps textLayer and pictures", () => {
  const map = mapOf(hyb("h.pdf"));
  assert.equal(putSheetIndex(map, "h.pdf", ocrOver("h.pdf")), true);
  const ix = map.get("h.pdf")!;
  assert.equal(ix.source, "ocr");
  assert.equal(ix.textLayer, true);
  assert.deepEqual(ix.pictures, [P]);
  assert.equal(ix.terms["VCT-1"], 1);
  assert.equal(ix.terms.ROOM, 200, "the text layer's own words stay searchable");
  assert.deepEqual(ix.stray, hyb("h.pdf").terms);
  assert.equal(needsTextPass(ix), false);
});

test("putSheetIndex: a read carries textLayer and pictures over a seed and over an earlier read", () => {
  const map = mapOf(hybSeed("h.pdf"));
  putSheetIndex(map, "h.pdf", ocrOver("h.pdf"));
  assert.equal(map.get("h.pdf")!.textLayer, true);
  assert.deepEqual(map.get("h.pdf")!.pictures, [P]);
  assert.equal(needsTextPass(map.get("h.pdf")), true, "a read over a seed still waits for its text pass");
  putSheetIndex(map, "h.pdf", ocrOver("h.pdf", ["RB-1"]));
  assert.equal(map.get("h.pdf")!.textLayer, true, "read again");
  assert.deepEqual(map.get("h.pdf")!.pictures, [P]);
  // a scan's read gets no textLayer (none was set), and its shape is unchanged
  const m2 = mapOf(textless("s.pdf"));
  putSheetIndex(m2, "s.pdf", ocrOver("s.pdf"));
  assert.equal("textLayer" in m2.get("s.pdf")!, false);
  assert.equal("pictures" in m2.get("s.pdf")!, false);
});

test("putSheetIndex: a text pass over a hybrid seed keeps the seed's pictures when it measured none", () => {
  const map = mapOf(hybSeed("h.pdf"));
  assert.equal(putSheetIndex(map, "h.pdf", labelled("h.pdf")), true);
  assert.deepEqual(map.get("h.pdf")!.pictures, [P]);
  assert.equal(map.get("h.pdf")!.seeded, undefined);
  assert.equal(needsRead(map.get("h.pdf")), true);
  // a measured pass brings its own
  const m2 = mapOf(hybSeed("h.pdf"));
  putSheetIndex(m2, "h.pdf", measured("h.pdf"));
  assert.deepEqual(m2.get("h.pdf")!.pictures, []);
});

test("putSheetIndex: a text entry not yet measured takes the pictures of a later pass, once", () => {
  const map = mapOf(labelled("v.pdf"));
  assert.equal(putSheetIndex(map, "v.pdf", hyb("v.pdf")), true, "the walk or the thumbnails measured it");
  assert.deepEqual(map.get("v.pdf")!.pictures, [P]);
  assert.equal(needsRead(map.get("v.pdf")), true);
  assert.equal(putSheetIndex(map, "v.pdf", hyb("v.pdf")), false, "the same pass again");
  assert.equal(putSheetIndex(map, "v.pdf", measured("v.pdf")), false, "a measured entry is final");
  assert.deepEqual(map.get("v.pdf")!.pictures, [P]);
  assert.equal(putSheetIndex(map, "v.pdf", labelled("v.pdf")), false, "an unmeasured pass changes nothing");
});

test("putSheetIndex: a text pass over a read that had none (read over nothing) adopts textLayer and pictures", () => {
  const map = new Map<string, SheetIndex>();
  putSheetIndex(map, "h.pdf", ocrOver("h.pdf"));
  assert.equal(putSheetIndex(map, "h.pdf", hyb("h.pdf")), true);
  const ix = map.get("h.pdf")!;
  assert.equal(ix.source, "ocr");
  assert.equal(ix.textLayer, true);
  assert.deepEqual(ix.pictures, [P]);
  assert.equal(ix.terms.ROOM, 200);
  assert.equal(needsTextPass(ix), false);
});

test("putSheetIndex: pictures measured after the read's text pass still land, and report a change", () => {
  const map = mapOf(hybSeed("h.pdf"));
  putSheetIndex(map, "h.pdf", ocrOver("h.pdf"));
  putSheetIndex(map, "h.pdf", labelled("h.pdf"));   // the canvas's label loop: stray recorded, no pictures
  const before = map.get("h.pdf")!;
  assert.ok(before.stray);
  assert.deepEqual(before.pictures, [P], "kept from the seed");
  // a read over nothing, then the label loop's pass (stray recorded, nothing
  // measured), then the walk's measured pass: no new terms, new pictures
  const m2 = new Map<string, SheetIndex>();
  putSheetIndex(m2, "h.pdf", ocrOver("h.pdf"));
  putSheetIndex(m2, "h.pdf", labelled("h.pdf"));
  assert.equal(m2.get("h.pdf")!.pictures, undefined);
  assert.equal(putSheetIndex(m2, "h.pdf", hyb("h.pdf")), true, "only pictures changed, and the badge and the offer read them");
  assert.deepEqual(m2.get("h.pdf")!.pictures, [P]);
  assert.equal(putSheetIndex(m2, "h.pdf", hyb("h.pdf")), false, "the same pass again");
});

test("needsTextPass: a vector text entry not yet measured needs one; measured, failed, a scan or a hybrid doesn't", () => {
  assert.equal(needsTextPass(labelled("v.pdf")), true);
  assert.equal(needsTextPass(vector("v.pdf")), true);
  assert.equal(needsTextPass(measured("v.pdf")), false);
  assert.equal(needsTextPass(measured("v.pdf", "failed")), false, "an unreadable op list isn't measured again");
  assert.equal(needsTextPass(hyb("v.pdf")), false);
  assert.equal(needsTextPass(textless("s.pdf")), false, "a scan is read whole: nothing to measure");
  assert.equal(needsTextPass(strayScan("s.pdf")), false);
});

test("acceptsMeasuredPass: a real measurement lands over \"failed\"; \"failed\" never replaces anything, and a measured entry takes no repeat", () => {
  assert.equal(acceptsMeasuredPass(undefined, []), true, "nothing there: needsTextPass");
  assert.equal(acceptsMeasuredPass(vector("v.pdf"), "failed"), true, "unmeasured: needsTextPass");
  assert.equal(acceptsMeasuredPass(measured("v.pdf", "failed"), [P]), true, "a real measurement over a failed one");
  assert.equal(acceptsMeasuredPass(measured("v.pdf", "failed"), []), true, "an empty one is real too");
  assert.equal(acceptsMeasuredPass(measured("v.pdf", "failed"), "failed"), false, "failed again: nothing new");
  assert.equal(acceptsMeasuredPass(measured("v.pdf"), [P]), false, "already measured");
  assert.equal(acceptsMeasuredPass(hyb("v.pdf"), "failed"), false);
  const map = mapOf(ocrOver("h.pdf"));
  putSheetIndex(map, "h.pdf", measured("h.pdf", "failed"));
  assert.equal(map.get("h.pdf")!.pictures, "failed");
  assert.equal(acceptsMeasuredPass(map.get("h.pdf"), [P]), true, "a read whose pass failed takes a real one");
  assert.equal(putSheetIndex(map, "h.pdf", hyb("h.pdf")), true, "and putSheetIndex keeps it (measuredOf)");
  assert.deepEqual(map.get("h.pdf")!.pictures, [P]);
  assert.equal(acceptsMeasuredPass(map.get("h.pdf"), [P]), false, "then it's measured");
});

test("acceptsTextPass: a text pass without pictures is built only where putSheetIndex would change the entry", () => {
  // the canvas's label passes index text alone (no op list); over an entry
  // that needs only its pictures, putSheetIndex drops what they build
  const pass = (key: string): SheetIndex => ({ ...vector(key), textLayer: true });
  const withStray = (key: string, pictures?: Rect[] | "failed"): SheetIndex => {
    const m = mapOf(pictures === undefined ? labelled(key) : measured(key, pictures));
    putSheetIndex(m, key, ocrOver(key));
    return m.get(key)!;
  };
  const noStray = (key: string, pictures?: Rect[] | "failed"): SheetIndex => {
    const m = new Map<string, SheetIndex>();
    putSheetIndex(m, key, pictures === undefined ? hybSeed(key) : { ...hybSeed(key), pictures });
    putSheetIndex(m, key, ocrOver(key));
    return m.get(key)!;
  };
  const cases: Array<[string, SheetIndex | undefined]> = [
    ["nothing", undefined],
    ["a seed", seedOf("k.pdf")],
    ["a hybrid seed", hybSeed("k.pdf")],
    ["unmeasured text", labelled("k.pdf")],
    ["measured text", measured("k.pdf")],
    ["failed text", measured("k.pdf", "failed")],
    ["a hybrid's text", hyb("k.pdf")],
    ["a scan's text", { ...textless("k.pdf"), textLayer: false }],
    ["a read without stray", noStray("k.pdf")],
    ["a read without stray, failed", noStray("k.pdf", "failed")],
    ["a read with stray, unmeasured", withStray("k.pdf")],
    ["a read with stray, measured", withStray("k.pdf", [P])],
    ["a read with stray, failed", withStray("k.pdf", "failed")],
  ];
  for (const [what, have] of cases) {
    const m = new Map<string, SheetIndex>(have ? [["k.pdf", have]] : []);
    const before = m.get("k.pdf");
    putSheetIndex(m, "k.pdf", pass("k.pdf"));
    const changed = m.get("k.pdf") !== before;
    assert.equal(acceptsTextPass(have), changed, `${what}: ${changed ? "changes" : "doesn't change"} the entry`);
  }
  assert.equal(acceptsTextPass(labelled("k.pdf")), false, "the waste this gate removes: needsTextPass says yes, for the pictures");
  assert.equal(needsTextPass(labelled("k.pdf")), true);
});

test("searchPlan: a hit on a hybrid's read is text when every matched term is the text layer's, else OCR", () => {
  const map = mapOf(hyb("h.pdf"), measured("v.pdf"));
  putSheetIndex(map, "h.pdf", ocrOver("h.pdf", ["VCT-1", "CPT-2 CPT-2 CPT-2"]));
  const keys = ["h.pdf", "v.pdf"];
  const src = (q: string) => runPlanSearch(q, map, keys).hits.map((h) => [h.key, h.source]);
  assert.deepEqual(src("vct-1"), [["h.pdf", "ocr"]]);
  assert.deepEqual(src("room"), [["h.pdf", "text"], ["v.pdf", "text"]], "ranked with the text hits, by score then sheet");
  assert.deepEqual([...runPlanSearch("room", map, keys).ocrKeys], [], "and badged text");
  assert.deepEqual(src("cpt-1"), [["h.pdf", "text"], ["v.pdf", "text"]]);
  assert.deepEqual(src("cpt-1 vct-1"), [["h.pdf", "ocr"]], "one OCR-only term makes the hit OCR");
  // the documented limit: a prefix whose best match is OCR-only badges OCR
  assert.deepEqual(src("cpt"), [["v.pdf", "text"], ["h.pdf", "ocr"]]);
  // a scan's read stays OCR even on its stray terms
  const m2 = mapOf(strayScan("s.pdf"));
  putSheetIndex(m2, "s.pdf", ocrOver("s.pdf"));
  assert.deepEqual(runPlanSearch("op1", m2, ["s.pdf"]).hits.map((h) => h.source), ["ocr"]);
});

test("seedFromThumb: a hybrid's record seeds a text-layer entry with its pictures, which needsRead", () => {
  const ix = seedFromThumb({ textLayer: true, pictures: [P] }, "h.pdf", () => false);
  assert.deepEqual(ix, { ...buildSheetIndex("h.pdf", [], "text"), textLayer: true, pictures: [P], seeded: true });
  assert.equal(needsRead(ix!), true);
  assert.equal(seedFromThumb({ textLayer: true, pictures: [] }, "v.pdf", () => false), null, "no picture: nothing to seed");
  assert.equal(seedFromThumb({ textLayer: true, pictures: "failed" }, "v.pdf", () => false), null);
  assert.equal(seedFromThumb({ textLayer: true, pictures: [P] }, "h.pdf", () => true), null, "never over an entry");
  // a scan seeds as before, now with its record's flag, so a read over it
  // carries "scan" whatever its own line count (#489 review)
  assert.deepEqual(seedFromThumb({ textLayer: false, pictures: [] }, "s.pdf", () => false), { ...buildSheetIndex("s.pdf", [], "text"), textLayer: false, seeded: true });
});

test("thumbIndexStep: a vector record without pictures reads its page once (doc loaded); a scan record never", () => {
  assert.deepEqual(thumbIndexStep({ textLayer: true }, "v.pdf", () => undefined, () => true), { kind: "read" });
  assert.deepEqual(thumbIndexStep({ textLayer: true }, "v.pdf", () => labelled("v.pdf"), () => true), { kind: "read" });
  assert.deepEqual(thumbIndexStep({ textLayer: true }, "v.pdf", () => undefined, () => false), { kind: "none" });
  assert.deepEqual(thumbIndexStep({ textLayer: false }, "s.pdf", () => textless("s.pdf"), () => true), { kind: "none" });
  assert.deepEqual(thumbIndexStep({ textLayer: true, pictures: [] }, "v.pdf", () => measured("v.pdf"), () => true), { kind: "none" });
});

test("thumbIndexStep: a measured entry flags a record without pictures, no page read", () => {
  assert.deepEqual(thumbIndexStep({ textLayer: true }, "v.pdf", () => measured("v.pdf"), () => true), { kind: "flag", textLayer: true, pictures: [] });
  assert.deepEqual(thumbIndexStep({}, "h.pdf", () => hyb("h.pdf"), () => false), { kind: "flag", textLayer: true, pictures: [P] });
  // a hybrid's read: never flagged as a scan
  const map = mapOf(hyb("h.pdf"));
  putSheetIndex(map, "h.pdf", ocrOver("h.pdf"));
  assert.deepEqual(thumbIndexStep({}, "h.pdf", (k) => map.get(k), () => true), { kind: "flag", textLayer: true, pictures: [P] });
  assert.deepEqual(thumbIndexStep({ textLayer: true }, "h.pdf", (k) => map.get(k), () => true), { kind: "flag", textLayer: true, pictures: [P] });
});

test("thumbIndexStep: a measured record puts its pictures on a text entry that has none (adopt), else seeds or nothing", () => {
  assert.deepEqual(thumbIndexStep({ textLayer: true, pictures: [P] }, "h.pdf", () => labelled("h.pdf"), () => true), { kind: "adopt", pictures: [P] });
  assert.deepEqual(thumbIndexStep({ textLayer: true, pictures: [] }, "v.pdf", () => labelled("v.pdf"), () => false), { kind: "adopt", pictures: [] });
  assert.deepEqual(thumbIndexStep({ textLayer: true, pictures: [P] }, "h.pdf", () => hyb("h.pdf"), () => true), { kind: "none" }, "already measured");
  assert.deepEqual(thumbIndexStep({ textLayer: true, pictures: [P] }, "h.pdf", () => undefined, () => true), { kind: "seed", ix: hybSeed("h.pdf") });
  // what adopt does: the entry takes them through putSheetIndex
  const map = mapOf(labelled("h.pdf"));
  assert.equal(putSheetIndex(map, "h.pdf", { ...map.get("h.pdf")!, pictures: [P] }), true);
  assert.equal(needsRead(map.get("h.pdf")), true);
});

test("unreadLine: one wording for scans and pictures", () => {
  assert.equal(unreadLine(3, "available"), "3 sheets with scans or pictures that haven't been read");
  assert.equal(unreadLine(1, "available"), "1 sheet with a scan or a picture that hasn't been read");
});

test("pageTextIndex: a text pass records whether the page has a text layer, and the pictures it was handed", () => {
  const vec = { items: Array.from({ length: 12 }, (_, i) => item(`NOTE ${i}`, 10, 900 - i * 40)) };
  assert.equal(pageTextIndex("v.pdf", vec, VP).textLayer, true);
  assert.equal("pictures" in pageTextIndex("v.pdf", vec, VP), false, "not measured");
  assert.deepEqual(pageTextIndex("v.pdf", vec, VP, undefined, [P]).pictures, [P]);
  assert.equal(pageTextIndex("s.pdf", { items: [item("SCANNED", 10, 10)] }, VP).textLayer, false);
});

// ── #489 review: reads that still need measuring, the scan flag on reads ────

const tu = (key: string): SheetIndex => ({ ...vector(key), textLayer: true });   // the label loop's pass

test("needsTextPass: a read whose sheet isn't a scan by its flag, with pictures not measured, still needs a pass", () => {
  const overNothing = (key: string) => { const m = new Map<string, SheetIndex>(); putSheetIndex(m, key, ocrOver(key)); return m; };
  // read over nothing, then the label loop's pass: stray recorded, nothing measured
  const m = overNothing("h.pdf");
  putSheetIndex(m, "h.pdf", tu("h.pdf"));
  assert.ok(m.get("h.pdf")!.stray);
  assert.equal(needsTextPass(m.get("h.pdf")), true, "textLayer true, not measured");
  // flag unknown (a pass that carried none), not measured: asks too
  const m2 = mapOf(vector("u.pdf"));
  putSheetIndex(m2, "u.pdf", ocrOver("u.pdf"));
  assert.equal(m2.get("u.pdf")!.textLayer, undefined);
  assert.equal(needsTextPass(m2.get("u.pdf")), true);
  // a scan by its flag never: it has nothing to measure
  const m3 = mapOf({ ...strayScan("s.pdf"), textLayer: false });
  putSheetIndex(m3, "s.pdf", ocrOver("s.pdf"));
  assert.equal(needsTextPass(m3.get("s.pdf")), false);
  // measured (or failed): no
  const m4 = mapOf(hyb("v.pdf"));
  putSheetIndex(m4, "v.pdf", ocrOver("v.pdf"));
  assert.equal(needsTextPass(m4.get("v.pdf")), false);
  const m5 = mapOf(measured("f.pdf", "failed"));
  putSheetIndex(m5, "f.pdf", ocrOver("f.pdf"));
  assert.equal(needsTextPass(m5.get("f.pdf")), false);
});

test("putSheetIndex: a measured pass over a read that already had its pass adopts pictures and a missing flag, terms not folded twice", () => {
  const m = mapOf(vector("h.pdf"));             // a pass that carried no flag
  putSheetIndex(m, "h.pdf", ocrOver("h.pdf"));
  const before = m.get("h.pdf")!;
  assert.ok(before.stray);
  assert.equal(putSheetIndex(m, "h.pdf", hyb("h.pdf")), true);
  const after = m.get("h.pdf")!;
  assert.equal(after.textLayer, true);
  assert.deepEqual(after.pictures, [P]);
  assert.deepEqual(after.terms, before.terms, "each term at the larger count, not summed");
  assert.deepEqual(after.stray, before.stray);
});

test("thumbIndexStep: a measured record's pictures are adopted onto a read that has none, and its flag when the read has none", () => {
  const rec = { textLayer: true, pictures: [P] };
  // read over nothing: no flag, no pictures, no pass yet
  const m = new Map<string, SheetIndex>();
  putSheetIndex(m, "h.pdf", ocrOver("h.pdf"));
  const step = thumbIndexStep(rec, "h.pdf", (k) => m.get(k), () => true);
  assert.deepEqual(step, { kind: "adopt", pictures: [P], textLayer: true });
  const { kind: _k, ...fields } = step as { kind: string };
  assert.equal(putSheetIndex(m, "h.pdf", { ...m.get("h.pdf")!, ...fields }), true);
  assert.equal(isHybrid(m.get("h.pdf")!), true);
  assert.equal(galleryReadView(m.get("h.pdf"), "available", undefined).what, "picture");
  // its text pass is still asked for, and badges the text layer's words text
  assert.equal(needsTextPass(m.get("h.pdf")), true);
  putSheetIndex(m, "h.pdf", tu("h.pdf"));
  assert.deepEqual(runPlanSearch("room", m, ["h.pdf"]).hits.map((h) => h.source), ["text"]);
  assert.deepEqual(runPlanSearch("vct-1", m, ["h.pdf"]).hits.map((h) => h.source), ["ocr"]);
  assert.equal(needsTextPass(m.get("h.pdf")), false);
  // a read with its pass and flag: only the pictures, terms and stray untouched
  const m2 = new Map<string, SheetIndex>();
  putSheetIndex(m2, "h.pdf", ocrOver("h.pdf"));
  putSheetIndex(m2, "h.pdf", tu("h.pdf"));
  const before = m2.get("h.pdf")!;
  const step2 = thumbIndexStep(rec, "h.pdf", (k) => m2.get(k), () => true);
  assert.deepEqual(step2, { kind: "adopt", pictures: [P] });
  assert.equal(putSheetIndex(m2, "h.pdf", { ...before, pictures: [P] }), true);
  assert.deepEqual(m2.get("h.pdf")!.terms, before.terms);
  assert.deepEqual(m2.get("h.pdf")!.stray, before.stray);
  assert.deepEqual(m2.get("h.pdf")!.pictures, [P]);
  assert.equal(needsTextPass(m2.get("h.pdf")), false);
  // a read already measured: nothing
  assert.deepEqual(thumbIndexStep(rec, "h.pdf", (k) => m2.get(k), () => true), { kind: "none" });
});

test("thumbIndexStep: a hybrid's read placed over nothing is never flagged a scan", () => {
  const m = new Map<string, SheetIndex>();
  putSheetIndex(m, "h.pdf", ocrOver("h.pdf", Array.from({ length: 20 }, (_, i) => `WORD${i} CORRIDOR`)));
  assert.deepEqual(thumbIndexStep({}, "h.pdf", (k) => m.get(k), () => true), { kind: "read" });
  assert.deepEqual(thumbIndexStep({ textLayer: true }, "h.pdf", (k) => m.get(k), () => true), { kind: "read" });
  assert.deepEqual(thumbIndexStep({}, "h.pdf", (k) => m.get(k), () => false), { kind: "none" });
});

test("isScan: a read's own line count is no evidence; its carried flag is, and with none it counts as a scan (upstream)", () => {
  const many = buildSheetIndex("s.pdf", runs(...Array.from({ length: 20 }, (_, i) => `WORD${i} CORRIDOR`)), "ocr");
  assert.equal(isScan(many), true, "a read with no flag: a scan, as galleryReadView (an OCR entry is readable) always took it");
  assert.equal(isScan({ ...many, textLayer: true }), false);
  assert.equal(isScan({ ...many, textLayer: false }), true);
  // a scan's read over its seed carries the seed's flag
  const m = mapOf(seedOf("s.pdf"));
  putSheetIndex(m, "s.pdf", many);
  assert.equal(m.get("s.pdf")!.textLayer, false);
  assert.equal(isScan(m.get("s.pdf")!), true);
  assert.equal(isHybrid(m.get("s.pdf")!), false);
});

test("putSheetIndex: a seed over a seed replaces it whole (nothing carried); a text pass over a seed still carries", () => {
  const m = mapOf(hybSeed("x.pdf"));
  putSheetIndex(m, "x.pdf", seedOf("x.pdf"));
  assert.deepEqual(m.get("x.pdf"), seedOf("x.pdf"));
  assert.equal(isHybrid(m.get("x.pdf")!), false);
  const m2 = mapOf(seedOf("y.pdf"));
  putSheetIndex(m2, "y.pdf", hybSeed("y.pdf"));
  assert.deepEqual(m2.get("y.pdf"), hybSeed("y.pdf"));
  const m3 = mapOf(hybSeed("z.pdf"));
  putSheetIndex(m3, "z.pdf", tu("z.pdf"));
  assert.deepEqual(m3.get("z.pdf")!.pictures, [P]);
});

// ── "failed" is the weakest measurement (#489 slice-3 review) ───────────────
// An op list this session couldn't read says nothing against pictures found
// on the same bytes: any real measurement (an array, empty included) replaces
// "failed", "failed" never replaces one, and an unmeasured entry takes either.

test("putSheetIndex: text over text, a measurement replaces failed, never the reverse", () => {
  const m = mapOf(measured("h.pdf", "failed"));
  assert.equal(putSheetIndex(m, "h.pdf", hyb("h.pdf")), true);
  assert.deepEqual(m.get("h.pdf")!.pictures, [P]);
  assert.equal(putSheetIndex(m, "h.pdf", measured("h.pdf", "failed")), false);
  assert.deepEqual(m.get("h.pdf")!.pictures, [P]);
  const m2 = mapOf(measured("v.pdf", "failed"));
  assert.equal(putSheetIndex(m2, "v.pdf", measured("v.pdf", [])), true, "measured, no picture, still beats failed");
  assert.deepEqual(m2.get("v.pdf")!.pictures, []);
  const m3 = mapOf(labelled("f.pdf"));
  assert.equal(putSheetIndex(m3, "f.pdf", measured("f.pdf", "failed")), true, "failed beats unmeasured");
  assert.equal(m3.get("f.pdf")!.pictures, "failed");
});

test("putSheetIndex: a read's later text pass, a measurement replaces failed, never the reverse", () => {
  const m = new Map<string, SheetIndex>();
  putSheetIndex(m, "h.pdf", ocrOver("h.pdf"));
  putSheetIndex(m, "h.pdf", measured("h.pdf", "failed"));   // its first pass
  assert.equal(m.get("h.pdf")!.pictures, "failed");
  assert.equal(putSheetIndex(m, "h.pdf", hyb("h.pdf")), true);
  assert.deepEqual(m.get("h.pdf")!.pictures, [P]);
  assert.equal(putSheetIndex(m, "h.pdf", measured("h.pdf", "failed")), false);
  assert.deepEqual(m.get("h.pdf")!.pictures, [P]);
  // the read's first pass: failed over a seed's pictures keeps them
  const m2 = mapOf(hybSeed("s.pdf"));
  putSheetIndex(m2, "s.pdf", ocrOver("s.pdf"));
  putSheetIndex(m2, "s.pdf", measured("s.pdf", "failed"));
  assert.deepEqual(m2.get("s.pdf")!.pictures, [P]);
});

test("putSheetIndex: carried fields, a failed pass over a seed keeps the seed's pictures; a read over failed keeps failed", () => {
  const m = mapOf(hybSeed("h.pdf"));
  putSheetIndex(m, "h.pdf", measured("h.pdf", "failed"));
  assert.deepEqual(m.get("h.pdf")!.pictures, [P]);
  const m2 = mapOf(measured("f.pdf", "failed"));
  putSheetIndex(m2, "f.pdf", ocrOver("f.pdf"));
  assert.equal(m2.get("f.pdf")!.pictures, "failed");
});

test("thumbIndexStep: a record's pictures are adopted over failed; a failed record never adopts over anything measured", () => {
  const failed = () => measured("h.pdf", "failed");
  assert.deepEqual(thumbIndexStep({ textLayer: true, pictures: [P] }, "h.pdf", failed, () => true), { kind: "adopt", pictures: [P] });
  assert.deepEqual(thumbIndexStep({ textLayer: true, pictures: [] }, "h.pdf", failed, () => true), { kind: "adopt", pictures: [] });
  assert.deepEqual(thumbIndexStep({ textLayer: true, pictures: "failed" }, "h.pdf", failed, () => true), { kind: "none" });
  assert.deepEqual(thumbIndexStep({ textLayer: true, pictures: "failed" }, "h.pdf", () => hyb("h.pdf"), () => true), { kind: "none" });
  assert.deepEqual(thumbIndexStep({ textLayer: true, pictures: "failed" }, "h.pdf", () => labelled("h.pdf"), () => true), { kind: "adopt", pictures: "failed" });
  // adopting it lands through putSheetIndex
  const m = mapOf(failed());
  assert.equal(putSheetIndex(m, "h.pdf", { ...m.get("h.pdf")!, pictures: [P] }), true);
  assert.equal(needsRead(m.get("h.pdf")), true);
});

test("thumbIndexStep: flag never hands back failed pictures (they are session-only, never saved)", () => {
  const failed = () => measured("f.pdf", "failed");
  // an old record: its flag from the entry, without the pictures
  assert.deepEqual(thumbIndexStep({}, "f.pdf", failed, () => true), { kind: "flag", textLayer: true });
  // a record that has its flag: nothing to save, and the op list already failed this session
  assert.deepEqual(thumbIndexStep({ textLayer: true }, "f.pdf", failed, () => true), { kind: "none" });
  assert.deepEqual(thumbIndexStep({ textLayer: true }, "f.pdf", failed, () => false), { kind: "none" });
});

// ── readPlanOf: what a read reads, from the sheet's index entry ─────────────

test("readPlanOf: a scan whole, a hybrid's pictures × rs, else nothing", () => {
  const rs = 2;
  const times = (r: Rect, k: number) => ({ x0: r.x0 * k, y0: r.y0 * k, x1: r.x1 * k, y1: r.y1 * k });
  assert.deepEqual(readPlanOf(textless("s.pdf"), rs), { kind: "scan" });
  assert.deepEqual(readPlanOf(strayScan("s.pdf"), rs), { kind: "scan" });
  assert.deepEqual(readPlanOf(seedFromThumb({ textLayer: false }, "s.pdf", () => false)!, rs), { kind: "scan" }, "a scan's seed");
  assert.deepEqual(readPlanOf(hyb("h.pdf"), rs), { kind: "pictures", rects: [times(P, rs)] });
  assert.deepEqual(readPlanOf(hybSeed("h.pdf"), rs), { kind: "pictures", rects: [times(P, rs)] }, "a hybrid's seed");
  assert.deepEqual(readPlanOf(measured("v.pdf", []), rs), { kind: "none" }, "vector, measured, no picture");
  assert.deepEqual(readPlanOf(vector("v.pdf"), rs), { kind: "none" }, "vector, no flag, not measured");
  assert.deepEqual(readPlanOf(labelled("v.pdf"), rs), { kind: "none" }, "not measured");
  assert.deepEqual(readPlanOf(measured("v.pdf", "failed"), rs), { kind: "none" }, "op list failed");
  assert.equal(readPlanOf(undefined, rs), undefined, "not indexed: no plan (readPageText reads the page whole, as before #489)");
  // read again: a scan's read is a scan, a hybrid's read its pictures
  assert.deepEqual(readPlanOf(read("s.pdf"), rs), { kind: "scan" });
  const m = mapOf(hyb("h.pdf"));
  putSheetIndex(m, "h.pdf", ocrOver("h.pdf"));
  assert.deepEqual(readPlanOf(m.get("h.pdf"), rs), { kind: "pictures", rects: [times(P, rs)] });
  // a stitch is never read
  assert.deepEqual(readPlanOf(textless("stitch:abc"), rs), { kind: "none" });
});

test("readPlanOf: an OCR entry plans by what it carries: over nothing a scan, over a hybrid its pictures, over an unmeasured or failed vector entry nothing", () => {
  const rs = 2;
  assert.deepEqual(readPlanOf(ocrOver("o.pdf"), rs), { kind: "scan" }, "a read over nothing: a scan (reads only ran on scans before #489)");
  for (const base of [labelled("v.pdf"), measured("v.pdf", "failed")]) {
    const m = mapOf(base);
    putSheetIndex(m, "v.pdf", ocrOver("v.pdf"));
    assert.deepEqual(readPlanOf(m.get("v.pdf"), rs), { kind: "none" });
  }
});

test("readWhat: what a read of the sheet covers, from readPlanOf: page, picture, or nothing to read", () => {
  assert.equal(readWhat(textless("s.pdf")), "page");
  assert.equal(readWhat(hybSeed("h.pdf")), "picture");
  assert.equal(readWhat(hyb("h.pdf")), "picture");
  assert.equal(readWhat(measured("v.pdf")), null);
  assert.equal(readWhat(labelled("v.pdf")), null);
  assert.equal(readWhat(textless("stitch:abc")), null);
  assert.equal(readWhat(undefined), null, "not indexed: nothing offered");
  const m = mapOf(hyb("h.pdf"));
  putSheetIndex(m, "h.pdf", ocrOver("h.pdf"));
  assert.equal(readWhat(m.get("h.pdf")), "picture", "a hybrid's read: its pictures again");
});

test("galleryReadView offers only what readPlanOf would read: a read over an unmeasured vector entry shows nothing", () => {
  for (const base of [labelled("v.pdf"), measured("v.pdf", "failed")]) {
    const m = mapOf(base);
    putSheetIndex(m, "v.pdf", ocrOver("v.pdf"));
    assert.equal(readPlanOf(m.get("v.pdf"), 2)?.kind, "none");
    assert.deepEqual(galleryReadView(m.get("v.pdf"), "available", { state: "done", ms: 1, rasters: 1, stale: true, cached: true }), { kind: "hidden", what: "page" });
  }
  // a read over nothing still plans (and shows) as a scan
  assert.equal(galleryReadView(ocrOver("o.pdf"), "available", { state: "done", ms: 1000, rasters: 1, stale: true, cached: true }).kind, "done");
});

test("mayLookUp: no cache lookup for a sheet whose entry plans no read (it was never read; a lookup now would memoize a miss)", () => {
  assert.equal(mayLookUp(labelled("v.pdf")), false, "not measured yet: a hybrid's pictures read must wait for its plan");
  assert.equal(mayLookUp(measured("v.pdf")), false);
  assert.equal(mayLookUp(measured("v.pdf", "failed")), false);
  assert.equal(mayLookUp(textless("stitch:abc")), false);
  assert.equal(mayLookUp(textless("s.pdf")), true);
  assert.equal(mayLookUp(hyb("h.pdf")), true);
  assert.equal(mayLookUp(hybSeed("h.pdf")), true);
  // no entry yet (Copy before the canvas measured the sheet): no lookup. A
  // whole-page lookup could land a hybrid's saved pictures read as an OCR
  // entry over nothing, which plans (and offers Read again) as a scan
  assert.equal(mayLookUp(undefined), false, "no entry: wait for the sheet's plan");
});

test("readableFromIndex: the canvas's Read rows follow the index — re-derived on change, gone when the entry is dropped, the same object when nothing changed", () => {
  const m = mapOf(labelled("h.pdf"), textless("s.pdf"), measured("v.pdf"));
  const prev = { "h.pdf": null, "s.pdf": "page", "v.pdf": null } as const;
  assert.equal(readableFromIndex(prev, m), prev, "nothing changed: the same object (no re-render)");
  const empty = {};
  assert.equal(readableFromIndex(empty, m), empty, "only keys already shown are derived (a sheet not measured stays unknown)");
  // the gallery adopts a kept record's pictures after the canvas found none
  putSheetIndex(m, "h.pdf", adoptEntry(m.get("h.pdf")!, { pictures: [P] }));
  const adopted = readableFromIndex(prev, m);
  assert.notEqual(adopted, prev);
  assert.deepEqual(adopted, { "h.pdf": "picture", "s.pdf": "page", "v.pdf": null });
  // the file is dropped from the index: its row goes
  m.delete("s.pdf");
  assert.deepEqual(readableFromIndex(adopted, m), { "h.pdf": "picture", "v.pdf": null });
});

test("adoptEntry: a kept record's pictures go onto a text entry, which takes them", () => {
  const m = mapOf(labelled("h.pdf"));
  const have = m.get("h.pdf")!;
  assert.equal(putSheetIndex(m, "h.pdf", adoptEntry(have, { pictures: [P] })), true);
  assert.deepEqual(m.get("h.pdf")!.pictures, [P]);
  assert.equal(m.get("h.pdf")!.source, "text");
  assert.equal(isHybrid(m.get("h.pdf")!), true);
  // over "failed" too
  const f = mapOf(measured("h.pdf", "failed"));
  assert.equal(putSheetIndex(f, "h.pdf", adoptEntry(f.get("h.pdf")!, { pictures: [P] })), true);
  assert.deepEqual(f.get("h.pdf")!.pictures, [P]);
});

test("adoptEntry onto a read placed over nothing: it stays a read (no stray), takes the flag and pictures, and its picture terms stay OCR", () => {
  const m = new Map<string, SheetIndex>();
  putSheetIndex(m, "h.pdf", ocrOver("h.pdf", ["VCT-1", "BROADLOOM"]));
  const have = m.get("h.pdf")!;
  assert.equal(have.stray, undefined);
  assert.equal(putSheetIndex(m, "h.pdf", adoptEntry(have, { pictures: [P], textLayer: true })), true);
  const got = m.get("h.pdf")!;
  assert.equal(got.source, "ocr");
  assert.equal(got.stray, undefined);
  assert.deepEqual(got.terms, have.terms);
  assert.equal(got.textLayer, true);
  assert.deepEqual(got.pictures, [P]);
  assert.equal(runPlanSearch("vct-1", m, ["h.pdf"]).ocrKeys.has("h.pdf"), true);
  // and onto a hybrid's read with its text pass: stray kept, text terms still badge text
  const r = mapOf(labelled("h.pdf"));
  putSheetIndex(r, "h.pdf", ocrOver("h.pdf"));
  const before = r.get("h.pdf")!;
  putSheetIndex(r, "h.pdf", adoptEntry(before, { pictures: [P] }));
  assert.deepEqual(r.get("h.pdf")!.stray, before.stray);
  assert.deepEqual(r.get("h.pdf")!.terms, before.terms);
  assert.deepEqual(r.get("h.pdf")!.pictures, [P]);
  assert.equal(runPlanSearch("room", r, ["h.pdf"]).ocrKeys.has("h.pdf"), false);
});

// real pages, measured as the walk and the thumbnails measure them
const RS = 2;
const realIndex = async (bytes: Uint8Array, n = 1) => {
  const page = await (await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, verbosity: 0 }).promise).getPage(n);
  const p: MeasurablePage = { getTextContent: () => page.getTextContent() as never, getOperatorList: () => page.getOperatorList() as unknown as Promise<OpList> };
  return (await measurePage(`p${n}`, p, page.getViewport({ scale: RS }), pdfjs.OPS as unknown as Record<string, number>)).index;
};
const fileBytes = (rel: string) => new Uint8Array(readFileSync(new URL(rel, import.meta.url)));
const near = (a: Rect, b: Rect, tol: number) =>
  Math.abs(a.x0 - b.x0) <= tol && Math.abs(a.y0 - b.y0) <= tol && Math.abs(a.x1 - b.x1) <= tol && Math.abs(a.y1 - b.y1) <= tol;
const timesRs = (r: Rect) => ({ x0: r.x0 * RS, y0: r.y0 * RS, x1: r.x1 * RS, y1: r.y1 * RS });

test("readPlanOf on a measured hybrid sheet: its one picture, in px at rs", async () => {
  const p = readPlanOf(await realIndex(await buildHybridPlan("callouts")), RS);
  assert.equal(p.kind, "pictures");
  if (p.kind !== "pictures") return;
  assert.equal(p.rects.length, 1);
  assert.ok(near(p.rects[0], timesRs(PICTURE), RS), JSON.stringify(p.rects));
});

test("readPlanOf on Porterville A1-101: the raster table, not the seal", async () => {
  const p = readPlanOf(await realIndex(fileBytes("../../evals/mcp-workflow-bench/plan-set/porterville/porterville-adu-a1-101.pdf")), RS);
  assert.equal(p.kind, "pictures");
  if (p.kind !== "pictures") return;
  assert.equal(p.rects.length, 1);
  assert.ok(near(p.rects[0], timesRs({ x0: 1469, y0: 453, x1: 1843, y1: 713 }), RS), JSON.stringify(p.rects));
});

test("readPlanOf on a scanned sheet: the whole page", async () => {
  assert.deepEqual(readPlanOf(await realIndex(fileBytes("../../mcp/test/fixtures/scanned-plan.pdf")), RS), { kind: "scan" });
});

test("readPlanOf on the demo's vector sheets: nothing to read", async () => {
  const bytes = fileBytes("../public/demo/sample-finish-plan.pdf");
  for (const n of [1, 2]) assert.deepEqual(readPlanOf(await realIndex(bytes, n), RS), { kind: "none" }, `page ${n}`);
});
