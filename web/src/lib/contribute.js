// Contribute to the open flooring model — strictly opt-in.
//
// The pitch: grow a shared, flooring-tuned open dataset/model the community is
// proud to feed. What's sent is the DERIVED takeoff only — condition labels,
// per-shape roles + quantities, NORMALIZED (0..1) geometry, and each shape's
// provenance (hand-traced vs. machine-proposed, and whether a human corrected
// it). What is NEVER sent: the raw PDF, file names, project/customer names,
// markup or shape-label text, absolute coordinates, scale values, or any edit
// timing beyond each shape's created_at. Shape/sheet identifiers go out as
// opaque tokens (UUIDs / sheet_N) that carry no content. The code is open so
// anyone can audit exactly this; the normative contract — every MUST NOT, the
// field tables, the provenance vocabulary — lives in docs/CONTRIBUTION_SPEC.md.
//
// The collection endpoint is configured at deploy time (VITE_CONTRIBUTE_ENDPOINT)
// or per-browser (localStorage), and can be left unset — in which case the
// Contribute button explains it isn't configured rather than sending anything.

import { conditionTotals } from "./totals.js";

export function contributeEndpoint() {
  try {
    const override = localStorage.getItem("opentakeoff_contribute_endpoint");
    if (override) return override;
  } catch { /* private mode */ }
  // Vite inlines this at build; empty string = not configured.
  return (import.meta.env && import.meta.env.VITE_CONTRIBUTE_ENDPOINT) || "";
}

export function isContributeConfigured() {
  return !!contributeEndpoint();
}

// Where the endpoint came from: "browser" = the user set it themselves (the
// self-capture flow — their own capture server, their own corpus), "build" =
// baked in at deploy time (a shared collection endpoint), "" = not configured.
// The Contribute modal uses this to say the honest thing: self-capture is
// keeping your own data, not contributing to anything.
export function endpointSource() {
  try {
    if (localStorage.getItem("opentakeoff_contribute_endpoint")) return "browser";
  } catch { /* private mode */ }
  return (import.meta.env && import.meta.env.VITE_CONTRIBUTE_ENDPOINT) ? "build" : "";
}

// Vite inlines the app version at build (vite.config.js `define`); under the
// Node test runner the identifier simply doesn't exist, hence the typeof guard.
const APP_VERSION = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "";

// The ONLY origin keys that ever leave the machine. A whitelist, never a
// spread: any key a newer (or patched) build adds to origin stays local until
// it is deliberately added here AND documented in docs/CONTRIBUTION_SPEC.md.
const ORIGIN_FIELDS = [
  "method",               // how the geometry came to exist: "manual" | "one_click_v1" | "agent_v1" | ...
  "actor",                // omitted = human at the canvas; "agent" = MCP client / in-canvas agent
  "reviewed",             // a human affirmed the shape at an explicit gate
  "edited",               // corrected after Create
  "edited_before_create", // corrected between proposal and Create
  "copied",               // pasted clone — lineage without fresh evidence
  "seed_norm",            // normalized one-click seed point
  "proposed_verts_norm",  // the machine's original trace, frozen at first correction
  "hatch_filtered",       // one-click ran with hatch filtering
  "raster_traced",        // traced from scan pixels, not vector linework
  "fill_sensitivity",     // non-default one-click fill sensitivity
  "edits",                // per-kind correction tally, e.g. { vertex: 2, move: 1 }
  "evidence",             // agent_v1: cited basis — DEEP-whitelisted below, never passed through
];

// The evidence sub-object is itself a whitelist, never a spread: exactly the
// matched schedule/room TOKEN (never arbitrary sheet text — strings truncated
// to 80 chars as a hard line) and/or the one-click seed. Anything else an
// agent (or a patched build) stuffs into evidence stays local. Note the
// agent's accept-gate timestamps (proposed_ts / accepted_ts) are deliberately
// NOT origin fields on the wire — edit timing beyond created_at never rides.
const EVIDENCE_FIELDS = ["schedule_row_tag", "matched_text", "seed_norm"];
const EVIDENCE_MAX_CHARS = 80;
const pickEvidence = (ev) => {
  if (!ev || typeof ev !== "object" || Array.isArray(ev)) return null;
  /** @type {Record<string, any>} */
  const out = {};
  for (const k of EVIDENCE_FIELDS) {
    if (ev[k] === undefined) continue;
    out[k] = typeof ev[k] === "string" ? ev[k].slice(0, EVIDENCE_MAX_CHARS) : ev[k];
  }
  return Object.keys(out).length ? out : null;
};

/** @returns {Record<string, any> | null} the whitelisted origin, or null when nothing survives */
export function pickOrigin(origin) {
  if (!origin || typeof origin !== "object") return null;
  /** @type {Record<string, any>} */
  const out = {};
  for (const k of ORIGIN_FIELDS) {
    if (origin[k] === undefined) continue;
    if (k === "evidence") {
      const ev = pickEvidence(origin.evidence);
      if (ev) out.evidence = ev;
      continue;
    }
    out[k] = origin[k];
  }
  return Object.keys(out).length ? out : null;
}

// Omit-when-empty for the provenance counters: an all-empty tally says nothing.
const hasCounts = (c) => !!c && Object.values(c).some((v) =>
  typeof v === "number" ? v > 0 : !!v && typeof v === "object" && Object.keys(v).length > 0);

// Build the anonymized, derived-only payload. No raw plan, no identifiers.
/**
 * @param {{
 *   conditions: Array<Record<string, unknown>>,
 *   shapes: Array<Record<string, any>>,
 *   scaleInfo?: Array<{ sheet_id: string, units_per_px?: number, scale_source?: string }>,
 *   counters?: Record<string, number | Record<string, number>> | null,
 * }} takeoff — scaleInfo's units_per_px is accepted (it's what the canvas has) and NEVER read
 */
export function buildContribution({ conditions, shapes, scaleInfo = [], counters = null }) {
  const sheetIds = [...new Set(shapes.map((s) => s.sheet_id))];
  const sheetIndex = new Map(sheetIds.map((k, i) => [k, `sheet_${i + 1}`])); // strip file names
  const tagOf = Object.fromEntries((conditions || []).map((c) => [c.id, c.finish_tag]));

  // Per-sheet scale PROVENANCE only ("calibrated" / "detected" / "standard" /
  // "unknown") — never units_per_px or any other scale value.
  const bySheet = new Map((scaleInfo || []).map((si) => [si.sheet_id, si.scale_source]));
  const sheets = sheetIds.map((sid) => ({
    sheet: sheetIndex.get(sid),
    ...(bySheet.get(sid) ? { scale_source: bySheet.get(sid) } : {}),
  }));

  const anonShapes = shapes.map((s) => {
    const origin = pickOrigin(s.origin);
    return {
      role: s.measure_role,
      finish: tagOf[s.condition_id] || "?",
      sheet: sheetIndex.get(s.sheet_id),
      verts_norm: s.verts_norm,          // normalized 0..1 — shape only, no scale/location
      computed: s.computed,              // SF / LF / EA
      ...(s.height_ft ? { height_ft: s.height_ft } : {}),
      ...(s.id ? { id: s.id } : {}),     // opaque UUID — links re-contributions, carries no content
      ...(s.created_at ? { created_at: s.created_at } : {}), // legacy shapes predate stamping — omitted
      ...(origin ? { origin } : {}),     // whitelisted provenance; updated_at/edit timing NEVER ride
    };
  });

  const anonConditions = (conditions || []).map((c) => ({
    finish: c.finish_tag,
    hatch: c.hatch || "solid",
    multiplier: c.multiplier || 1,
    waste_pct: Number(c.waste_pct) || 0,
  }));

  // strip color/id from the totals — keep just the numbers + labels
  const totals = conditionTotals(conditions || [], shapes).map(
    ({ id, color, fill, hatch, ...rest }) => rest
  );

  return {
    schema: "opentakeoff.contribution.v2",
    generator: "opentakeoff",
    ...(APP_VERSION ? { generator_version: APP_VERSION } : {}),
    sheets,
    conditions: anonConditions,
    shapes: anonShapes,
    totals,
    ...(hasCounts(counters) ? { counters } : {}), // aggregate tallies (e.g. shapes_deleted by origin method)
  };
}

export async function sendContribution(payload, contributor = "") {
  const endpoint = contributeEndpoint();
  if (!endpoint) throw new Error("No contribution endpoint is configured for this build.");
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, contributor: contributor || undefined }),
  });
  if (!res.ok) throw new Error(`Contribution failed (HTTP ${res.status}).`);
  return { ok: true };
}
