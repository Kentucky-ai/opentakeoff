// RFI (Request For Information) helpers — pure, node-testable (see
// test/rfi.test.ts). The RFI register turns the dormant markup.rfi_id hook into
// a real deliverable: a markup links to an RFI via markup.rfi_id === rfi.id
// (one RFI ↔ many markups), and linked markups are DERIVED from that — never
// stored twice.
//
// Record shape (all additive to the v1 annotations payload):
//   Rfi = { id, number, subject, question, status, to, priority,
//           cost_impact, schedule_impact, date, response, response_date,
//           sheet_id }
//
// SVG presentation attributes take LITERAL colors (CSS vars don't resolve
// there) — the status colors below are the same cobalt/positive/danger literals
// the canvas uses elsewhere.

import { csvEsc as esc } from "./csv.js";
import i18n from '../i18n/index.js';
const t = (key, options) => i18n.t(key, { ns: 'lib', ...options });

// The four RFI states, in lifecycle order. `color` is a literal hex (used both
// as an SVG fill and as DOM chrome), `label` is the human string.
export const getRfiStatuses = () => [
  { id: "open", label: t("rfi.status.open"), color: "#1f3fc7" },
  { id: "answered", label: t("rfi.status.answered"), color: "#1f6b4a" },
  { id: "closed", label: t("rfi.status.closed"), color: "#5a5346" },
  { id: "void", label: t("rfi.status.void"), color: "#b03a26" },
];
export const RFI_STATUSES = getRfiStatuses();

const STATUS_IDS = new Set(RFI_STATUSES.map((s) => s.id));

// status → {id,label,color}; unknown/blank falls back to Open so a hand-edited
// or future record never renders a blank chip or crashes a color lookup.
export function rfiStatus(id) {
  const statuses = getRfiStatuses();
  return statuses.find((s) => STATUS_IDS.has(s.id) && s.id === id) || statuses[0];
}

// Next "RFI-###" — max existing number + 1, zero-padded to 3 digits. Only the
// trailing integer of each `number` counts (so "RFI-009" → "RFI-010"), gaps are
// tolerated (max, not count), and an empty/garbage list starts at RFI-001.
export function nextRfiNumber(rfis = []) {
  let max = 0;
  for (const r of rfis || []) {
    const m = /(\d+)\s*$/.exec(String(r?.number ?? ""));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `RFI-${String(max + 1).padStart(3, "0")}`;
}

// Markups linked to an RFI: markup.rfi_id === rfi.id is the single source of
// truth. Returns [] for a null/blank id so a fresh RFI reports 0 links.
export function linkedMarkups(rfi, markups = []) {
  if (!rfi?.id) return [];
  return (markups || []).filter((m) => m.rfi_id === rfi.id);
}

// RFI log CSV — mirrors shapesToCsv (title line, csvEsc-escaped header + rows,
// trailing newline). Ball-in-court, priority, and the impact flags are the
// "fuller" fields; linked sheets/markup count are derived from `markups`.
/**
 * @param {any[]} [rfis]
 * @param {any[]} [markups]
 * @param {string} [projectName]
 * @param {((sheetId: any) => string)|null} [sheetLabel]
 */
export function rfisToCsv(rfis = [], markups = [], projectName = "", sheetLabel = null, brandName = "OpenTakeoff") {
  const label = (id) => (sheetLabel ? sheetLabel(id) : id);
  const header = [
    t("rfi.csv_header.number"), t("rfi.csv_header.subject"), t("rfi.csv_header.status"), t("rfi.csv_header.ball_in_court"), t("rfi.csv_header.priority"),
    t("rfi.csv_header.cost_impact"), t("rfi.csv_header.schedule_impact"), t("rfi.csv_header.date"), t("rfi.csv_header.question"), t("rfi.csv_header.response"),
    t("rfi.csv_header.response_date"), t("rfi.csv_header.linked_markups"), t("rfi.csv_header.linked_sheets"),
  ];
  const lines = [
    t("rfi.csv_title"),
    header.map(esc).join(","),
  ];
  for (const r of rfis || []) {
    const linked = linkedMarkups(r, markups);
    const sheets = [...new Set(linked.map((m) => label(m.sheet_id)))].join("; ");
    lines.push([
      r.number ?? "",
      r.subject ?? "",
      rfiStatus(r.status).label,
      r.to ?? "",
      r.priority ?? "",
      r.cost_impact ? "yes" : "",
      r.schedule_impact ? "yes" : "",
      r.date ?? "",
      r.question ?? "",
      r.response ?? "",
      r.response_date ?? "",
      linked.length,
      sheets,
    ].map(esc).join(","));
  }
  const title = projectName ? `# ${projectName} — ${brandName} ${t("rfi.log_title")}\n` : "";
  return title + lines.join("\n") + "\n";
}

// JSON envelope for the RFI log — same schema idiom as shapesToJson.
export function rfisToJson(rfis = [], projectName = "") {
  return {
    schema: "opentakeoff.rfis.v1",
    project_name: projectName || null,
    generated_with: "OpenTakeoff",
    rfis: rfis || [],
  };
}
