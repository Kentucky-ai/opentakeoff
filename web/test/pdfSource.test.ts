import { test } from "node:test";
import assert from "node:assert/strict";
import { isPdfSource, rangeParams, RANGE_CHUNK } from "../src/lib/pdfSource.ts";

class FakeTransport {
  got: [number, Uint8Array][] = [];
  constructor(public length: number, public initialData: Uint8Array | null) {}
  onDataRange(begin: number, chunk: Uint8Array) { this.got.push([begin, chunk]); }
  requestDataRange(_begin: number, _end: number) { throw new Error("the base class's no-op"); }
  abort() { throw new Error("unimplemented in the base class"); }
}
const settle = () => new Promise((r) => setTimeout(r, 5));

test("rangeParams reads only the ranges pdf.js asks for, and nothing ahead", async () => {
  const bytes = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);
  let reads = 0;
  const blob = new Blob([bytes]);
  const slice = blob.slice.bind(blob);
  blob.slice = (...a: Parameters<Blob["slice"]>) => { reads++; return slice(...a); };
  const p = rangeParams(FakeTransport, blob);
  assert.equal(p.length, 1000); assert.equal(p.range.length, 1000); assert.equal(p.range.initialData, null);
  assert.equal(p.disableAutoFetch, true); assert.equal(p.disableStream, true); assert.equal(p.rangeChunkSize, RANGE_CHUNK);
  assert.equal(reads, 0, "opening reads nothing by itself");
  p.range.requestDataRange(900, 1000); p.range.requestDataRange(10, 20);
  await settle();
  assert.equal(reads, 2);
  const got = new Map(p.range.got.map(([b, c]) => [b, [...c]]));
  assert.deepEqual(got.get(900), [...bytes.slice(900, 1000)]);
  assert.deepEqual(got.get(10), [...bytes.slice(10, 20)]);
});

test("an aborted transport delivers nothing more; a failed read is retried once, then reported", async () => {
  const blob = new Blob([new Uint8Array(100)]);
  const p = rangeParams(FakeTransport, blob);
  p.range.abort(); p.range.requestDataRange(0, 50);
  await settle();
  assert.deepEqual(p.range.got, []);

  let tries = 0;
  const flaky = { size: 100, slice: () => ({ arrayBuffer: () => (++tries === 1 ? Promise.reject(new Error("busy")) : Promise.resolve(new ArrayBuffer(7))) }) } as unknown as Blob;
  const q = rangeParams(FakeTransport, flaky);
  q.range.requestDataRange(0, 7); await settle();
  assert.equal(tries, 2); assert.equal(q.range.got[0][1].byteLength, 7);

  const errors: unknown[][] = [], previous = console.error;
  console.error = (...a: unknown[]) => { errors.push(a); };
  try {
    const dead = { size: 100, slice: () => ({ arrayBuffer: () => Promise.reject(new Error("gone")) }) } as unknown as Blob;
    const r = rangeParams(FakeTransport, dead);
    r.range.requestDataRange(0, 7); await settle();
    assert.deepEqual(r.range.got, []); assert.equal(errors.length, 1);
  } finally { console.error = previous; }
});

test("isPdfSource tells a source from bytes", () => {
  assert.equal(isPdfSource({ blob: new Blob([]), key: "k" }), true);
  for (const v of [null, new Uint8Array(1), new ArrayBuffer(1), { blob: new Blob([]) }, { blob: new Uint8Array(1), key: "k" }]) assert.equal(isPdfSource(v), false);
});
