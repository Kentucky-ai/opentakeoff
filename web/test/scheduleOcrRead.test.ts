// Import from schedule's on-device read of a box (lib/scheduleOcrRead.ts
// readBoxOnDevice), run through the REAL OCR session (lib/ocr/session.ts)
// with a fake client and a fake download notice, as ocrSession.test.ts does.
// Pinned:
//   - the engine starts as the person agreed (cached: no notice; else the
//     notice, and only Download downloads), then the box is rendered and
//     read, and the reader's result is routed (rows, refusal, no rows);
//   - a box too large to read (tooLarge(), the canvas's readTooLarge on the
//     box clipped to the page) is its message before the session runs: no
//     notice, no engine start; a PageTooLargeError from the read is the same;
//   - onReading fires before the read, so the status line says "Reading"
//     for the whole read, and only once the engine is up; the read's
//     progress reaches onProgress while the read is wanted;
//   - a read the person left (aborted, or isCurrent() false: another sheet)
//     is "cancelled" at every step — before the read, after it, and after
//     the session answers — and the steps after it never run; a read that
//     fails while it is no longer wanted, or with an AbortError nobody asked
//     for (the page closed), is cancelled too. The check after each render
//     inside the read is boxRead.ts's (test/ocrBoxRead.test.ts);
//   - turned off / not installed / declined / a failed start / a step that
//     throws each become their message; a throw after the abort is cancelled.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOcrSession, type ConsentNotice, type OcrSession } from "../src/lib/ocr/session.ts";
import type { OcrProbe, OcrProgress, OcrReady } from "../src/lib/ocr/client.ts";
import type { OcrManifest } from "../src/lib/ocr/manifest.ts";
import { wordsToSpans, type OcrWord } from "../src/lib/ocr/types.ts";
import type { GraphSpan } from "../src/lib/sheetgraph.ts";
import { readScheduleSpans, type ScheduleRead } from "../src/lib/scheduleRead.ts";
import { readFileSync } from "node:fs";
import type { ScheduleRow } from "../src/lib/scheduleRows.ts";
import { readBoxOnDevice } from "../src/lib/scheduleOcrRead.ts";
import {
  ocrUnavailableMessage, ocrFailedMessage, refusalMessage, OCR_DECLINED_MESSAGE, OCR_NO_ROWS_MESSAGE, OCR_TOO_LARGE_MESSAGE, OCR_NO_HEADER_MESSAGE, type BoxText,
} from "../src/lib/scheduleRoute.ts";
import type { SeamProgress } from "../src/lib/ocr/seams.ts";

const manifest: OcrManifest = { rev: "r1", files: [{ name: "det", url: "/models/ocr/det.onnx", bytes: 36_000_000, sha256: "a".repeat(64) }] };
const available = (cached: boolean, downloadBytes = cached ? 0 : 36_000_000): OcrProbe => ({ state: "available", manifest, cached, downloadBytes });

type EnsureOpts = { consent?: boolean; signal?: AbortSignal; onProgress?: (p: OcrProgress) => void };

/** ocrSession.test.ts's fake client (copied, not imported, so node:test
 * doesn't run that file's tests here): answers like client.ts ensureReady.
 * A start that goes to the worker waits in `ensure` until the test settles
 * it or its signal aborts. */
function fakeClient(start: OcrProbe, probes: OcrProbe[] = [start]) {
  const ensure: { opts: EnsureOpts; settle: (r: OcrReady) => void; settled: boolean }[] = [];
  const calls: EnsureOpts[] = [];
  let probeCalls = 0, ready = false;
  return {
    ensure,
    calls,
    consented: () => calls.filter((o) => o.consent === true).length,
    client: {
      async probe(): Promise<OcrProbe> { return probes[Math.min(probeCalls++, probes.length - 1)]; },
      ensureReady(opts: EnsureOpts = {}): Promise<OcrReady> {
        calls.push(opts);
        if (opts.signal?.aborted) return Promise.resolve({ ok: false, reason: "aborted" });
        if (ready) return Promise.resolve({ ok: true });
        if (start.state === "error") return Promise.resolve({ ok: false, reason: "error", message: start.message });
        if (start.state !== "available") return Promise.resolve({ ok: false, reason: start.state });
        if (!start.cached && opts.consent !== true) return Promise.resolve({ ok: false, reason: "consent-required" });
        return new Promise((resolve) => {
          const e = { opts, settled: false, settle: (r: OcrReady) => { if (!e.settled) { e.settled = true; if (r.ok) ready = true; resolve(r); } } };
          ensure.push(e);
          opts.signal?.addEventListener("abort", () => e.settle({ ok: false, reason: "aborted" }), { once: true });
        });
      },
    },
  };
}

/** A notice host the test answers; it never resolves on its own. */
function fakeHost() {
  const shown: { bytes: number; notice: ConsentNotice; answer: (d: "download" | "cancel") => void }[] = [];
  const requestConsent = (bytes: number, notice: ConsentNotice) => new Promise<"download" | "cancel">((resolve) => {
    shown.push({ bytes, notice, answer: resolve });
  });
  return { shown, requestConsent };
}

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

const row: ScheduleRow = {
  finish_tag: "CPT-1", section: "FLOORING", category: "floor", category_source: "heading", description: "CARPET TILE",
  manufacturer: "VENDOR-A", style: "", spec_color: "", size: "", remarks: "", suggested: true,
};
const WORDS: OcrWord[] = [{ str: "CPT-1", x: 10, y: 30, w: 40, h: 12 }, { str: "CARPET", x: 80, y: 30, w: 50, h: 12 }];
const RASTER_BOX: BoxText = { textRuns: 0, pageHasText: false };
const PROGRESS: SeamProgress = { phase: "tiles", done: 1, total: 4, rastersDone: 1, rastersPlanned: 4 };

type ReadWords = (signal?: AbortSignal, onProgress?: (p: SeamProgress) => void) => Promise<OcrWord[]>;

/** The box read's injected steps, each recording its call in `log`.
 * Overrides replace a step's behavior (they still log). */
function harness(opts: {
  probe?: OcrProbe;
  result?: ScheduleRead;
  /** the finish reader itself, in place of `result` */
  reader?: (spans: GraphSpan[]) => ScheduleRead;
  readWords?: ReadWords;
  tooLarge?: () => boolean;
  isCurrent?: (step: string) => boolean;
  box?: BoxText;
  ac?: AbortController;
  /** wraps session.run, to see the session's answer or act after it */
  afterRun?: (r: unknown) => void;
  /** the client's whenIdle; absent = not passed */
  whenIdle?: () => Promise<void>;
} = {}) {
  const c = fakeClient(opts.probe ?? available(true)), host = fakeHost();
  const real = createOcrSession({ client: c.client, requestConsent: host.requestConsent });
  const ac = opts.ac ?? new AbortController();
  const log: string[] = [];
  const runs: unknown[] = [];
  const readCalls: GraphSpan[][] = [];
  const readWordsSignals: (AbortSignal | undefined)[] = [];
  const progress: SeamProgress[] = [];
  let step = "start";
  const session: Pick<OcrSession, "run"> = {
    async run(task, o) {
      const r = await real.run(task, o);
      runs.push(r);
      opts.afterRun?.(r);
      return r;
    },
  };
  const p = readBoxOnDevice({
    session,
    readWords: async (signal, onProgress) => {
      log.push("readWords");
      readWordsSignals.push(signal);
      const w = await (opts.readWords ?? (async (_s, op) => { op?.(PROGRESS); return WORDS; }))(signal, onProgress);
      step = "words";
      return w;
    },
    tooLarge: () => { log.push("tooLarge"); return opts.tooLarge?.() ?? false; },
    read: (spans) => { log.push("read"); readCalls.push(spans); return opts.reader ? opts.reader(spans) : opts.result ?? { rows: [row] }; },
    isCurrent: () => (opts.isCurrent ? opts.isCurrent(step) : true),
    onReading: () => { log.push("onReading"); },
    onProgress: (pr) => { progress.push(pr); },
    ...(opts.whenIdle ? { whenIdle: async () => { log.push("whenIdle"); await opts.whenIdle!(); step = "idle"; }, onWaiting: () => { log.push("onWaiting"); } } : {}),
    signal: ac.signal,
    box: opts.box ?? RASTER_BOX,
  });
  return { c, host, ac, log, runs, readCalls, readWordsSignals, progress, p };
}

const CANCELLED = { kind: "cancelled" };

test("cached: no notice, onReading before the read, the words read as spans, rows routed", async () => {
  const h = harness();
  await flush();
  assert.equal(h.host.shown.length, 0, "no notice when the files are cached");
  assert.equal(h.c.consented(), 0);
  h.c.ensure[0].settle({ ok: true });
  assert.deepEqual(await h.p, { kind: "rows", rows: [row] });
  assert.deepEqual(h.log, ["tooLarge", "onReading", "readWords", "read"]);
  assert.deepEqual(h.readCalls, [wordsToSpans(WORDS)]);
  assert.deepEqual(h.readWordsSignals, [h.ac.signal], "the read gets the caller's signal, so Cancel stops a render or read under way");
  assert.deepEqual(h.progress, [PROGRESS], "the read's progress reaches the canvas");
});

test("too large: its message before the session runs — no notice, no engine start, nothing read", async () => {
  for (const probe of [available(true), available(false)]) {
    const h = harness({ probe, tooLarge: () => true });
    assert.deepEqual(await h.p, { kind: "message", text: OCR_TOO_LARGE_MESSAGE });
    assert.deepEqual(h.log, ["tooLarge"]);
    assert.deepEqual(h.runs, [], "session.run never called");
    assert.deepEqual(h.c.calls, []);
    assert.equal(h.host.shown.length, 0);
  }
});

test("a PageTooLargeError from the read: the same message", async () => {
  const h = harness({ readWords: async () => { throw Object.assign(new Error("more than 64 tiles"), { name: "PageTooLargeError" }); } });
  await flush();
  h.c.ensure[0].settle({ ok: true });
  assert.deepEqual(await h.p, { kind: "message", text: OCR_TOO_LARGE_MESSAGE });
});

test("not cached: the notice first, nothing read until Download, then rows", async () => {
  const h = harness({ probe: available(false, 12_345) });
  await flush();
  assert.equal(h.host.shown.length, 1);
  assert.equal(h.host.shown[0].bytes, 12_345);
  assert.deepEqual(h.log, ["tooLarge"], "nothing runs while the notice waits");
  h.host.shown[0].answer("download");
  await flush();
  assert.equal(h.c.consented(), 1);
  assert.deepEqual(h.log, ["tooLarge"], "nothing runs during the download");
  h.c.ensure[0].settle({ ok: true });
  assert.deepEqual(await h.p, { kind: "rows", rows: [row] });
  assert.deepEqual(h.log, ["tooLarge", "onReading", "readWords", "read"]);
});

test("the notice's Cancel: declined, nothing read", async () => {
  const h = harness({ probe: available(false) });
  await flush();
  h.host.shown[0].answer("cancel");
  assert.deepEqual(await h.p, { kind: "message", text: OCR_DECLINED_MESSAGE });
  assert.deepEqual(h.log, ["tooLarge"]);
  assert.equal(h.c.consented(), 0);
});

test("aborted while the notice waits: cancelled, and the notice closes", async () => {
  const h = harness({ probe: available(false) });
  await flush();
  assert.equal(h.host.shown.length, 1);
  h.ac.abort();
  assert.deepEqual(await h.p, CANCELLED);
  assert.equal(h.host.shown[0].notice.signal.aborted, true);
  assert.deepEqual(h.log, ["tooLarge"]);
});

test("aborted during the download: cancelled, nothing read", async () => {
  const h = harness({ probe: available(false) });
  await flush();
  h.host.shown[0].answer("download");
  await flush();
  assert.equal(h.c.ensure.length, 1);
  h.ac.abort();
  assert.deepEqual(await h.p, CANCELLED);
  assert.deepEqual(h.log, ["tooLarge"]);
});

test("already aborted: cancelled, never read", async () => {
  const ac = new AbortController();
  ac.abort();
  const h = harness({ ac });
  assert.deepEqual(await h.p, CANCELLED);
  assert.deepEqual(h.log.filter((x) => x !== "tooLarge"), []);
});

for (const [when, expectLog] of [
  ["start", ["tooLarge"]],
  ["words", ["tooLarge", "onReading", "readWords"]],
] as [string, string[]][]) {
  test(`not current any more at ${when}: cancelled (the session's failed STALE), later steps never run`, async () => {
    const h = harness({ isCurrent: (step) => step !== when });
    await flush();
    h.c.ensure[0].settle({ ok: true });
    assert.deepEqual(await h.p, CANCELLED);
    assert.deepEqual(h.log, expectLog);
    assert.equal(h.runs.length, 1);
    assert.equal((h.runs[0] as { reason?: string }).reason, "failed", "a stale step is the task's own throw, not an abort");
  });
}

test("not current once the session answers ok: cancelled, never read", async () => {
  let afterRun = false;
  const h = harness({ isCurrent: () => !afterRun, afterRun: () => { afterRun = true; } });
  await flush();
  h.c.ensure[0].settle({ ok: true });
  assert.deepEqual(await h.p, CANCELLED);
  assert.deepEqual(h.log, ["tooLarge", "onReading", "readWords"]);
});

test("the read fails while it is no longer wanted (another sheet, the signal not aborted): cancelled, not its message", async () => {
  let current = true;
  const h = harness({ isCurrent: () => current, readWords: async () => { current = false; throw new Error("The OCR read was cancelled."); } });
  await flush();
  h.c.ensure[0].settle({ ok: true });
  assert.deepEqual(await h.p, CANCELLED);
  assert.equal((h.runs[0] as { reason?: string }).reason, "failed");
});

test("an AbortError nobody asked for (the page closed during the read): cancelled", async () => {
  const h = harness({ readWords: async () => { throw new DOMException("The page was closed during the read.", "AbortError"); } });
  await flush();
  h.c.ensure[0].settle({ ok: true });
  assert.deepEqual(await h.p, CANCELLED);
});

test("progress after the read stopped being wanted is not shown", async () => {
  let current = true;
  const h = harness({
    isCurrent: () => current,
    readWords: async (_s, op) => { op?.(PROGRESS); current = false; op?.({ ...PROGRESS, done: 2, rastersDone: 2 }); return WORDS; },
  });
  await flush();
  h.c.ensure[0].settle({ ok: true });
  assert.deepEqual(await h.p, CANCELLED);
  assert.deepEqual(h.progress, [PROGRESS]);
});

// isCurrent here ignores the signal, so these pin readBoxOnDevice's own
// abort checks, not the canvas's isCurrent.
test("aborted as the words come back: cancelled, never read", async () => {
  const ac = new AbortController();
  const h = harness({ ac, readWords: async () => { ac.abort(); return WORDS; } });
  await flush();
  h.c.ensure[0].settle({ ok: true });
  assert.deepEqual(await h.p, CANCELLED);
  assert.deepEqual(h.log, ["tooLarge", "onReading", "readWords"]);
});

test("aborted after the session answers ok: cancelled, never read", async () => {
  const ac = new AbortController();
  const h = harness({ ac, afterRun: () => ac.abort() });
  await flush();
  h.c.ensure[0].settle({ ok: true });
  assert.deepEqual(await h.p, CANCELLED);
  assert.deepEqual((h.runs[0] as { ok: boolean }).ok, true);
  assert.deepEqual(h.log, ["tooLarge", "onReading", "readWords"]);
});

test("a step that throws after the abort: cancelled, not a failure", async () => {
  const ac = new AbortController();
  const h = harness({ ac, readWords: async () => { ac.abort(); throw new Error("Rendering cancelled"); } });
  await flush();
  h.c.ensure[0].settle({ ok: true });
  assert.deepEqual(await h.p, CANCELLED);
  assert.deepEqual(h.log, ["tooLarge", "onReading", "readWords"]);
});

test("the read throws: its message", async () => {
  const h = harness({ readWords: async () => { throw new Error("no 2d canvas context"); } });
  await flush();
  h.c.ensure[0].settle({ ok: true });
  assert.deepEqual(await h.p, { kind: "message", text: ocrFailedMessage("no 2d canvas context") });
  assert.deepEqual(h.log, ["tooLarge", "onReading", "readWords"]);
});

test("the read rejects with a non-Error: String(error)", async () => {
  const h = harness({ readWords: () => Promise.reject("worker gone") });
  await flush();
  h.c.ensure[0].settle({ ok: true });
  assert.deepEqual(await h.p, { kind: "message", text: ocrFailedMessage("worker gone") });
  assert.deepEqual(h.log, ["tooLarge", "onReading", "readWords"]);
});

for (const reason of ["disabled", "uninstalled"] as const) {
  for (const box of [RASTER_BOX, { textRuns: 3, pageHasText: true }]) {
    test(`${reason}, box ${JSON.stringify(box)}: its unavailable message, nothing read`, async () => {
      const h = harness({ probe: { state: reason }, box });
      assert.deepEqual(await h.p, { kind: "message", text: ocrUnavailableMessage(reason, box) });
      assert.deepEqual(h.log, ["tooLarge"]);
      assert.equal(h.host.shown.length, 0);
    });
  }
}

test("a failed start: its message, nothing read", async () => {
  const h = harness({ probe: { state: "error", message: "manifest request failed (503)" } });
  assert.deepEqual(await h.p, { kind: "message", text: ocrFailedMessage("manifest request failed (503)") });
  assert.deepEqual(h.log, ["tooLarge"]);
});

test("the reader finds no table: the no-rows hint", async () => {
  const h = harness({ result: { rows: [], refused: "no-table" } });
  await flush();
  h.c.ensure[0].settle({ ok: true });
  assert.deepEqual(await h.p, { kind: "message", text: OCR_NO_ROWS_MESSAGE });
});

test("finish codes in a column but no header row (the real reader on a rotated-header table's words): the no-header hint", async () => {
  const fx: { words: OcrWord[] } = JSON.parse(readFileSync(new URL("./fixtures/schedule-ocr/rotated-header-perbox.json", import.meta.url), "utf8"));
  const h = harness({ readWords: async () => fx.words, reader: (spans) => readScheduleSpans(spans, { ocr: true }) });
  await flush();
  h.c.ensure[0].settle({ ok: true });
  assert.deepEqual(await h.p, { kind: "message", text: OCR_NO_HEADER_MESSAGE });
});

test("the reader refuses the table: its refusal", async () => {
  const h = harness({ result: { rows: [], refused: "title", title: "DOOR SCHEDULE" } });
  await flush();
  h.c.ensure[0].settle({ ok: true });
  assert.deepEqual(await h.p, { kind: "message", text: refusalMessage("title", "DOOR SCHEDULE") });
});

/** A whenIdle the test resolves. */
function deferredIdle() {
  let resolve!: () => void;
  const p = new Promise<void>((r) => { resolve = r; });
  return { whenIdle: () => p, resolve };
}

test("waits its turn: onWaiting, then nothing until the engine is idle, then reading", async () => {
  const idle = deferredIdle();
  const h = harness({ whenIdle: idle.whenIdle });
  await flush();
  h.c.ensure[0].settle({ ok: true });
  await flush();
  assert.deepEqual(h.log, ["tooLarge", "onWaiting", "whenIdle"], "waiting is reported, and nothing is read, while another read runs");
  idle.resolve();
  assert.deepEqual(await h.p, { kind: "rows", rows: [row] });
  assert.deepEqual(h.log, ["tooLarge", "onWaiting", "whenIdle", "onReading", "readWords", "read"]);
});

test("aborted while waiting its turn: cancelled at once, nothing read", async () => {
  const idle = deferredIdle();   // never resolved: the abort alone must end the wait
  const h = harness({ whenIdle: idle.whenIdle });
  await flush();
  h.c.ensure[0].settle({ ok: true });
  await flush();
  h.ac.abort();
  assert.deepEqual(await h.p, CANCELLED);
  assert.deepEqual(h.log, ["tooLarge", "onWaiting", "whenIdle"]);
  assert.deepEqual(h.readWordsSignals, []);
});

test("another sheet while waiting its turn: cancelled once idle, nothing read", async () => {
  const idle = deferredIdle();
  const h = harness({ whenIdle: idle.whenIdle, isCurrent: (step) => step !== "idle" });
  await flush();
  h.c.ensure[0].settle({ ok: true });
  await flush();
  idle.resolve();
  assert.deepEqual(await h.p, CANCELLED);
  assert.deepEqual(h.log, ["tooLarge", "onWaiting", "whenIdle"]);
});
