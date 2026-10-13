// realistic dense synthetic page: random words at random positions (no shared rows beyond real lines), a title block lower right
import type { SheetPage, SheetItem } from "../src/lib/sheetName.ts";
export function densePage(n: number, seed = 1, seeSheet = 0): SheetPage {
  let x = seed; const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const W = 7200, H = 4800, items: SheetItem[] = [];
  const words = ["WALL", "TYP", "CONC", "SLAB", "3'-0\"", "GYP", "BD", "NOTE", "EQ", "CLR", "DOOR", "101", "A-501", "SIM", "U.N.O."];
  const lines = Math.ceil(n / 12);
  for (let l = 0; l < lines && items.length < n; l++) {
    const y = rnd() * 0.95, x0 = rnd() * 0.8, h = 14 + Math.floor(rnd() * 3) * 4;
    let xx = x0;
    for (let k = 0; k < 12 && items.length < n; k++) { const s = words[Math.floor(rnd() * words.length)]; const w = (s.length * h * 0.6) / W; items.push({ s, x: +xx.toFixed(4), y: +y.toFixed(4), h, a: 0, w: +w.toFixed(4) }); xx += w + (h * 0.5) / W; }
  }
  for (let k = 0; k < seeSheet; k++) items.push({ s: "SEE SHEET", x: +(rnd() * 0.6 + 0.3).toFixed(4), y: +(rnd() * 0.9).toFixed(4), h: 14, a: 0, w: 0.012 }, { s: "A-" + (100 + k), x: 0, y: 0, h: 14, a: 0, w: 0.006 });
  // title block: label + big number lower right
  items.push({ s: "SHEET NUMBER", x: 0.92, y: 0.93, h: 12, a: 0, w: 0.02 }, { s: "A-101", x: 0.925, y: 0.955, h: 40, a: 0, w: 0.03 });
  return { W, H, items };
}
