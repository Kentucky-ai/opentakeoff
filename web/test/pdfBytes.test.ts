// The session's raw PDF copies: a file the document cache let go re-opens
// from memory, not from Drive or IndexedDB again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createByteCache, byteBudget } from "../src/lib/pdfBytes.ts";

// a load per name the test settles itself; `calls` counts loads started
function loads() {
  const calls: string[] = [];
  const pending = new Map<string, { resolve(b: Uint8Array): void; reject(e: unknown): void }[]>();
  return {
    calls,
    load(name: string) {
      calls.push(name);
      return new Promise<Uint8Array>((resolve, reject) => {
        pending.set(name, [...(pending.get(name) ?? []), { resolve, reject }]);
      });
    },
    // settle the oldest pending load of `name`
    resolve(name: string, bytes: number[]) { pending.get(name)!.shift()!.resolve(new Uint8Array(bytes)); },
    reject(name: string, e: unknown) { pending.get(name)!.shift()!.reject(e); },
    count: (name: string) => calls.filter((c) => c === name).length,
  };
}

// a load that answers at once with `size` bytes of the name's first letter
function sized(sizes: Record<string, number>) {
  const calls: string[] = [];
  return {
    calls,
    load: async (name: string) => { calls.push(name); return new Uint8Array(sizes[name]).fill(name.charCodeAt(0)); },
    count: (name: string) => calls.filter((c) => c === name).length,
  };
}

const detach = (b: Uint8Array) => { structuredClone(b, { transfer: [b.buffer] }); };

test("each get hands out its own copy: detaching one leaves the next whole", async () => {
  const l = sized({ "a.pdf": 3 });
  const cache = createByteCache({ load: l.load, maxBytes: 100 });
  const first = await cache.get("a.pdf");
  detach(first);
  assert.equal(first.byteLength, 0, "the first copy really was detached");
  const second = await cache.get("a.pdf");
  assert.deepEqual([...second], [97, 97, 97]);
  assert.equal(l.count("a.pdf"), 1, "from memory, not a second load");
  assert.notEqual(second.buffer, (await cache.get("a.pdf")).buffer, "every get is a fresh buffer");
});

test("gets of a file still loading share the one load", async () => {
  const l = loads();
  const cache = createByteCache({ load: l.load, maxBytes: 100 });
  const p1 = cache.get("a.pdf");
  const p2 = cache.get("a.pdf");
  assert.equal(l.count("a.pdf"), 1);
  l.resolve("a.pdf", [1, 2]);
  const [b1, b2] = await Promise.all([p1, p2]);
  assert.deepEqual([...b1], [1, 2]);
  assert.deepEqual([...b2], [1, 2]);
  assert.notEqual(b1.buffer, b2.buffer, "each caller still gets its own copy");
});

test("past the byte budget the least recently used copies go first", async () => {
  const l = sized({ "a.pdf": 4, "b.pdf": 4, "c.pdf": 4 });
  const cache = createByteCache({ load: l.load, maxBytes: 10 });
  await cache.get("a.pdf");
  await cache.get("b.pdf");
  await cache.get("a.pdf");          // a is now the most recent
  assert.equal(l.calls.length, 2, "a and b both fit: a's second get came from memory");
  await cache.get("c.pdf");          // 12 bytes: b, the least recent, goes
  await cache.get("a.pdf");
  await cache.get("c.pdf");
  assert.equal(l.count("a.pdf"), 1, "a stayed");
  assert.equal(l.count("c.pdf"), 1, "c stayed");
  await cache.get("b.pdf");
  assert.equal(l.count("b.pdf"), 2, "b went and loads again");
});

test("a file bigger than the whole budget isn't kept", async () => {
  const l = sized({ "big.pdf": 5, "fits.pdf": 4 });
  const cache = createByteCache({ load: l.load, maxBytes: 4 });
  assert.equal((await cache.get("big.pdf")).byteLength, 5, "still handed out");
  await cache.get("big.pdf");
  assert.equal(l.count("big.pdf"), 2);
  await cache.get("fits.pdf");
  await cache.get("fits.pdf");
  assert.equal(l.count("fits.pdf"), 1, "one exactly at the budget is kept");
});

test("an oversize file doesn't push the kept copies out", async () => {
  const l = sized({ "a.pdf": 4, "big.pdf": 5, "one.pdf": 1 });
  const cache = createByteCache({ load: l.load, maxBytes: 4 });
  await cache.get("a.pdf");
  await cache.get("big.pdf");
  await cache.get("a.pdf");
  assert.equal(l.count("a.pdf"), 1);
  await cache.get("one.pdf");        // control: a file that fits does push a out
  await cache.get("a.pdf");
  assert.equal(l.count("a.pdf"), 2);
});

test("forget drops the file's copy: the next get loads it again", async () => {
  const l = sized({ "a.pdf": 2, "b.pdf": 2 });
  const cache = createByteCache({ load: l.load, maxBytes: 100 });
  await cache.get("a.pdf");
  await cache.get("b.pdf");
  cache.forget("a.pdf");
  await cache.get("a.pdf");
  await cache.get("b.pdf");
  assert.equal(l.count("a.pdf"), 2, "a loads again");
  assert.equal(l.count("b.pdf"), 1, "b, not forgotten, stays");
});

test("a load still in flight when its file is forgotten isn't kept when it lands", async () => {
  const l = loads();
  const cache = createByteCache({ load: l.load, maxBytes: 100 });
  const old = cache.get("a.pdf");
  cache.forget("a.pdf");
  const fresh = cache.get("a.pdf");
  assert.equal(l.count("a.pdf"), 2, "a get after the forget doesn't join the stale load");
  l.resolve("a.pdf", [1]);           // the old bytes land after the forget
  l.resolve("a.pdf", [2]);
  assert.deepEqual([...await old], [1], "its caller still gets what it asked for");
  assert.deepEqual([...await fresh], [2]);
  const again = cache.get("a.pdf");
  assert.equal(l.count("a.pdf"), 2, "the new bytes are kept");
  assert.deepEqual([...await again], [2]);
});

test("a load that lands before any forget is kept (control for the stale-load test)", async () => {
  const l = loads();
  const cache = createByteCache({ load: l.load, maxBytes: 100 });
  const p = cache.get("a.pdf");
  l.resolve("a.pdf", [1]);
  await p;
  const again = cache.get("a.pdf");
  assert.equal(l.count("a.pdf"), 1);
  assert.deepEqual([...await again], [1]);
});

test("a failed load isn't kept, and its error reaches every caller", async () => {
  const l = loads();
  const cache = createByteCache({ load: l.load, maxBytes: 100 });
  const boom = new Error("offline");
  const p1 = cache.get("a.pdf");
  const p2 = cache.get("a.pdf");
  assert.equal(l.count("a.pdf"), 1);
  l.reject("a.pdf", boom);
  await assert.rejects(p1, (e) => e === boom);
  await assert.rejects(p2, (e) => e === boom);
  const p3 = cache.get("a.pdf");
  assert.equal(l.count("a.pdf"), 2, "the next get tries again");
  l.resolve("a.pdf", [7]);
  assert.deepEqual([...await p3], [7]);
});

test("clear drops every copy, and a load in flight then isn't kept", async () => {
  const l = loads();
  const cache = createByteCache({ load: l.load, maxBytes: 100 });
  const a = cache.get("a.pdf");
  l.resolve("a.pdf", [1]);
  await a;
  const b = cache.get("b.pdf");
  cache.clear();
  l.resolve("b.pdf", [2]);
  await b;
  const a2 = cache.get("a.pdf");
  const b2 = cache.get("b.pdf");
  assert.equal(l.count("a.pdf"), 2, "a's copy went");
  assert.equal(l.count("b.pdf"), 2, "b's in-flight load wasn't kept");
  l.resolve("a.pdf", [1]);
  l.resolve("b.pdf", [2]);
  await Promise.all([a2, b2]);
  const a3 = cache.get("a.pdf"), b3 = cache.get("b.pdf");
  assert.equal(l.calls.length, 4, "loads after the clear are kept again");
  await Promise.all([a3, b3]);
});

test("the byte budget is 256 MB, and none (the cache off) on a low-memory device", () => {
  assert.equal(byteBudget(false), 256 * 1024 * 1024);
  assert.equal(byteBudget(true), 0);
});

test("with no budget the cache is off: every get loads, and concurrent gets don't share", async () => {
  const l = sized({ "a.pdf": 1 });
  const cache = createByteCache({ load: l.load, maxBytes: 0 });
  await Promise.all([cache.get("a.pdf"), cache.get("a.pdf")]);
  await cache.get("a.pdf");
  assert.equal(l.count("a.pdf"), 3);
});

test("the first get's copy isn't the kept one: detaching it leaves the next get whole", async () => {
  const l = loads();
  const cache = createByteCache({ load: l.load, maxBytes: 100 });
  const p = cache.get("a.pdf");
  l.resolve("a.pdf", [1, 2, 3]);
  const first = await p;
  detach(first);
  assert.equal(first.byteLength, 0, "the first copy really was detached");
  const next = cache.get("a.pdf");
  assert.equal(l.count("a.pdf"), 1, "from memory");
  assert.deepEqual([...await next], [1, 2, 3]);
});

test("callers sharing a load each get a copy: detaching one leaves the other whole", async () => {
  const l = loads();
  const cache = createByteCache({ load: l.load, maxBytes: 100 });
  const p1 = cache.get("a.pdf"), p2 = cache.get("a.pdf");
  l.resolve("a.pdf", [4, 5]);
  const b1 = await p1;
  detach(b1);
  assert.equal(b1.byteLength, 0);
  assert.deepEqual([...await p2], [4, 5]);
  assert.deepEqual([...await cache.get("a.pdf")], [4, 5]);
});
