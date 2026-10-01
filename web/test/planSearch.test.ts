// Plan-set search over the gallery's index map — planSearch.ts is pure (no
// DOM, no pdf.js), so it runs straight under node. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSheetIndex, searchPlan, type IndexedTextItem, type SheetIndex } from "../src/lib/planIndex.ts";
import {
  runPlanSearch, ocrWordsToItems, ocrSheetIndex, putSheetIndex, filesToIndex, pagesToIndex, galleryEscStep, createChangeSignal,
  needsRead, keysToLookUp, canLookUp, galleryReadView, unreadLine, createWalkFailures, searchFailedLine, retryWalk, seedFromThumb, thumbTextUnknown, galleryCountLine, thumbIndexStep, isIndexed, needsTextPass,
} from "../src/lib/planSearch.ts";
import { pageTextIndex } from "../src/lib/pageTextIndex.ts";

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
  assert.deepEqual(galleryReadView(textless("a.pdf"), "available", undefined), { kind: "read" });
  assert.deepEqual(galleryReadView(textless("a.pdf"), "error", undefined), { kind: "unreachable", text: "The on-device text reader (OCR) couldn't be reached" });
  assert.deepEqual(galleryReadView(textless("a.pdf"), "disabled", undefined), { kind: "hidden" });
  assert.deepEqual(galleryReadView(textless("a.pdf"), null, undefined), { kind: "hidden" }, "not probed yet");
  assert.deepEqual(galleryReadView(vector("a.pdf"), "available", undefined), { kind: "hidden" });
  assert.deepEqual(galleryReadView(undefined, "available", undefined), { kind: "hidden" }, "not indexed yet");
});

test("galleryReadView: progress and Cancel while reading, Stopping… after, the time once read (labelled OCR)", () => {
  assert.deepEqual(galleryReadView(textless("a.pdf"), "available", { state: "reading", progress: { phase: "tiles", done: 1, total: 4, rastersDone: 1, rastersPlanned: 4 } }), { kind: "reading", text: "Reading tiles 1/4" });
  assert.deepEqual(galleryReadView(textless("a.pdf"), "available", { state: "stopping" }), { kind: "stopping", text: "Stopping…" });
  // once read, its index entry is OCR: still a text-less sheet
  const done = galleryReadView(read("a.pdf"), "available", { state: "done", ms: 3200, rasters: 6, stale: false, cached: false });
  assert.equal(done.kind, "done");
  assert.match(done.kind === "done" ? done.text : "", /OCR/);
});

test("unreadLine: only when OCR is available and a sheet is unread; singular and plural", () => {
  assert.equal(unreadLine(3, "available"), "3 sheets have little or no text layer and haven't been read");
  assert.equal(unreadLine(1, "available"), "1 sheet has little or no text layer and hasn't been read");
  assert.equal(unreadLine(0, "available"), null);
  for (const a of ["disabled", "uninstalled", null]) assert.equal(unreadLine(2, a), null);
  assert.equal(unreadLine(2, "error"), "The on-device text reader (OCR) couldn't be reached", "a probe error says so (with Retry)");
  assert.equal(unreadLine(0, "error"), null);
});

// ── seeding the index from a thumbnail record ────────────────────────────────

test("seedFromThumb: a record that says no text layer seeds the empty text entry, which needsRead", () => {
  const ix = seedFromThumb({ textLayer: false }, "scan.pdf#2", () => false);
  assert.ok(ix);
  assert.deepEqual(ix, { ...buildSheetIndex("scan.pdf#2", [], "text"), seeded: true }, "the entry pageTextIndex gives a page with no tokens, marked provisional");
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

test("thumbIndexStep: seed a scan's record, read an old record's page once, else nothing", () => {
  const none = () => undefined;
  const loaded = () => true;
  assert.deepEqual(thumbIndexStep({ textLayer: false }, "scan.pdf", none, loaded), { kind: "seed", ix: seedFromThumb({ textLayer: false }, "scan.pdf", () => false) });
  assert.deepEqual(thumbIndexStep({}, "old.pdf", none, loaded), { kind: "read" });
  assert.deepEqual(thumbIndexStep({ textLayer: true }, "vec.pdf", none, loaded), { kind: "none" });
  assert.deepEqual(thumbIndexStep({ textLayer: false }, "scan.pdf", () => vector("scan.pdf"), loaded), { kind: "none" }, "already indexed: nothing");
});

test("thumbIndexStep: an old record whose sheet is already indexed takes its flag from the entry, no page read", () => {
  const loaded = () => true;
  assert.deepEqual(thumbIndexStep({}, "vec.pdf", () => vector("vec.pdf"), loaded), { kind: "flag", textLayer: true });
  assert.deepEqual(thumbIndexStep({}, "scan.pdf", () => textless("scan.pdf"), loaded), { kind: "flag", textLayer: false });
  // an OCR entry means the sheet had no text layer, whatever OCR found
  assert.deepEqual(thumbIndexStep({}, "read.pdf", () => read("read.pdf", ["ROOM 101"]), loaded), { kind: "flag", textLayer: false });
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
  const real = buildSheetIndex("a.pdf", runs("CPT-1 CORRIDOR"));
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
  assert.deepEqual(galleryReadView(strayScan("a.pdf", 3), "available", undefined), { kind: "read" });
  assert.deepEqual(galleryReadView(strayScan("a.pdf", 8), "available", undefined), { kind: "read" });
  assert.deepEqual(galleryReadView(strayScan("a.pdf", 9), "available", undefined), { kind: "hidden" });
  assert.deepEqual(galleryReadView(vector("a.pdf"), "available", undefined), { kind: "hidden" });
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

test("putSheetIndex: a sheet with a text layer merges nothing into an OCR entry", () => {
  const map = mapOf(vector("v.pdf"));
  putSheetIndex(map, "v.pdf", buildSheetIndex("v.pdf", runs("CORRIDOR"), "ocr"));
  assert.equal(map.get("v.pdf")!.terms["CPT-1"], undefined);
  const map2 = mapOf(buildSheetIndex("w.pdf", runs("CORRIDOR"), "ocr"));
  assert.equal(putSheetIndex(map2, "w.pdf", vector("w.pdf")), false);
  assert.equal(map2.get("w.pdf")!.terms["CPT-1"], undefined);
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
  // a read over the scan's own text entry has had its text pass
  const m2 = mapOf(strayScan("t.pdf"));
  putSheetIndex(m2, "t.pdf", buildSheetIndex("t.pdf", runs("CORRIDOR"), "ocr"));
  assert.equal(needsTextPass(m2.get("t.pdf")), false);
  // a read placed over a sheet with a text layer: its text pass happened too
  const m3 = mapOf(vector("x.pdf"));
  putSheetIndex(m3, "x.pdf", buildSheetIndex("x.pdf", runs("CORRIDOR"), "ocr"));
  assert.equal(needsTextPass(m3.get("x.pdf")), false);
  assert.equal(needsTextPass(strayScan("u.pdf")), false);
  assert.equal(needsTextPass(vector("v.pdf")), false);
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
  // a page that turns out to have a text layer: nothing merged, pass recorded
  const m2 = mapOf(seedOf("v.pdf"));
  putSheetIndex(m2, "v.pdf", buildSheetIndex("v.pdf", runs("CORRIDOR"), "ocr"));
  assert.equal(putSheetIndex(m2, "v.pdf", vector("v.pdf")), false);
  assert.equal(m2.get("v.pdf")!.terms["CPT-1"], undefined);
  assert.equal(needsTextPass(m2.get("v.pdf")), false);
});

test("the search walk reopens a file only for a read still waiting for its text pass", () => {
  const map = mapOf(seedOf("pending.pdf"), strayScan("done.pdf"), vector("vec.pdf"));
  putSheetIndex(map, "pending.pdf", buildSheetIndex("pending.pdf", runs("CORRIDOR"), "ocr"));
  putSheetIndex(map, "done.pdf", buildSheetIndex("done.pdf", runs("LOBBY"), "ocr"));
  const has = (k: string) => !needsTextPass(map.get(k));
  assert.deepEqual(filesToIndex(["pending.pdf", "done.pdf", "vec.pdf"], () => 1, has).map((f) => f.file), ["pending.pdf"]);
  assert.deepEqual(pagesToIndex("pending.pdf", 1, has), ["pending.pdf"]);
});

