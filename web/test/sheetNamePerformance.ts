// Performance checks run without V8 coverage instrumentation; answer correctness
// is checked separately in sheetName.test.ts under the normal coverage runner.
import { readSheetNumber } from "../src/lib/sheetName.ts";
import { densePage } from "./denseSheetPage.ts";

const best = (f: () => unknown, runs = 15) => {
  for (let i = 0; i < 3; i++) f();
  let b = Infinity;
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    f();
    b = Math.min(b, performance.now() - start);
  }
  return b;
};

const small = densePage(7500), big = densePage(30000);
const ratio = best(() => readSheetNumber(big)) / best(() => readSheetNumber(small));
const dense = [big, densePage(30000, 3, 300), densePage(59000)].map(page => ({
  items: page.items.length,
  ms: best(() => readSheetNumber(page), 9),
}));
const noLabel = { ...big, items: big.items.filter(i => !/sheet|dwg|drawing/i.test(i.s)) };
console.log(JSON.stringify({ ratio, dense, noLabelMs: best(() => readSheetNumber(noLabel)) }));
