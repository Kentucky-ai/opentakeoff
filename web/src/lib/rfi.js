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

// The four RFI states, in lifecycle order. `color` is a literal hex (used both
// as an SVG fill and as DOM chrome), `label` is the human string.
export const RFI_STATUSES = [
  { id: "open", label: "Open", color: "#1f3fc7" },       // cobalt — awaiting an answer
  { id: "answered", label: "Answered", color: "#1f6b4a" }, // positive green — response in
  { id: "closed", label: "Closed", color: "#5a5346" },    // muted ink — resolved & filed
  { id: "void", label: "Void", color: "#b03a26" },        // danger red — withdrawn / N/A
];

const STATUS_BY_ID = Object.fromEntries(RFI_STATUSES.map((s) => [s.id, s]));

// status → {id,label,color}; unknown/blank falls back to Open so a hand-edited
// or future record never renders a blank chip or crashes a color lookup.
export function rfiStatus(id) {
  return STATUS_BY_ID[id] || RFI_STATUSES[0];
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

// The RFIs that still exist. A withdrawn RFI is a TOMBSTONE, not a removal:
// the record stays with `deleted: true` so its number is never reissued (an
// RFI number that went to the architect and then means something else is a
// lie) — but it prints nowhere. The register, the marked set's RFI schedule,
// the CSV/JSON log, and the app payload all read through this, so a withdrawn
// RFI leaves a numbering gap everywhere and nextRfiNumber (which reads ALL
// records, tombstones included) never fills it.
export function liveRfis(rfis = []) {
  return (rfis || []).filter((r) => r && r.deleted !== true);
}

// An agent-raised RFI is PENDING until an estimator accepts it — the same
// origin.reviewed flag every agent shape carries (pencil until a human turns
// it to ink). An RFI goes to the architect, so nothing sends without a human.
// A record with no origin (panel-raised) is the estimator's own and never
// pending; an origin the panel accepted (reviewed: true) is not pending.
export function rfiPending(r) {
  return !!r?.origin && r.origin.actor === "agent" && r.origin.reviewed !== true;
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
    "Number", "Subject", "Status", "Ball in court", "Priority",
    "Cost impact", "Schedule impact", "Date", "Question", "Response",
    "Response date", "Linked markups", "Linked sheets",
  ];
  const lines = [
    "# RFI log — one row per RFI; linked markups/sheets derived from markup.rfi_id",
    header.map(esc).join(","),
  ];
  for (const r of liveRfis(rfis)) {
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
  const title = projectName ? `# ${projectName} — ${brandName} RFI log\n` : "";
  return title + lines.join("\n") + "\n";
}

// JSON envelope for the RFI log — same schema idiom as shapesToJson.
export function rfisToJson(rfis = [], projectName = "") {
  return {
    schema: "opentakeoff.rfis.v1",
    project_name: projectName || null,
    generated_with: "OpenTakeoff",
    rfis: liveRfis(rfis),
  };
}
