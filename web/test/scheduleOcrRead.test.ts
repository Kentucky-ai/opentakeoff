// Import from schedule's on-device read of a box (lib/scheduleOcrRead.ts
// readBoxOnDevice), run through the REAL OCR session (lib/ocr/session.ts)
// with a fake client and a fake download notice, as ocrSession.test.ts does.
// Pinned:
//   - the engine starts as the person agreed (cached: no notice; else the
//     notice, and only Download downloads), then the box is rendered and
//     read, and the reader's result is routed (rows, refusal, no rows);
//   - onReading fires before the render, so the status line says "Reading"
//     for the whole read, and only once the engine is up;
//   - a read the person left (aborted, or isCurrent() false: another sheet)
//     is "cancelled" at every step — before the render, after it, after
//     recognition, and after the session answers — and the steps after it
//     never run;
//   - turned off / not installed / declined / a failed start / a step that
//     throws each become their message; a throw after the abort is cancelled.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOcrSession, type ConsentNotice, type OcrSession } from "../src/lib/ocr/session.ts";
import type { OcrProbe, OcrProgress, OcrReady } from "../src/lib/ocr/client.ts";
import type { OcrManifest } from "../src/lib/ocr/manifest.ts";
import { wordsToSpans, type OcrWord } from "../src/lib/ocr/types.ts";
import type { GraphSpan } from "../src/lib/sheetgraph.ts";
import type { ScheduleRead } from "../src/lib/scheduleRead.ts";
import type { ScheduleRow } from "../src/lib/scheduleRows.ts";
import { readBoxOnDevice } from "../src/lib/scheduleOcrRead.ts";
import {
  ocrUnavailableMessage, ocrFailedMessage, refusalMessage, OCR_DECLINED_MESSAGE, OCR_NO_ROWS_MESSAGE, type BoxText,
} from "../src/lib/scheduleRoute.ts";

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
const RASTER = { width: 100, height: 40 };
const RASTER_BOX: BoxText = { textRuns: 0, pageHasText: false };

/** The box read's injected steps, each recording its call in `log`.
 * Overrides replace a step's behavior (they still log). */
function harness(opts: {
  probe?: OcrProbe;
  result?: ScheduleRead;
  rasterize?: (signal?: AbortSignal) => Promise<unknown>;
  recognize?: (raster: unknown, signal?: AbortSignal) => Promise<OcrWord[]>;
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
  const recognizeSignals: (AbortSignal | undefined)[] = [];
  const rasterizeSignals: (AbortSignal | undefined)[] = [];
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
    rasterize: async (signal) => { log.push("rasterize"); rasterizeSignals.push(signal); const r = await (opts.rasterize ?? (async () => RASTER))(signal); step = "rasterized"; return r; },
    recognize: async (raster, signal) => {
      log.push("recognize");
      recognizeSignals.push(signal);
      assert.equal(raster, RASTER);
      const w = await (opts.recognize ?? (async () => WORDS))(raster, signal);
      step = "recognized";
      return w;
    },
    read: (spans) => { log.push("read"); readCalls.push(spans); return opts.result ?? { rows: [row] }; },
    isCurrent: () => (opts.isCurrent ? opts.isCurrent(step) : true),
    onReading: () => { log.push("onReading"); },
    ...(opts.whenIdle ? { whenIdle: async () => { log.push("whenIdle"); await opts.whenIdle!(); step = "idle"; }, onWaiting: () => { log.push("onWaiting"); } } : {}),
    signal: ac.signal,
    box: opts.box ?? RASTER_BOX,
  });
  return { c, host, ac, log, runs, readCalls, recognizeSignals, rasterizeSignals, p };
}

const CANCELLED = { kind: "cancelled" };

test("cached: no notice, onReading before the render, the words read as spans, rows routed", async () => {
  const h = harness();
  await flush();
  assert.equal(h.host.shown.length, 0, "no notice when the files are cached");
  assert.equal(h.c.consented(), 0);
  h.c.ensure[0].settle({ ok: true });
  assert.deepEqual(await h.p, { kind: "rows", rows: [row] });
  assert.deepEqual(h.log, ["onReading", "rasterize", "recognize", "read"]);
  assert.deepEqual(h.readCalls, [wordsToSpans(WORDS)]);
  assert.deepEqual(h.recognizeSignals, [h.ac.signal], "recognition gets the caller's signal");
  assert.deepEqual(h.rasterizeSignals, [h.ac.signal], "so does the render, so Cancel stops it");
});

test("not cached: the notice first, nothing read until Download, then rows", async () => {
  const h = harness({ probe: available(false, 12_345) });
  await flush();
  assert.equal(h.host.shown.length, 1);
  assert.equal(h.host.shown[0].bytes, 12_345);
  assert.deepEqual(h.log, [], "nothing runs while the notice waits");
  h.host.shown[0].answer("download");
  await flush();
  assert.equal(h.c.consented(), 1);
  assert.deepEqual(h.log, [], "nothing runs during the download");
  h.c.ensure[0].settle({ ok: true });
  assert.deepEqual(await h.p, { kind: "rows", rows: [row] });
  assert.deepEqual(h.log, ["onReading", "rasterize", "recognize", "read"]);
});

test("the notice's Cancel: declined, nothing rendered", async () => {
  const h = harness({ probe: available(false) });
  await flush();
  h.host.shown[0].answer("cancel");
  assert.deepEqual(await h.p, { kind: "message", text: OCR_DECLINED_MESSAGE });
  assert.deepEqual(h.log, []);
  assert.equal(h.c.consented(), 0);
});

test("aborted while the notice waits: cancelled, and the notice closes", async () => {
  const h = harness({ probe: available(false) });
  await flush();
  assert.equal(h.host.shown.length, 1);
  h.ac.abort();
  assert.deepEqual(await h.p, CANCELLED);
  assert.equal(h.host.shown[0].notice.signal.aborted, true);
  assert.deepEqual(h.log, []);
});

test("aborted during the download: cancelled, nothing rendered", async () => {
  const h = harness({ probe: available(false) });
  await flush();
  h.host.shown[0].answer("download");
  await flush();
  assert.equal(h.c.ensure.length, 1);
  h.ac.abort();
  assert.deepEqual(await h.p, CANCELLED);
  assert.deepEqual(h.log, []);
});

test("already aborted: cancelled, never rendered", async () => {
  const ac = new AbortController();
  ac.abort();
  const h = harness({ ac });
  assert.deepEqual(await h.p, CANCELLED);
  assert.deepEqual(h.log, []);
});

for (const [when, expectLog] of [
  ["start", []],
  ["rasterized", ["onReading", "rasterize"]],
  ["recognized", ["onReading", "rasterize", "recognize"]],
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
  assert.deepEqual(h.log, ["onReading", "rasterize", "recognize"]);
});

// isCurrent here ignores the signal, so these pin readBoxOnDevice's own
// abort checks, not the canvas's isCurrent.
test("aborted as recognition resolves: cancelled, never read", async () => {
  const ac = new AbortController();
  const h = harness({ ac, recognize: async () => { ac.abort(); return WORDS; } });
  await flush();
  h.c.ensure[0].settle({ ok: true });
  assert.deepEqual(await h.p, CANCELLED);
  assert.deepEqual(h.log, ["onReading", "rasterize", "recognize"]);
});

test("aborted after the session answers ok: cancelled, never read", async () => {
  const ac = new AbortController();
  const h = harness({ ac, afterRun: () => ac.abort() });
  await flush();
  h.c.ensure[0].settle({ ok: true });
  assert.deepEqual(await h.p, CANCELLED);
  assert.deepEqual((h.runs[0] as { ok: boolean }).ok, true);
  assert.deepEqual(h.log, ["onReading", "rasterize", "recognize"]);
});

test("a step that throws after the abort: cancelled, not a failure", async () => {
  const ac = new AbortController();
  const h = harness({ ac, rasterize: async () => { ac.abort(); throw new Error("Rendering cancelled"); } });
  await flush();
  h.c.ensure[0].settle({ ok: true });
  assert.deepEqual(await h.p, CANCELLED);
  assert.deepEqual(h.log, ["onReading", "rasterize"]);
});

test("the render throws: its message", async () => {
  const h = harness({ rasterize: async () => { throw new Error("no 2d canvas context"); } });
  await flush();
  h.c.ensure[0].settle({ ok: true });
  assert.deepEqual(await h.p, { kind: "message", text: ocrFailedMessage("no 2d canvas context") });
  assert.deepEqual(h.log, ["onReading", "rasterize"]);
});

test("recognition rejects with a non-Error: String(error)", async () => {
  const h = harness({ recognize: () => Promise.reject("worker gone") });
  await flush();
  h.c.ensure[0].settle({ ok: true });
  assert.deepEqual(await h.p, { kind: "message", text: ocrFailedMessage("worker gone") });
  assert.deepEqual(h.log, ["onReading", "rasterize", "recognize"]);
});

for (const reason of ["disabled", "uninstalled"] as const) {
  for (const box of [RASTER_BOX, { textRuns: 3, pageHasText: true }]) {
    test(`${reason}, box ${JSON.stringify(box)}: its unavailable message, nothing rendered`, async () => {
      const h = harness({ probe: { state: reason }, box });
      assert.deepEqual(await h.p, { kind: "message", text: ocrUnavailableMessage(reason, box) });
      assert.deepEqual(h.log, []);
      assert.equal(h.host.shown.length, 0);
    });
  }
}

test("a failed start: its message, nothing rendered", async () => {
  const h = harness({ probe: { state: "error", message: "manifest request failed (503)" } });
  assert.deepEqual(await h.p, { kind: "message", text: ocrFailedMessage("manifest request failed (503)") });
  assert.deepEqual(h.log, []);
});

test("the reader finds no table: the no-rows hint", async () => {
  const h = harness({ result: { rows: [], refused: "no-table" } });
  await flush();
  h.c.ensure[0].settle({ ok: true });
  assert.deepEqual(await h.p, { kind: "message", text: OCR_NO_ROWS_MESSAGE });
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
  assert.deepEqual(h.log, ["onWaiting", "whenIdle"], "waiting is reported, and nothing is rendered, while another read runs");
  idle.resolve();
  assert.deepEqual(await h.p, { kind: "rows", rows: [row] });
  assert.deepEqual(h.log, ["onWaiting", "whenIdle", "onReading", "rasterize", "recognize", "read"]);
});

test("aborted while waiting its turn: cancelled at once, nothing rendered", async () => {
  const idle = deferredIdle();   // never resolved: the abort alone must end the wait
  const h = harness({ whenIdle: idle.whenIdle });
  await flush();
  h.c.ensure[0].settle({ ok: true });
  await flush();
  h.ac.abort();
  assert.deepEqual(await h.p, CANCELLED);
  assert.deepEqual(h.log, ["onWaiting", "whenIdle"]);
  assert.deepEqual(h.rasterizeSignals, []);
});

test("another sheet while waiting its turn: cancelled once idle, nothing rendered", async () => {
  const idle = deferredIdle();
  const h = harness({ whenIdle: idle.whenIdle, isCurrent: (step) => step !== "idle" });
  await flush();
  h.c.ensure[0].settle({ ok: true });
  await flush();
  idle.resolve();
  assert.deepEqual(await h.p, CANCELLED);
  assert.deepEqual(h.log, ["onWaiting", "whenIdle"]);
});
