import { test } from "node:test";
import assert from "node:assert/strict";
import { createTileCompositor } from "../src/lib/tileCompositor.ts";

// A worker that records what it is sent and answers only when told to.
function fakeWorkers() {
  const workers: { sent: Record<string, unknown>[] }[] = [];
  class FakeWorker {
    sent: Record<string, unknown>[] = [];
    onmessage?: (e: unknown) => void;
    constructor() { workers.push(this); }
    postMessage(m: Record<string, unknown>) { this.sent.push(m); }
    terminate() {}
  }
  return { workers, FakeWorker: FakeWorker as unknown as typeof Worker };
}

async function withCompositor(fn: (c: ReturnType<typeof createTileCompositor>, opens: () => number, errors: unknown[][]) => Promise<void>) {
  const { workers, FakeWorker } = fakeWorkers();
  const previous = globalThis.Worker, previousError = console.error;
  const errors: unknown[][] = [];
  globalThis.Worker = FakeWorker;
  console.error = (...args: unknown[]) => { errors.push(args); };
  const c = createTileCompositor();
  const opens = () => workers.reduce((n, w) => n + w.sent.filter((m) => m.type === "openSheet").length, 0);
  try { await fn(c, opens, errors); } finally { c.dispose(); globalThis.Worker = previous; console.error = previousError; }
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test("changing sheets while one is still opening is not logged as a failed open (#513 review)", async () => {
  await withCompositor(async (c, opens, errors) => {
    c.openSheet("a", 1, Promise.resolve(new ArrayBuffer(1)), 1000, 800);
    await settle();
    assert.ok(opens() > 0, "the open reached the workers");
    c.resetAll(); // closes "a" while its open is pending
    await settle();
    assert.deepEqual(errors, []);
  });
});

test("bytes that arrive after resetAll don't open a sheet nothing will close (#513 review)", async () => {
  await withCompositor(async (c, opens, errors) => {
    let deliver!: (b: ArrayBuffer) => void;
    c.openSheet("a", 1, new Promise<ArrayBuffer>((r) => { deliver = r; }), 1000, 800);
    c.resetAll();
    deliver(new ArrayBuffer(1));
    await settle();
    assert.equal(opens(), 0);
    assert.deepEqual(errors, []);
  });
});
