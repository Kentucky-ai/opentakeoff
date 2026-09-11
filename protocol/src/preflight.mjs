import { validator, schemaBase, legacyId, draftId } from "./validation.mjs";

const ajv = validator();
export const PROFILE = "takeoff-document-core.v1";
const escapePointer = key => String(key).replace(/~/g, "~0").replace(/\//g, "~1");

// Accept JSON data only, including extensions. Reject values that JSON would
// silently discard or rewrite. Descriptors prevent evaluating input getters.
function inspectJson(value, path, issue, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return;
  if (typeof value !== "object" || ancestors.has(value)) {
    issue("error", "non_json_value", path, "Use finite, acyclic JSON data without negative zero."); return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? prototype !== Array.prototype
    : prototype !== Object.prototype && prototype !== null) {
    issue("error", "non_json_object", path, "Use a plain JSON object."); return;
  }
  if (ancestors.size >= 100) {
    issue("unsupported", "nesting_limit", path, "This profile supports at most 100 nested containers."); return;
  }
  ancestors.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(descriptors, i)) issue("error", "non_json_value", `${path}/${i}`, "Sparse arrays are not supported.");
    }
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (Array.isArray(value) && key === "length") continue;
    const d = descriptors[key], at = `${path}/${escapePointer(key)}`;
    if (typeof key === "symbol" || !d.enumerable || !Object.hasOwn(d, "value") ||
      (Array.isArray(value) && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) {
      issue("error", "non_json_property", at, "Use enumerable JSON data properties."); continue;
    }
    inspectJson(d.value, at, issue, ancestors);
  }
  ancestors.delete(value);
}

/** Read-only eligibility for a future document-envelope adapter, NOT an MCP
 * transport check, geometry verifier, authenticator or format conversion. */
export function preflightTakeoff(record) {
  const issues = [];
  const issue = (severity, code, path, message) => issues.push({ severity, code, path, message });
  const finish = () => ({
    profile: PROFILE,
    status: issues.some(i => i.severity === "error") ? "invalid"
      : issues.some(i => i.severity === "unsupported") ? "unsupported" : "eligible",
    issues,
    notVerified: ["geometry_accuracy", "polygon_topology", "source_availability", "quantity_recomputation",
      "approval_authenticity", "history_completeness", "mcp_transport_preservation"],
  });
  inspectJson(record, "", issue);
  if (issues.length) return finish();
  const id = record?.schema;
  const path = id === legacyId ? "legacy/takeoff-canvas.v1.schema.json"
    : id === draftId ? "v1/takeoff-document.schema.json" : null;
  if (!path) {
    issue("error", "unknown_schema", "/schema", "Expected a current canvas or draft TakeoffDocument identifier.");
    return finish();
  }
  const check = ajv.getSchema(schemaBase + path);
  if (!check(record)) {
    for (const error of check.errors) issue("error", "schema_invalid", error.instancePath, error.message);
    return finish();
  }
  // A missing legacy sheets collection must not become an invented [] merely
  // to satisfy the target schema. Counts can be unscaled in an explicit [].
  if (!Object.hasOwn(record, "sheets")) issue("unsupported", "missing_sheets_collection", "/sheets", "This profile requires an explicit calibration collection, which may be empty for counts.");
  const index = (key, idKey = "id") => {
    const map = new Map();
    for (const [n, row] of (record[key] ?? []).entries()) {
      if (map.has(row[idKey])) issue("error", "duplicate_id", `/${key}/${n}/${idKey}`, "Identifiers must be unique within this collection.");
      map.set(row[idKey], row);
    }
    return map;
  };
  const conditions = index("conditions"), sheets = index("sheets", "sheet_id"), shapes = index("shapes");
  const proposals = index("proposals"); index("approvals"); index("condition_edit_proposals");
  for (const family of ["stitches", "rules", "markups", "rfis"]) {
    if (record[family]?.length) issue("unsupported", "unsupported_family", `/${family}`, "This record family is outside the first document profile; preserve the source intact.");
  }
  for (const [n, edit] of (record.condition_edit_proposals ?? []).entries()) {
    if (!conditions.has(edit.condition_id)) issue("error", "missing_condition", `/condition_edit_proposals/${n}/condition_id`, "The condition edit must reference an existing condition.");
  }
  for (const [n, shape] of record.shapes.entries()) {
    const at = `/shapes/${n}`, condition = conditions.get(shape.condition_id), role = shape.measure_role;
    if (!condition) issue("error", "missing_condition", `${at}/condition_id`, "The measurement must reference an existing condition.");
    if (shape.sheet_id.startsWith("stitch:")) issue("unsupported", "composite_frame", `${at}/sheet_id`, "Composite frames are outside this profile.");
    else if (role !== "count" && !sheets.has(shape.sheet_id)) issue("unsupported", "missing_calibration", `${at}/sheet_id`, "Dimensional measurements require a persisted calibration; this does not establish PDF availability.");
    if (shape.origin?.proposal_id && !proposals.has(shape.origin.proposal_id)) issue("error", "missing_proposal", `${at}/origin/proposal_id`, "The measurement must reference an existing proposal group.");
    const points = new Set(shape.verts_norm.map(p => JSON.stringify(p)));
    const min = role === "count" ? 1 : ["floor_area", "deduct"].includes(role) ? 3 : 2;
    if (points.size < min) issue("error", "insufficient_vertices", `${at}/verts_norm`, `This role needs at least ${min} distinct vertices.`);
    const quantity = role === "count" ? "count" : role === "linear" ? "perimeter_lf" : "area_sf";
    for (const key of ["area_sf", "perimeter_lf", "count"]) {
      if (Object.hasOwn(shape.computed, key) && shape.computed[key] < 0)
        issue("error", "negative_quantity", `${at}/computed/${key}`, "Stored quantities cannot be negative, including independent deductions.");
    }
    if (role === "count" && !Object.hasOwn(shape.computed, "count")) {
      issue("warning", "legacy_count_default", `${at}/computed`, "Existing totals treat an absent count as one. Preflight preserves its absence.");
    } else if (!Object.hasOwn(shape.computed, quantity) ||
      (role === "count" && (!Number.isInteger(shape.computed.count) || shape.computed.count < 1))) {
      issue("error", "invalid_role_quantity", `${at}/computed/${quantity}`, "The stored quantity must be present and nonnegative; counts must be positive integers.");
    }
    if (role === "surface_area") {
      const height = shape.height_ft ?? condition?.height_ft;
      if (!(typeof height === "number" && height > 0)) issue("unsupported", "missing_surface_height", `${at}/height_ft`, "A surface needs positive shape or condition height in this profile.");
    }
    if (shape.curved === true) issue("unsupported", "legacy_curve", `${at}/curved`, "Legacy control-point curves need a separate semantic profile.");
    if (shape.verts_norm_holes?.length) issue("unsupported", "hole_geometry", `${at}/verts_norm_holes`, "Hole topology is outside this profile.");
    if (shape.cuts_shape_id || shape.origin?.cuts_shape_id) issue("unsupported", "reconciled_cutout", at, "Reconciled cutouts need a dedicated preservation profile.");
    // These citations can outlive their source (delete/undo); never rewrite
    // or erase them, and never misclassify them as active foreign-key errors.
    const historical = [shape.origin?.derived?.from_shape_id,
      ...(shape.origin?.derived?.between_shape_ids ?? []), shape.origin?.seed_shape_id, shape.origin?.container_shape_id].filter(Boolean);
    if (historical.some(id => !shapes.has(id))) issue("warning", "historical_reference_unavailable", `${at}/origin`, "A historical source is not in this document. Its citation must remain unchanged.");
    if (shape.origin?.edited && !shape.origin?.proposed_verts_norm?.length && shape.origin?.actor === "agent")
      issue("warning", "original_geometry_unavailable", `${at}/origin`, "An edited agent record lacks an original ring. Do not reconstruct or claim that missing history.");
  }
  // Always explicit: actor/review fields are transported claims, not proof.
  issue("warning", "authority_not_authenticated", "/approvals", "Preflight cannot authenticate approval or human review and grants no authority to create either.");
  return finish();
}
