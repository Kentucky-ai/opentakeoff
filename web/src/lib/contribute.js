// Contribute to the open flooring model — strictly opt-in.
//
// The pitch: grow a shared, flooring-tuned open dataset/model the community is
// proud to feed. What's sent is the DERIVED takeoff only — condition labels,
// per-shape roles + quantities, and NORMALIZED (0..1) geometry. What is NEVER
// sent: the raw PDF, file names, project/customer names, markup text, or any
// absolute coordinates. The code is open so anyone can audit exactly this.
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

// Build the anonymized, derived-only payload. No raw plan, no identifiers.
export function buildContribution({ conditions, shapes }) {
  const sheetIds = [...new Set(shapes.map((s) => s.sheet_id))];
  const sheetIndex = new Map(sheetIds.map((k, i) => [k, `sheet_${i + 1}`])); // strip file names
  const tagOf = Object.fromEntries((conditions || []).map((c) => [c.id, c.finish_tag]));

  const anonShapes = shapes.map((s) => ({
    role: s.measure_role,
    finish: tagOf[s.condition_id] || "?",
    sheet: sheetIndex.get(s.sheet_id),
    verts_norm: s.verts_norm,          // normalized 0..1 — shape only, no scale/location
    computed: s.computed,              // SF / LF / EA
    ...(s.height_ft ? { height_ft: s.height_ft } : {}),
    ...(s.origin?.method ? { origin_method: s.origin.method } : {}),
  }));

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
    schema: "opentakeoff.contribution.v1",
    generator: "opentakeoff",
    sheet_count: sheetIds.length,
    conditions: anonConditions,
    shapes: anonShapes,
    totals,
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
