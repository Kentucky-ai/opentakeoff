// Write one sheet's door-reader input as a binary file for native profiling:
// u32 nItems, u32 nPaths, then the items and paths f64 arrays (little endian).
//   node --import tsx bench/doors/dump.mts <pdf> <page index> <out.bin>
import { readFile, writeFile } from "node:fs/promises";
import * as pdfjs from "pdfjs-dist";
import { extractDoorVectors } from "../../src/lib/doorVectors.ts";
import type { OpsTable } from "../../src/lib/oneclick.ts";
const [pdfPath, pageArg, out] = process.argv.slice(2);
const doc = await pdfjs.getDocument({ data: new Uint8Array(await readFile(pdfPath)), verbosity: 0, isEvalSupported: false }).promise;
const page = await doc.getPage(Number(pageArg) + 1);
const v = extractDoorVectors((await page.getOperatorList()) as never, page.getViewport({ scale: 1, rotation: 0 }).transform, pdfjs.OPS as unknown as OpsTable);
const head = new Uint32Array([v.nItems, v.nPaths]);
await writeFile(out, Buffer.concat([Buffer.from(head.buffer), Buffer.from(v.items.buffer), Buffer.from(v.paths.buffer)]));
console.log(v.nItems, v.nPaths);
