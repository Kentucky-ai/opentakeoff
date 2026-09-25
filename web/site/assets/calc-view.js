// Calculator definitions: fields + a pure HTML render of the result. Used twice —
// at build time (scripts/build-site.mjs renders each page's default example into
// the static HTML, so crawlers and no-JS readers get a worked example) and in the
// browser (calc-ui.js re-renders on every input).
import { sfToSy, syToSf, packageOrder, rollCutBoth, baseOrder, ftIn } from "./calc.js";

const f = (n, d = 1) =>
  Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const row = (label, value, cls = "") => `<tr${cls ? ` class="${cls}"` : ""}><td>${label}</td><td>${value}</td></tr>`;

export const CALCS = {
  sfsy: {
    fields: [
      { name: "sf", label: "Square feet", unit: "SF", value: 1250, step: "any" },
      { name: "waste", label: "Waste", unit: "%", value: 0, step: "any", help: "Optional. Leave at 0 for a straight conversion." },
    ],
    render({ sf, waste }) {
      const sy = sfToSy(sf);
      const w = Math.max(0, Number(waste) || 0);
      const withW = sy * (1 + w / 100);
      return `<p class="r-kicker">Square yards</p><p class="hero-q">${f(w ? withW : sy, 2)}<small>SY</small></p><p class="sub">${f(sf, 2)} SF ÷ 9${w ? ` × ${f(1 + w / 100, 2)}` : ""}</p><table>${row("Net", `${f(sy, 2)} SY`)}${w ? row(`Waste ${f(w, 1)}%`, `${f(withW - sy, 2)} SY`) + row("Order", `${f(withW, 2)} SY`, "total") : ""}${row("Back to SF", `${f(syToSf(w ? withW : sy), 2)} SF`)}</table>`;
    },
  },

  order: {
    fields: [
      { name: "net", label: "Net area (measured)", unit: "SF", value: 1840, step: "any" },
      { name: "waste", label: "Waste", unit: "%", value: 10, step: "any", help: "Cutting waste for the install: layout, pattern and room shape decide it." },
      { name: "attic", label: "Attic stock", unit: "%", value: 2, step: "any", help: "Spare material left for the owner. Check the spec's closeout section." },
      { name: "pkg", label: "Coverage per carton / package", unit: "SF", value: 23.4, step: "any", help: "From the product data sheet." },
    ],
    render({ net, waste, attic, pkg }) {
      const r = packageOrder({ netSf: net, wastePct: waste, atticPct: attic, packageSf: pkg });
      if (!r.packages) return `<p class="r-kicker">Order</p><p class="sub">Enter a coverage per package to round to whole packages.</p><table>${row("Required", `${f(r.required, 1)} SF`, "total")}</table>`;
      return `<p class="r-kicker">Order</p><p class="hero-q">${r.packages}<small>${r.packages === 1 ? "PACKAGE" : "PACKAGES"}</small></p><p class="sub">${f(r.ordered, 1)} SF delivered · ${f(r.ordered / 9, 2)} SY</p><table>${row("Net (measured)", `${f(r.net, 1)} SF`)}${row(`+ Waste ${f(Number(waste) || 0, 1)}%`, `${f(r.waste, 1)} SF`)}${row(`+ Attic stock ${f(Number(attic) || 0, 1)}%`, `${f(r.attic, 1)} SF`)}${row("= Required", `${f(r.required, 1)} SF`)}${row("+ Package rounding", `${f(r.rounding, 1)} SF`)}${row("Ordered", `${f(r.ordered, 1)} SF`, "total")}</table>`;
    },
  },

  roll: {
    fields: [
      { name: "len", label: "Room length", unit: "FT", value: 26, step: "any" },
      { name: "wid", label: "Room width", unit: "FT", value: 17.5, step: "any" },
      { name: "roll", label: "Roll width", unit: "FT", value: 12, step: "any", presets: [12, 13.5, 15], help: "12′, 13′-6″ and 15′ are the common broadloom widths." },
      { name: "trim", label: "Trim allowance per cut", unit: "IN", value: 6, step: "any", help: "Added to every drop for trimming at the walls." },
      { name: "repeat", label: "Pattern repeat (length)", unit: "IN", value: 0, step: "any", help: "0 for no match. Each cut rounds up to whole repeats." },
    ],
    render({ len, wid, roll, trim, repeat }) {
      const opts = rollCutBoth({ lengthFt: len, widthFt: wid, rollWidthFt: roll, trimIn: trim, repeatIn: repeat });
      if (!opts) return `<p class="r-kicker">Roll cuts</p><p class="sub">Enter the room and roll dimensions.</p>`;
      const [b, o] = opts;
      const dir = (x) => (x.direction === "length" ? "running the length" : "running the width");
      return `<p class="r-kicker">Cut quantity · ${dir(b)}</p><p class="hero-q">${f(b.cutSy, 2)}<small>SY</small></p><p class="sub">${b.drops} drop${b.drops === 1 ? "" : "s"} × ${ftIn(b.dropFt)} off a ${ftIn(Number(roll))} roll</p><table>${row("Roll length", `${f(b.cutLf, 2)} LF`)}${row("Cut area", `${f(b.cutSf, 1)} SF`)}${row("Room (net)", `${f(b.netSy, 2)} SY`)}${row("Seams", b.seams ? `${b.seams} · ${f(b.seamLf, 1)} LF` : "none")}${row("Not on the floor", `${f(b.wastePct, 1)}%`)}${row("Order", `${f(b.cutSy, 2)} SY`, "total")}</table>${rollSvg(b, Number(len), Number(wid), Number(roll))}<p class="alt">Other direction (${dir(o).replace("running ", "")}): ${o.drops} × ${ftIn(o.dropFt)} = ${f(o.cutSy, 2)} SY, ${o.seams} seam${o.seams === 1 ? "" : "s"}.</p>`;
    },
  },

  base: {
    fields: [
      { name: "perim", label: "Wall perimeter", unit: "LF", value: 412, step: "any", help: "Every wall face that gets base, measured on the finish side." },
      { name: "doors", label: "Door and cased openings", unit: "EA", value: 14, step: "1" },
      { name: "dw", label: "Opening width", unit: "FT", value: 3, step: "any" },
      { name: "waste", label: "Waste", unit: "%", value: 5, step: "any" },
      { name: "piece", label: "Piece or coil length", unit: "LF", value: 120, step: "any", presets: [4, 8, 120], help: "4′ sticks, 8′ lengths, or a coil (commonly 100′–120′)." },
    ],
    render({ perim, doors, dw, waste, piece }) {
      const r = baseOrder({ perimeterLf: perim, openings: doors, openingWidthFt: dw, wastePct: waste, pieceLf: piece });
      return `<p class="r-kicker">Base order</p><p class="hero-q">${f(r.required, 1)}<small>LF</small></p><p class="sub">${r.pieces} × ${f(Number(piece) || 0, 0)}′ = ${f(r.ordered, 0)} LF delivered</p><table>${row("Perimeter", `${f(r.perimeter, 1)} LF`)}${row(`− Openings (${Math.floor(Number(doors) || 0)} × ${f(Number(dw) || 0, 1)}′)`, `${f(r.deduct, 1)} LF`)}${row("= Net base", `${f(r.net, 1)} LF`)}${row(`+ Waste ${f(Number(waste) || 0, 1)}%`, `${f(r.waste, 1)} LF`)}${row("Required", `${f(r.required, 1)} LF`, "total")}${row("Pieces / coils", String(r.pieces), "total")}</table>`;
    },
  },
};

// To-scale plan of the chosen layout: the room, its drops, seams dashed.
function rollSvg(b, len, wid, roll) {
  const W = 360, H = 200, pad = 14;
  const roomW = b.direction === "length" ? len : wid; // drops run along x
  const roomH = b.direction === "length" ? wid : len; // stacked along y
  const s = Math.min((W - 2 * pad) / roomW, (H - 2 * pad) / roomH);
  const w = roomW * s, h = roomH * s, x0 = (W - w) / 2, y0 = (H - h) / 2;
  let strips = "";
  for (let i = 0; i < b.drops; i++) {
    const y = y0 + i * roll * s;
    const sh = Math.min(roll * s, y0 + h - y);
    strips += `<rect x="${x0.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${sh.toFixed(1)}" fill="${i % 2 ? "#2a3c5a" : "#23344f"}"/>`;
    if (i > 0) strips += `<line x1="${x0.toFixed(1)}" x2="${(x0 + w).toFixed(1)}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#ecd29b" stroke-dasharray="5 4" stroke-width="1.2"/>`;
    strips += `<text x="${(x0 + 8).toFixed(1)}" y="${(y + Math.min(sh, 18) - 5).toFixed(1)}" fill="#d2ae6d" font-size="10" font-family="JetBrains Mono, monospace">${i + 1}</text>`;
  }
  return `<div class="rolldiag"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Room ${ftIn(len)} by ${ftIn(wid)} with ${b.drops} drops${b.seams ? ` and ${b.seams} seam${b.seams === 1 ? "" : "s"}` : ""}"><rect x="0" y="0" width="${W}" height="${H}" fill="none"/>${strips}<rect x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="none" stroke="#d2ae6d" stroke-width="1.5"/></svg></div>`;
}

/** Form markup for a calculator; values from `vals` (defaults when absent). */
export function formHtml(id, vals = {}) {
  const c = CALCS[id];
  return c.fields
    .map((fd) => {
      const v = vals[fd.name] ?? fd.value;
      const presets = fd.presets
        ? `<div class="seg" data-for="${fd.name}">${fd.presets.map((p) => `<button type="button" data-v="${p}" aria-pressed="${Number(v) === p}">${fd.unit === "FT" ? ftIn(p) : `${p}′`}</button>`).join("")}</div>`
        : "";
      return `<div class="field"><label for="f-${fd.name}">${fd.label}</label><div class="inp"><input id="f-${fd.name}" name="${fd.name}" type="number" inputmode="decimal" min="0" step="${fd.step}" value="${v}"><span class="unit">${fd.unit}</span></div>${presets}${fd.help ? `<small>${fd.help}</small>` : ""}</div>`;
    })
    .join("");
}

export function defaults(id) {
  return Object.fromEntries(CALCS[id].fields.map((fd) => [fd.name, fd.value]));
}
