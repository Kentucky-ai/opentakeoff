// The door reader over a directory of answer-key label files (one JSON per
// sheet), written as det.json: per sheet, boxes [x0, y0, x1, y1, 1.0, 0], the
// shape a box-matching scorer reads, plus times.
//   node --import tsx bench/doors/run.mts <labels dir> <out dir> [--key] [--jobs 4] [--mem-mb 6000] [--limit-s 120]
// Each label JSON names its pdf, page (0-based) and the key's ppf; --key passes
// the key's scale (1/ppf), otherwise the reader reads the scale from the swings.
// One child process per sheet with a heap cap and a time limit. Labels and PDFs
// stay where they are: nothing from them is written beyond coordinates.
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const [labDir, outDir] = args;
const opt = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const useKey = args.includes("--key");
const jobs = Number(opt("--jobs", "4")), memMb = Number(opt("--mem-mb", "6000")), limitS = Number(opt("--limit-s", "120"));
const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..", "..");
const files = readdirSync(labDir).filter((f) => f.endsWith(".json")).sort();
mkdirSync(outDir, { recursive: true });

interface Row { sheet: string; n: number; s?: Record<string, number>; fpp?: number | null; err?: string }
const boxes: Record<string, number[][]> = {};
const feats: Record<string, unknown[]> = {};
const rows: Row[] = [];

function one(f: string): Promise<void> {
  const L = JSON.parse(readFileSync(path.join(labDir, f), "utf8"));
  const a = ["--max-old-space-size=" + memMb, "--import", "tsx", path.join(here, "page.mts"), L.pdf, String(L.page)];
  if (useKey) a.push(String(1 / Number(L.ppf)));
  return new Promise((resolve) => {
    const p = spawn(process.execPath, a, { cwd: webRoot, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => p.kill("SIGKILL"), limitS * 1000);
    p.on("close", (code) => {
      clearTimeout(timer);
      const line = out.trim().split("\n").pop() || "";
      try {
        const r = JSON.parse(line);
        boxes[L.sheet] = r.boxes.map((b: number[]) => [...b, 1.0, 0]);
        feats[L.sheet] = r.feats;
        rows.push({ sheet: L.sheet, n: r.boxes.length, s: r.s, fpp: r.fpp });
        console.log(L.sheet, r.boxes.length, "fpp", r.fpp && Math.round(100 / r.fpp) / 100, "key", L.ppf, r.s.total.toFixed(2), `(parse ${r.s.parse.toFixed(2)} extract ${r.s.extract.toFixed(2)} read ${r.s.read.toFixed(2)})`);
      } catch {
        boxes[L.sheet] = [];
        rows.push({ sheet: L.sheet, n: 0, err: (code === null ? "killed (time)" : `exit ${code}`) + " " + err.slice(-300) });
        console.log(L.sheet, "FAILED", code, err.slice(-300));
      }
      resolve();
    });
  });
}

const queue = files.slice();
await Promise.all(Array.from({ length: jobs }, async () => { for (let f = queue.shift(); f; f = queue.shift()) await one(f); }));
writeFileSync(path.join(outDir, "det.json"), JSON.stringify({ boxes }));
writeFileSync(path.join(outDir, "times.json"), JSON.stringify(rows, null, 1));
writeFileSync(path.join(outDir, "feats.json"), JSON.stringify(feats));
const T = rows.filter((r) => r.s).map((r) => r.s!.total).sort((x, y) => x - y);
const q = (p: number) => T[Math.min(T.length - 1, Math.floor(p * T.length))];
console.log("TIME median", q(0.5)?.toFixed(2), "p90", q(0.9)?.toFixed(2), "max", T[T.length - 1]?.toFixed(2), "failed", rows.filter((r) => r.err).length);
