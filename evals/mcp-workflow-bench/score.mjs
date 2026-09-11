import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve } from "node:path";

const EPS = 1e-9;

function signedArea(ring) {
  return ring.reduce((sum, [x, y], i) => {
    const [nx, ny] = ring[(i + 1) % ring.length];
    return sum + x * ny - nx * y;
  }, 0) / 2;
}

function ringArea(ring) { return Math.abs(signedArea(ring)); }

function pointSegmentDistance([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const denominator = dx * dx + dy * dy;
  const t = denominator === 0
    ? 0
    : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / denominator));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Supported boundary metric: maximum vertex-to-opposite-edge distance in px.
// It is intentionally described as a bounded polygon profile, not general Hausdorff distance.
function boundaryVertexEdgeDistance(a, b) {
  const directed = (from, to) => Math.max(...from.map((point) => Math.min(
    ...to.map((_, i) => pointSegmentDistance(point, to[i], to[(i + 1) % to.length])),
  )));
  return Math.max(directed(a, b), directed(b, a));
}

function clip(subject, a, b, orientation) {
  const side = ([x, y]) => orientation * (
    (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])
  );
  const intersection = (p, q) => {
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const denominator = dx * ey - dy * ex;
    if (Math.abs(denominator) < EPS) return q;
    const t = ((a[0] - p[0]) * ey - (a[1] - p[1]) * ex) / denominator;
    return [p[0] + t * dx, p[1] + t * dy];
  };
  const result = [];
  for (let i = 0; i < subject.length; i += 1) {
    const p = subject[i];
    const q = subject[(i + 1) % subject.length];
    const pInside = side(p) >= -EPS;
    const qInside = side(q) >= -EPS;
    if (pInside && qInside) result.push(q);
    else if (pInside && !qInside) result.push(intersection(p, q));
    else if (!pInside && qInside) result.push(intersection(p, q), q);
  }
  return result;
}

function isConvex(ring) {
  const orientation = Math.sign(signedArea(ring)) || 1;
  let sign = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const c = ring[(i + 2) % ring.length];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) <= EPS) continue;
    if (sign && Math.sign(cross) !== sign) return false;
    sign = Math.sign(cross);
  }
  return sign === orientation || sign === 0;
}

function pointInTriangle(point, a, b, c) {
  const cross = (u, v, w) => (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0]);
  const signs = [cross(a, b, point), cross(b, c, point), cross(c, a, point)];
  return signs.every((value) => value >= -EPS) || signs.every((value) => value <= EPS);
}

function triangulate(ring) {
  const orientation = Math.sign(signedArea(ring)) || 1;
  const indices = ring.map((_, index) => index);
  const triangles = [];
  while (indices.length > 3) {
    let foundEar = false;
    for (let j = 0; j < indices.length; j += 1) {
      const ia = indices[(j + indices.length - 1) % indices.length];
      const ib = indices[j];
      const ic = indices[(j + 1) % indices.length];
      const a = ring[ia];
      const b = ring[ib];
      const c = ring[ic];
      const cross = ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) * orientation;
      if (cross <= EPS) continue;
      if (indices.some((index) => index !== ia && index !== ib && index !== ic && pointInTriangle(ring[index], a, b, c))) continue;
      triangles.push([a, b, c]);
      indices.splice(j, 1);
      foundEar = true;
      break;
    }
    if (!foundEar) return [];
  }
  triangles.push(indices.map((index) => ring[index]));
  return triangles;
}

export function polygonIntersectionArea(a, b) {
  if (!isConvex(a)) {
    return triangulate(a).reduce((sum, triangle) => sum + polygonIntersectionArea(triangle, b), 0);
  }
  let result = a.slice();
  const orientation = signedArea(b) >= 0 ? 1 : -1;
  for (let i = 0; i < b.length && result.length; i += 1) {
    result = clip(result, b[i], b[(i + 1) % b.length], orientation);
  }
  return result.length >= 3 ? ringArea(result) : 0;
}

function hasRepeatedVertices(ring) {
  return ring.some((point, i) => ring.some((other, j) => i !== j && point[0] === other[0] && point[1] === other[1]));
}

function segmentsIntersect(a, b, c, d) {
  const orient = (u, v, w) => (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0]);
  const onSegment = (u, v, p) => Math.min(u[0], v[0]) - EPS <= p[0] && p[0] <= Math.max(u[0], v[0]) + EPS && Math.min(u[1], v[1]) - EPS <= p[1] && p[1] <= Math.max(u[1], v[1]) + EPS;
  const values = [orient(a, b, c), orient(a, b, d), orient(c, d, a), orient(c, d, b)];
  if (Math.abs(values[0]) <= EPS && onSegment(a, b, c)) return true;
  if (Math.abs(values[1]) <= EPS && onSegment(a, b, d)) return true;
  if (Math.abs(values[2]) <= EPS && onSegment(c, d, a)) return true;
  if (Math.abs(values[3]) <= EPS && onSegment(c, d, b)) return true;
  return (values[0] > 0) !== (values[1] > 0) && (values[2] > 0) !== (values[3] > 0);
}

function isSelfIntersecting(ring) {
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    for (let j = i + 1; j < ring.length; j += 1) {
      if (j === i || (j + 1) % ring.length === i || (i + 1) % ring.length === j) continue;
      if (segmentsIntersect(a, b, ring[j], ring[(j + 1) % ring.length])) return true;
    }
  }
  return false;
}

function normalizeVertices(shape, width, height) {
  if (!Array.isArray(shape.verts_norm)) return null;
  return shape.verts_norm.map((point) => {
    if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) return [NaN, NaN];
    if (point.some((value) => value < 0 || value > 1)) return [NaN, NaN];
    return [point[0] * width, point[1] * height];
  });
}

function validRing(ring) {
  return Array.isArray(ring)
    && ring.length >= 3
    && ring.every((point) => point.every(Number.isFinite))
    && ringArea(ring) > EPS
    && !hasRepeatedVertices(ring)
    && !isSelfIntersecting(ring);
}

function metadataFailure(candidate, reference) {
  const expectedSheet = reference.source.path.split("/").pop();
  const sheets = candidate?.sheets;
  if (!Array.isArray(sheets) || sheets.length !== 1) return "candidate must contain exactly one calibration sheet";
  const sheet = sheets[0];
  if (sheet.sheet_id !== expectedSheet) return `wrong target sheet: expected ${expectedSheet}`;
  if (!Number.isFinite(sheet.units_per_px) || sheet.units_per_px <= 0) return "missing or invalid units_per_px";
  if (Math.abs(sheet.units_per_px - reference.scale.feet_per_image_px) > 1e-12) return "wrong units_per_px";
  const allowedSources = new Set(["upp", "detected", "label", "calibrate", "standard", "calibrated"]);
  if (!allowedSources.has(sheet.scale_source)) return "wrong scale_source";
  if (sheet.scale_confirmed !== false) return "scale_confirmed must be false";
  return null;
}

export function scoreCandidate(candidate, reference) {
  const metadataError = metadataFailure(candidate, reference);
  const width = reference.source.pdf_points.width * reference.source.render_scale;
  const height = reference.source.pdf_points.height * reference.source.render_scale;
  const scale = reference.scale.feet_per_image_px;
  const shapes = Array.isArray(candidate?.shapes) ? candidate.shapes : [];
  const expectedLabels = new Set(reference.rooms.map((room) => room.label));
  const usable = shapes.filter((shape) => shape.measure_role === "floor_area");
  const byLabel = new Map();
  for (const shape of usable) {
    if (!byLabel.has(shape.label)) byLabel.set(shape.label, []);
    byLabel.get(shape.label).push(shape);
  }
  const rows = reference.rooms.map((room) => {
    const matches = byLabel.get(room.label) ?? [];
    if (matches.length === 0) return { label: room.label, pass: false, reason: "missing candidate label" };
    if (matches.length !== 1) return { label: room.label, pass: false, reason: `duplicate candidate labels (${matches.length})` };
    const shape = matches[0];
    if (shape.verts_norm_holes) return { label: room.label, pass: false, reason: "verts_norm_holes are unsupported" };
    if (!Number.isFinite(shape.computed?.area_sf)) return { label: room.label, pass: false, reason: "missing or invalid computed.area_sf" };
    if (shape.sheet_id !== reference.source.path.split("/").pop()) return { label: room.label, pass: false, reason: "wrong target sheet" };
    const actual = normalizeVertices(shape, width, height);
    if (!validRing(actual)) return { label: room.label, pass: false, reason: "invalid, repeated, or self-intersecting ring" };
    const expected = room.verts_px;
    const expectedAreaSf = ringArea(expected) * scale ** 2;
    const geometryAreaSf = ringArea(actual) * scale ** 2;
    const reportedAreaSf = shape.computed.area_sf;
    const overlap = polygonIntersectionArea(actual, expected);
    const union = ringArea(expected) + ringArea(actual) - overlap;
    const iou = union > EPS ? overlap / union : 0;
    const areaPct = Math.abs(reportedAreaSf - expectedAreaSf) / expectedAreaSf * 100;
    const geometryAreaPct = Math.abs(geometryAreaSf - reportedAreaSf) / Math.max(reportedAreaSf, EPS) * 100;
    const boundaryPx = boundaryVertexEdgeDistance(actual, expected);
    const pass = areaPct <= reference.tolerances.area_percent
      && geometryAreaPct <= 0.01
      && iou >= reference.tolerances.overlap_iou
      && boundaryPx <= reference.tolerances.boundary_max_px;
    return {
      label: room.label,
      area_sf: { expected: expectedAreaSf, actual: reportedAreaSf, percent_error: areaPct },
      overlap_iou: iou,
      boundary_vertex_edge_px: boundaryPx,
      geometry_area_sf: geometryAreaSf,
      pass,
    };
  });
  const extras = shapes.filter((shape) => shape.measure_role !== "floor_area" || !expectedLabels.has(shape.label));
  for (const shape of extras) rows.push({ label: shape.label ?? null, pass: false, reason: "extra or non-floor-area shape" });
  return {
    reference_id: reference.reference_id,
    metadata_error: metadataError,
    rooms: rows,
    pass: !metadataError && rows.length === reference.rooms.length && rows.every((row) => row.pass),
  };
}

function runCli() {
  const args = process.argv.slice(2);
  const candidatePath = args.find((arg) => !arg.startsWith("--"));
  const referenceAt = args.indexOf("--reference");
  if (!candidatePath) {
    console.error("Usage: node score.mjs <candidate-export.json> [--reference reference.json]");
    process.exitCode = 2;
    return;
  }
  const referencePath = referenceAt >= 0
    ? args[referenceAt + 1]
    : fileURLToPath(new URL("./reference.json", import.meta.url));
  const candidate = JSON.parse(readFileSync(resolve(candidatePath), "utf8"));
  const reference = JSON.parse(readFileSync(resolve(referencePath), "utf8"));
  const result = scoreCandidate(candidate, reference);
  console.log(JSON.stringify({ candidate: candidatePath, ...result }, null, 2));
  if (!result.pass) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) runCli();
