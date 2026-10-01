// The canvas's side of OCR consent (#471): createConsentHost turns the
// session's requestConsent(downloadBytes, notice) into what the page renders
// (the OcrDownloadNotice's props, or nothing) and maps its two buttons.
// Pinned: the notice shows with the bytes and no progress; Download resolves
// "download" once and switches the notice to its progress face at once; the
// download's progress reaches it; Cancel before Download resolves "cancel";
// Cancel after Download calls notice.cancel(); the notice closes only when
// its signal aborts. The last test runs the real session through the host.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createConsentHost, focusAfterNotice, type NoticeView } from "../src/lib/ocr/consentHost.ts";
import { createOcrSession, type ConsentNotice } from "../src/lib/ocr/session.ts";
import type { OcrProbe, OcrProgress, OcrReady } from "../src/lib/ocr/client.ts";

/** A notice as the session builds it: its signal, the sinks registered on
 * it, and how many times Cancel-after-Download was called. */
function fakeNotice() {
  const ac = new AbortController();
  const sinks: ((p: OcrProgress) => void)[] = [];
  let cancels = 0;
  const notice: ConsentNotice = {
    signal: ac.signal,
    onProgress: (s) => { sinks.push(s); },
    cancel: () => { cancels++; ac.abort(); },
  };
  return { notice, ac, sinks, cancels: () => cancels, emit: (pct: number) => { for (const s of sinks) s({ loaded: pct, total: 100, pct }); } };
}

function host() {
  const views: (NoticeView | null)[] = [];
  const h = createConsentHost((v) => { views.push(v); });
  return { h, views, last: () => views[views.length - 1] };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("requestConsent shows the notice with the bytes and no progress", () => {
  const { h, last } = host();
  const n = fakeNotice();
  void h.requestConsent(36_000_000, n.notice);
  assert.deepEqual(last(), { downloadBytes: 36_000_000, progress: null });
});

test("Download resolves 'download' once and shows progress at 0 at once", async () => {
  const { h, views, last } = host();
  const n = fakeNotice();
  const answer = h.requestConsent(1000, n.notice);
  h.download();
  assert.equal(await answer, "download");
  assert.deepEqual(last(), { downloadBytes: 1000, progress: { pct: 0 } });
  const shown = views.length;
  h.download(); // a second press changes nothing
  assert.equal(views.length, shown);
});

test("the download's progress reaches the notice after Download", async () => {
  const { h, last } = host();
  const n = fakeNotice();
  void h.requestConsent(1000, n.notice);
  n.emit(40); // before Download: nothing is downloading yet
  assert.deepEqual(last(), { downloadBytes: 1000, progress: null });
  h.download();
  n.emit(40);
  assert.deepEqual(last(), { downloadBytes: 1000, progress: { pct: 40 } });
  n.emit(90);
  assert.deepEqual(last(), { downloadBytes: 1000, progress: { pct: 90 } });
});

test("Cancel before Download resolves 'cancel' and closes the notice", async () => {
  const { h, last } = host();
  const n = fakeNotice();
  const answer = h.requestConsent(1000, n.notice);
  h.cancel();
  assert.equal(await answer, "cancel");
  assert.equal(last(), null);
  assert.equal(n.cancels(), 0);
});

test("Cancel after Download calls notice.cancel, and the notice closes on the signal", async () => {
  const { h, last } = host();
  const n = fakeNotice();
  const answer = h.requestConsent(1000, n.notice);
  h.download();
  await answer;
  h.cancel();
  assert.equal(n.cancels(), 1);
  assert.equal(last(), null);
});

test("the notice stays up until its signal aborts, then closes", async () => {
  const { h, last } = host();
  const n = fakeNotice();
  const answer = h.requestConsent(1000, n.notice);
  h.download();
  await answer;
  n.emit(100);
  assert.notEqual(last(), null, "a finished download alone doesn't close it: the session aborts the signal");
  n.ac.abort();
  assert.equal(last(), null);
  h.cancel(); // nothing up: a late press is ignored
  assert.equal(n.cancels(), 0);
});

test("a signal aborted before Download closes the notice and answers 'cancel'", async () => {
  const { h, last } = host();
  const n = fakeNotice();
  const answer = h.requestConsent(1000, n.notice);
  n.ac.abort();
  assert.equal(last(), null);
  assert.equal(await answer, "cancel");
  h.download(); // too late: ignored
  assert.equal(last(), null);
});

test("a notice whose signal is already aborted is never shown", async () => {
  const { h, views } = host();
  const n = fakeNotice();
  n.ac.abort();
  assert.equal(await h.requestConsent(1000, n.notice), "cancel");
  assert.equal(views.filter((v) => v !== null).length, 0);
});

test("a late abort of an old notice doesn't close a newer one", async () => {
  const { h, last } = host();
  const a = fakeNotice(), b = fakeNotice();
  void h.requestConsent(1000, a.notice);
  void h.requestConsent(2000, b.notice);
  a.ac.abort();
  assert.deepEqual(last(), { downloadBytes: 2000, progress: null });
});

// ── through the real session ────────────────────────────────────────────────

/** A client with files missing: consent-less starts answer consent-required;
 * a consented one waits for the test (or its signal). */
function client() {
  const available: OcrProbe = { state: "available", manifest: { rev: "r1", files: [] }, cached: false, downloadBytes: 5000 };
  const starts: { settle: (r: OcrReady) => void; onProgress?: (p: OcrProgress) => void }[] = [];
  return {
    starts,
    client: {
      probe: async () => available,
      ensureReady(o: { consent?: boolean; signal?: AbortSignal; onProgress?: (p: OcrProgress) => void } = {}): Promise<OcrReady> {
        if (!o.consent) return Promise.resolve({ ok: false, reason: "consent-required" });
        return new Promise((resolve) => {
          starts.push({ settle: resolve, onProgress: o.onProgress });
          o.signal?.addEventListener("abort", () => resolve({ ok: false, reason: "aborted" }), { once: true });
        });
      },
    },
  };
}

test("with the real session: Download starts the engine, the task runs, the notice closes", async () => {
  const { h, last } = host();
  const c = client();
  const session = createOcrSession({ client: c.client, requestConsent: h.requestConsent });
  const run = session.run(async () => "read");
  await tick(); await tick();
  assert.deepEqual(last(), { downloadBytes: 5000, progress: null });
  h.download();
  await tick();
  assert.equal(c.starts.length, 1);
  c.starts[0].onProgress?.({ loaded: 50, total: 100, pct: 50 });
  assert.deepEqual(last(), { downloadBytes: 5000, progress: { pct: 50 } });
  c.starts[0].settle({ ok: true });
  assert.deepEqual(await run, { ok: true, value: "read" });
  assert.equal(last(), null);
});

test("with the real session: Cancel declines and runs nothing", async () => {
  const { h, last } = host();
  const c = client();
  const session = createOcrSession({ client: c.client, requestConsent: h.requestConsent });
  let ran = false;
  const run = session.run(async () => { ran = true; });
  await tick(); await tick();
  h.cancel();
  // Checked before awaiting: a Cancel taken for Download would start a
  // download that never settles here, and the await would just hang.
  await tick(); await tick();
  assert.equal(c.starts.length, 0, "Cancel starts no download");
  assert.deepEqual(await run, { ok: false, reason: "declined" });
  assert.equal(ran, false);
  assert.equal(last(), null);
});

test("with the real session: the caller's abort closes the notice it opened", async () => {
  const { h, last } = host();
  const c = client();
  const session = createOcrSession({ client: c.client, requestConsent: h.requestConsent });
  const ac = new AbortController();
  const run = session.run(async () => "x", { signal: ac.signal });
  await tick(); await tick();
  assert.notEqual(last(), null);
  ac.abort();
  assert.deepEqual(await run, { ok: false, reason: "aborted" });
  assert.equal(last(), null);
});

// ── focus when the notice closes ─────────────────────────────────────────────

test("focusAfterNotice: back where it was if that's still in the page, else the read control", () => {
  const saved = { isConnected: true, focus() {} };
  const gone = { isConnected: false, focus() {} };
  const fallback = { focus() {} };
  assert.equal(focusAfterNotice(saved, () => fallback), saved);
  assert.equal(focusAfterNotice(gone, () => fallback), fallback);
  assert.equal(focusAfterNotice(null, () => fallback), fallback);
  assert.equal(focusAfterNotice(gone, () => null), null);
  const body = { isConnected: true, focus() {}, tagName: "BODY" };
  assert.equal(focusAfterNotice(body, () => fallback), fallback, "focus that was nowhere (the body) goes to the control");
});
