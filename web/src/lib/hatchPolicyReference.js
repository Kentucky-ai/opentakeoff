// Experimental reference policy. Production One-Click does not import this module.
const DEFAULTS = Object.freeze({
  angleToleranceDeg: 2,
  widthBucketStep: 0.25,
  minPitch: 0.002,
  maxPitch: 0.4,
  maxGapMultiple: 4,
  offsetTolerance: 0.0005,
  relativeOffsetTolerance: 0.08,
  minRows: 5,
  minInlierRate: 0.75,
  minOccupancy: 0.7,
  maxCrossConnectorRatio: 0.15,
});

// Trusted provenance is deliberately not stored on the public proposal shape.
// Only proposals created in this module after validating the caller's separate
// trusted group set can carry a native role into classification. Cloning or
// reconstructing a proposal drops that privilege and fails closed.
const trustedNativeRoles = new WeakMap();

function finite(value, name) {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
  return value;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function quantile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function angleModuloPi(segment) {
  let angle = Math.atan2(segment.y2 - segment.y1, segment.x2 - segment.x1);
  if (angle < 0) angle += Math.PI;
  if (angle >= Math.PI) angle -= Math.PI;
  return angle;
}

function angleDistance(left, right) {
  const difference = Math.abs(left - right);
  return Math.min(difference, Math.PI - difference);
}

function segmentLength(segment) {
  return Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1);
}

function normalizedPhase(value, pitch) {
  const phase = value % pitch;
  return phase < 0 ? phase + pitch : phase;
}

function latticeResidual(value, phase, pitch) {
  const steps = Math.round((value - phase) / pitch);
  return Math.abs(value - (phase + steps * pitch));
}

function intersects(left, right, epsilon = 1e-9) {
  const ax = left.x2 - left.x1;
  const ay = left.y2 - left.y1;
  const bx = right.x2 - right.x1;
  const by = right.y2 - right.y1;
  const determinant = ax * by - ay * bx;
  if (Math.abs(determinant) <= epsilon) return false;
  const cx = right.x1 - left.x1;
  const cy = right.y1 - left.y1;
  const t = (cx * by - cy * bx) / determinant;
  const u = (cx * ay - cy * ax) / determinant;
  return t >= -epsilon && t <= 1 + epsilon && u >= -epsilon && u <= 1 + epsilon;
}

function validateSegments(segments) {
  if (!Array.isArray(segments)) throw new Error("segments must be an array");
  const ids = new Set();
  return segments.map((segment, index) => {
    const id = segment.id ?? `s${index}`;
    const normalized = {
      ...segment,
      id: String(id),
      x1: finite(segment.x1, `${id}.x1`),
      y1: finite(segment.y1, `${id}.y1`),
      x2: finite(segment.x2, `${id}.x2`),
      y2: finite(segment.y2, `${id}.y2`),
      strokeWidth: segment.strokeWidth === undefined
        ? 1
        : finite(segment.strokeWidth, `${id}.strokeWidth`),
    };
    if (ids.has(normalized.id)) throw new Error(`duplicate segment id: ${normalized.id}`);
    ids.add(normalized.id);
    if (normalized.strokeWidth <= 0) throw new Error(`${id}.strokeWidth must be positive`);
    if (segmentLength(normalized) === 0) throw new Error(`${id} must not be degenerate`);
    return normalized;
  });
}

function sheetCoordinateScale(segments) {
  const xs = segments.flatMap((segment) => [segment.x1, segment.x2]);
  const ys = segments.flatMap((segment) => [segment.y1, segment.y2]);
  const lengths = segments.map(segmentLength);
  const useQuantiles = xs.length >= 20;
  const xSpan = useQuantiles
    ? quantile(xs, 0.95) - quantile(xs, 0.05)
    : Math.max(...xs) - Math.min(...xs);
  const ySpan = useQuantiles
    ? quantile(ys, 0.95) - quantile(ys, 0.05)
    : Math.max(...ys) - Math.min(...ys);
  return Math.max(xSpan, ySpan, 20 * (median(lengths) || 0), Number.EPSILON);
}

function candidateGroups(segments, configuration) {
  const angleStep = configuration.angleToleranceDeg * Math.PI / 180;
  const widths = segments.map((segment) => segment.strokeWidth);
  const sheetMedianWidth = median(widths) || 1;
  const groupMaps = [0, angleStep / 2].map(() => new Map());

  for (const segment of segments) {
    const angle = angleModuloPi(segment);
    const style = segment.style ?? Math.round(
      (segment.strokeWidth / sheetMedianWidth) / configuration.widthBucketStep,
    );
    for (let pass = 0; pass < groupMaps.length; pass += 1) {
      const shifted = (angle + pass * angleStep / 2) % Math.PI;
      const angleBucket = Math.floor(shifted / angleStep);
      const key = `${angleBucket}|${style}`;
      const group = groupMaps[pass].get(key) || [];
      group.push(segment);
      groupMaps[pass].set(key, group);
    }
  }
  return groupMaps.flatMap((groups) => [...groups.values()]);
}

export function fitNormalOffsetLattice(segments, options = {}) {
  const configuration = { ...DEFAULTS, ...options };
  const sourceSegments = validateSegments(segments);
  if (sourceSegments.length < configuration.minRows) return null;
  const coordinateScale = options.coordinateScale || sheetCoordinateScale(sourceSegments);
  if (!Number.isFinite(coordinateScale) || coordinateScale <= 0) {
    throw new Error("coordinateScale must be positive and finite");
  }
  const normalizedSegments = sourceSegments.map((segment) => ({
    ...segment,
    x1: segment.x1 / coordinateScale,
    y1: segment.y1 / coordinateScale,
    x2: segment.x2 / coordinateScale,
    y2: segment.y2 / coordinateScale,
  }));

  let cosine = 0;
  let sine = 0;
  for (const segment of normalizedSegments) {
    const doubled = angleModuloPi(segment) * 2;
    cosine += Math.cos(doubled);
    sine += Math.sin(doubled);
  }
  let angle = Math.atan2(sine, cosine) / 2;
  if (angle < 0) angle += Math.PI;
  const tangent = [Math.cos(angle), Math.sin(angle)];
  const normal = [-tangent[1], tangent[0]];
  const projected = normalizedSegments.map((segment) => {
    const midpointX = (segment.x1 + segment.x2) / 2;
    const midpointY = (segment.y1 + segment.y2) / 2;
    return {
      segment,
      rho: midpointX * normal[0] + midpointY * normal[1],
      length: segmentLength(segment),
    };
  }).sort((left, right) => left.rho - right.rho);
  const rowMergeTolerance = configuration.offsetTolerance / 2;
  const offsetRows = [];
  for (const item of projected) {
    const current = offsetRows[offsetRows.length - 1];
    if (current && Math.abs(item.rho - current.anchor) <= rowMergeTolerance) {
      current.items.push(item);
      current.rho = current.items.reduce((sum, row) => sum + row.rho, 0) / current.items.length;
    } else {
      offsetRows.push({ anchor: item.rho, rho: item.rho, items: [item] });
    }
  }
  const uniqueOffsets = offsetRows.map((row) => row.rho);
  if (offsetRows.length < configuration.minRows) return null;

  const pitchCandidates = new Set();
  for (let left = 0; left < uniqueOffsets.length; left += 1) {
    for (let right = left + 1; right < uniqueOffsets.length; right += 1) {
      const difference = uniqueOffsets[right] - uniqueOffsets[left];
      for (let multiple = 1; multiple <= configuration.maxGapMultiple; multiple += 1) {
        const pitch = difference / multiple;
        if (pitch >= configuration.minPitch && pitch <= configuration.maxPitch) {
          pitchCandidates.add(+pitch.toFixed(6));
        }
      }
    }
  }

  let best = null;
  const segmentLengthCap = 2 * (median(projected.map((row) => row.length)) || 1);
  const cappedTotalLength = projected.reduce(
    (sum, row) => sum + Math.min(row.length, segmentLengthCap),
    0,
  );
  for (const pitch of pitchCandidates) {
    const tolerance = Math.max(
      configuration.offsetTolerance,
      pitch * configuration.relativeOffsetTolerance,
    );
    for (const source of uniqueOffsets) {
      const phase = normalizedPhase(source, pitch);
      const inlierRows = offsetRows.filter(
        (row) => latticeResidual(row.rho, phase, pitch) <= tolerance,
      );
      const rowNumbers = inlierRows.map((row) => Math.round((row.rho - phase) / pitch));
      const distinctRows = [...new Set(rowNumbers)].sort((left, right) => left - right);
      if (distinctRows.length < configuration.minRows) continue;
      const rowSpan = distinctRows[distinctRows.length - 1] - distinctRows[0] + 1;
      const occupancy = distinctRows.length / rowSpan;
      const rowInlierRate = inlierRows.length / offsetRows.length;
      const inlierItems = inlierRows.flatMap((row) => row.items);
      const cappedInlierLength = inlierItems.reduce(
        (sum, row) => sum + Math.min(row.length, segmentLengthCap),
        0,
      );
      const segmentInlierRate = cappedTotalLength > 0 ? cappedInlierLength / cappedTotalLength : 0;
      const normalizedResiduals = inlierRows.map(
        (row) => latticeResidual(row.rho, phase, pitch) / pitch,
      );
      const medianNormalizedResidual = median(normalizedResiduals) || 0;
      const residualScore = Math.max(
        0,
        1 - medianNormalizedResidual / configuration.relativeOffsetTolerance,
      );
      const score = rowInlierRate * occupancy * occupancy * residualScore
        * (1 - Math.exp(-distinctRows.length / 4));
      const candidate = {
        pitch,
        phase,
        tolerance,
        inlierRows,
        inlierItems,
        distinctRows,
        occupancy,
        rowInlierRate,
        segmentInlierRate,
        medianNormalizedResidual,
        score,
      };
      if (
        !best || candidate.score > best.score + 1e-12 ||
        (Math.abs(candidate.score - best.score) <= 1e-12 && candidate.pitch > best.pitch)
      ) best = candidate;
    }
  }
  if (
    !best || best.rowInlierRate < configuration.minInlierRate ||
    best.segmentInlierRate < configuration.minInlierRate ||
    best.occupancy < configuration.minOccupancy
  ) return null;

  const inlierSegments = best.inlierItems.map((row) => row.segment);
  const normalValues = best.inlierRows.map((row) => row.rho);
  const tangentValues = inlierSegments.flatMap((segment) => [
    segment.x1 * tangent[0] + segment.y1 * tangent[1],
    segment.x2 * tangent[0] + segment.y2 * tangent[1],
  ]);
  const normalSpan = (Math.max(...normalValues) - Math.min(...normalValues)) * coordinateScale;
  const tangentSpan = (Math.max(...tangentValues) - Math.min(...tangentValues)) * coordinateScale;
  const shorterSpan = Math.max(1e-9, Math.min(normalSpan, tangentSpan));

  return {
    angleDeg: angle * 180 / Math.PI,
    coordinateScale,
    pitch: best.pitch * coordinateScale,
    pitchNormalized: best.pitch,
    phase: best.phase * coordinateScale,
    tolerance: best.tolerance * coordinateScale,
    rowCount: best.distinctRows.length,
    rowInlierRate: best.rowInlierRate,
    segmentInlierRate: best.segmentInlierRate,
    inlierRate: best.rowInlierRate,
    occupancy: best.occupancy,
    medianNormalizedResidual: best.medianNormalizedResidual,
    score: best.score,
    normalSpan,
    tangentSpan,
    aspectRatio: Math.max(normalSpan, tangentSpan) / shorterSpan,
    memberIds: inlierSegments.map((segment) => segment.id),
  };
}

function connectorEvidence(family, segments) {
  const members = new Set(family.memberIds);
  const memberSegments = segments.filter((segment) => members.has(segment.id));
  const touched = new Set();
  let supportRailCount = 0;
  const familyAngle = family.angleDeg * Math.PI / 180;
  for (const other of segments) {
    if (members.has(other.id) || other.contextRole === "clip-boundary") continue;
    if (angleDistance(angleModuloPi(other), familyAngle) < 15 * Math.PI / 180) continue;
    let connectorTouches = 0;
    for (const member of memberSegments) {
      if (intersects(member, other)) {
        touched.add(member.id);
        connectorTouches += 1;
      }
    }
    if (memberSegments.length && connectorTouches / memberSegments.length >= 0.7) {
      supportRailCount += 1;
    }
  }
  return {
    crossConnectorRatio: memberSegments.length ? touched.size / memberSegments.length : 0,
    supportRailCount,
  };
}

function nativeRoleFor(family, segments, trustedProvenanceGroups) {
  const members = new Set(family.memberIds);
  const memberSegments = segments.filter((segment) => members.has(segment.id));
  if (!memberSegments.length || !(trustedProvenanceGroups instanceof Set)) return null;
  const native = memberSegments.map((segment) => segment.native);
  if (native.some((value) => !value || !trustedProvenanceGroups.has(value.groupId))) return null;
  const groupIds = new Set(native.map((value) => value.groupId));
  const roles = new Set(native.map((value) => value.role));
  const kinds = new Set(native.map((value) => value.kind));
  if (groupIds.size !== 1 || kinds.size !== 1 || roles.size !== 1) return "mixed";
  const role = [...roles][0];
  if (role === "pattern-stroke") return "hatch";
  if (role === "boundary" || role === "clip-path") return "boundary";
  return null;
}

function sameMembers(left, right) {
  const leftSet = new Set(left.memberIds);
  let common = 0;
  for (const id of right.memberIds) if (leftSet.has(id)) common += 1;
  return common / Math.max(left.memberIds.length, right.memberIds.length) >= 0.8;
}

export function proposeLineFamilies(inputSegments, options = {}) {
  const configuration = { ...DEFAULTS, ...options };
  const segments = validateSegments(inputSegments);
  const coordinateScale = options.coordinateScale || sheetCoordinateScale(segments);
  const proposals = [];
  for (const group of candidateGroups(segments, configuration)) {
    const fit = fitNormalOffsetLattice(group, { ...configuration, coordinateScale });
    if (!fit) continue;
    const connectors = connectorEvidence(fit, segments);
    const proposal = Object.freeze({
      ...fit,
      memberIds: Object.freeze([...fit.memberIds]),
      ...connectors,
    });
    const nativeRole = nativeRoleFor(fit, segments, options.trustedProvenanceGroups);
    if (nativeRole) trustedNativeRoles.set(proposal, nativeRole);
    const duplicate = proposals.findIndex((existing) => sameMembers(existing, proposal));
    if (duplicate < 0) proposals.push(proposal);
    else if (proposal.score > proposals[duplicate].score) proposals[duplicate] = proposal;
  }
  return proposals.sort((left, right) => right.score - left.score);
}

export function analyzeLineFamilies(inputSegments, options = {}) {
  const segments = validateSegments(inputSegments);
  const proposals = proposeLineFamilies(segments, options);
  const assigned = new Set(proposals.flatMap((proposal) => proposal.memberIds));
  return {
    proposals,
    unassignedIds: segments.filter((segment) => !assigned.has(segment.id)).map((segment) => segment.id),
  };
}

export function classifyLineFamily(family, context = {}, options = {}) {
  if (!family) throw new Error("family is required");
  const configuration = { ...DEFAULTS, ...options };
  const reasons = [];

  const nativeRole = trustedNativeRoles.get(family);
  if (nativeRole === "hatch") {
    return { label: "hatch", confidence: 1, testable: true, reasons: ["native-hatch-provenance"] };
  }
  if (nativeRole === "boundary") {
    return { label: "repeated-building-element", confidence: 1, testable: false, reasons: ["native-boundary-provenance"] };
  }
  const repeatedBuildingKinds = new Set(["stairs", "shelving", "louvre", "partition-bank"]);
  if (context.protectedKind && repeatedBuildingKinds.has(context.protectedKind)) {
    return {
      label: "repeated-building-element",
      confidence: 0.95,
      testable: false,
      reasons: [`protected-context:${context.protectedKind}`],
    };
  }
  if (context.protectedKind) {
    return {
      label: "uncertain",
      confidence: 0.9,
      testable: false,
      reasons: [`protected-context:${context.protectedKind}`],
    };
  }
  if (
    family.supportRailCount >= 2 && family.supportRailCount <= 3 &&
    family.crossConnectorRatio >= 0.7
  ) {
    return {
      label: "repeated-building-element",
      confidence: 0.85,
      testable: false,
      reasons: ["paired-support-rails", "cross-connected-family"],
    };
  }

  const strongLattice = family.inlierRate >= configuration.minInlierRate
    && family.occupancy >= configuration.minOccupancy
    && family.rowCount >= configuration.minRows;
  if (strongLattice) reasons.push("strong-normal-offset-lattice");
  const trustedEvidenceIds = options.trustedEvidenceIds instanceof Set
    ? options.trustedEvidenceIds
    : new Set();
  const hasSharedClip = context.sharedClipEvidenceId
    && trustedEvidenceIds.has(context.sharedClipEvidenceId);
  const hasRegionFill = context.regionFillEvidenceId
    && trustedEvidenceIds.has(context.regionFillEvidenceId);
  if (hasSharedClip) reasons.push("trusted-shared-clip-evidence");
  if (hasRegionFill) reasons.push("trusted-region-fill-evidence");
  if (family.crossConnectorRatio > configuration.maxCrossConnectorRatio) {
    reasons.push("cross-connected-family");
  }

  if (family.supportRailCount >= 4) {
    return {
      label: "uncertain",
      confidence: 0.8,
      testable: false,
      reasons: [...reasons, "orthogonal-grid-ambiguity"],
    };
  }

  if (
    strongLattice && (hasSharedClip || hasRegionFill) &&
    family.crossConnectorRatio <= configuration.maxCrossConnectorRatio
  ) {
    return { label: "hatch", confidence: 0.9, testable: true, reasons };
  }
  return {
    label: "uncertain",
    confidence: strongLattice ? 0.65 : 0.35,
    testable: false,
    reasons: reasons.length ? reasons : ["insufficient-family-evidence"],
  };
}

const GATE_DEFAULTS = Object.freeze({
  minDecisionConfidence: 0.6,
  maxAreaGrowth: 3,
  minWallEdgeFraction: 0.6,
  maxWallEdgeDrop: 0.05,
  maxProtectedOverlap: 0,
  maxErrorIncrease: 0,
});

function validateGatePolicy(policy) {
  for (const name of ["minDecisionConfidence", "minWallEdgeFraction", "maxWallEdgeDrop"]) {
    if (!Number.isFinite(policy[name]) || policy[name] < 0 || policy[name] > 1) {
      throw new Error(`${name} must be between 0 and 1`);
    }
  }
  if (!Number.isFinite(policy.maxAreaGrowth) || policy.maxAreaGrowth < 1) {
    throw new Error("maxAreaGrowth must be at least 1");
  }
  for (const name of ["maxProtectedOverlap", "maxErrorIncrease"]) {
    if (!Number.isFinite(policy[name]) || policy[name] < 0) {
      throw new Error(`${name} must be non-negative`);
    }
  }
}

function missingRunMetrics(run, prefix) {
  const failures = [];
  for (const name of [
    "area",
    "wallEdgeFraction",
    "coverage",
    "perimeterOnPreservedWall",
    "invalidPolygonCount",
    "protectedOverlap",
    "errorCount",
  ]) {
    if (!Number.isFinite(run[name])) failures.push(`${prefix}-missing-${name}`);
  }
  for (const name of ["assignedSeedIds", "trappedSeedIds"]) {
    if (!Array.isArray(run[name])) failures.push(`${prefix}-missing-${name}`);
  }
  if (!run.roomBySeed || typeof run.roomBySeed !== "object" || Array.isArray(run.roomBySeed)) {
    failures.push(`${prefix}-missing-roomBySeed`);
  }
  if (typeof run.exteriorLeak !== "boolean") failures.push(`${prefix}-missing-exteriorLeak`);
  return failures;
}

function invalidRunMetrics(run, prefix) {
  const failures = [];
  if (typeof run.status !== "string" || run.status.length === 0) {
    failures.push(`${prefix}-invalid-status`);
  }
  if (run.trapped !== undefined && typeof run.trapped !== "boolean") {
    failures.push(`${prefix}-invalid-trapped`);
  }
  for (const name of ["wallEdgeFraction", "coverage", "perimeterOnPreservedWall"]) {
    if (Number.isFinite(run[name]) && (run[name] < 0 || run[name] > 1)) {
      failures.push(`${prefix}-invalid-${name}`);
    }
  }
  for (const name of ["area", "invalidPolygonCount", "protectedOverlap", "errorCount"]) {
    if (Number.isFinite(run[name]) && run[name] < 0) failures.push(`${prefix}-invalid-${name}`);
  }
  for (const name of ["invalidPolygonCount", "errorCount"]) {
    if (Number.isFinite(run[name]) && !Number.isInteger(run[name])) {
      failures.push(`${prefix}-invalid-${name}`);
    }
  }
  if (Array.isArray(run.assignedSeedIds) && Array.isArray(run.trappedSeedIds)) {
    const assigned = new Set(run.assignedSeedIds);
    const trapped = new Set(run.trappedSeedIds);
    if (assigned.size !== run.assignedSeedIds.length) failures.push(`${prefix}-duplicate-assigned-seed`);
    if (trapped.size !== run.trappedSeedIds.length) failures.push(`${prefix}-duplicate-trapped-seed`);
    if ([...assigned].some((seedId) => trapped.has(seedId))) failures.push(`${prefix}-seed-both-assigned-and-trapped`);
    if (run.roomBySeed && typeof run.roomBySeed === "object") {
      for (const seedId of assigned) {
        if (run.roomBySeed[seedId] == null) failures.push(`${prefix}-assigned-seed-without-room`);
      }
    }
  }
  return failures;
}

function topologyRegressions(strict, retry) {
  const failures = [];
  const retryAssigned = new Set(retry.assignedSeedIds);
  const strictTrapped = new Set(strict.trappedSeedIds);
  const retryTrapped = new Set(retry.trappedSeedIds);
  for (const seedId of strict.assignedSeedIds) {
    if (!retryAssigned.has(seedId)) failures.push("assigned-seed-lost");
  }
  for (const seedId of strictTrapped) {
    if (
      !retryTrapped.has(seedId) &&
      (!retryAssigned.has(seedId) || retry.roomBySeed[seedId] == null)
    ) failures.push("trapped-seed-not-recovered");
  }
  for (const seedId of retryTrapped) {
    if (!strictTrapped.has(seedId)) failures.push("new-trapped-seed");
  }
  const strictToRetry = new Map();
  const retryToStrict = new Map();
  for (const seedId of strict.assignedSeedIds) {
    const strictRoom = strict.roomBySeed[seedId];
    const retryRoom = retry.roomBySeed[seedId];
    if (strictRoom == null || retryRoom == null) {
      failures.push("missing-room-mapping");
      continue;
    }
    const retryRooms = strictToRetry.get(strictRoom) || new Set();
    retryRooms.add(retryRoom);
    strictToRetry.set(strictRoom, retryRooms);
    const strictRooms = retryToStrict.get(retryRoom) || new Set();
    strictRooms.add(strictRoom);
    retryToStrict.set(retryRoom, strictRooms);
  }
  // A formerly trapped seed represents a room the strict result could not
  // recover. It may become assigned, but it may not share the retry room of
  // an already assigned strict room or another independently trapped seed.
  for (const seedId of strictTrapped) {
    if (!retryAssigned.has(seedId)) continue;
    const retryRoom = retry.roomBySeed[seedId];
    if (retryRoom == null) continue;
    const owners = retryToStrict.get(retryRoom) || new Set();
    owners.add(`trapped:${seedId}`);
    retryToStrict.set(retryRoom, owners);
  }
  if ([...strictToRetry.values()].some((rooms) => rooms.size !== 1)) failures.push("room-split");
  if ([...retryToStrict.values()].some((rooms) => rooms.size > 1)) failures.push("room-merge");
  return [...new Set(failures)];
}

export function gateTransparentRetry(input, options = {}) {
  const { decision, strict, retry = null } = input || {};
  if (!decision || !strict) throw new Error("decision and strict result are required");
  const policy = { ...GATE_DEFAULTS, ...options };
  validateGatePolicy(policy);
  const eligibleLabel = decision.label === "hatch" && decision.testable;
  const validConfidence = Number.isFinite(decision.confidence)
    && decision.confidence >= 0 && decision.confidence <= 1;
  if (!eligibleLabel || !validConfidence || decision.confidence < policy.minDecisionConfidence) {
    return { action: "keep-strict", selected: strict, strict, retry, reasons: ["family-not-eligible"] };
  }
  if (!strict.trapped && !["tiny", "fragmented", "trapped"].includes(strict.status)) {
    return { action: "keep-strict", selected: strict, strict, retry, reasons: ["strict-result-not-trapped"] };
  }
  if (!retry) {
    return { action: "run-transparent-retry", selected: strict, strict, retry, reasons: ["eligible-trapped-result"] };
  }

  const failures = [
    ...missingRunMetrics(strict, "strict"),
    ...missingRunMetrics(retry, "retry"),
    ...invalidRunMetrics(strict, "strict"),
    ...invalidRunMetrics(retry, "retry"),
  ];
  if (failures.length) {
    return { action: "keep-strict", selected: strict, strict, retry, reasons: failures };
  }
  if (retry.status !== "ok" || retry.exteriorLeak) failures.push("retry-not-bounded");
  if (retry.invalidPolygonCount > 0) failures.push("invalid-retry-polygons");
  const strictArea = strict.area;
  const retryArea = retry.area;
  const growth = strictArea > 0 ? retryArea / strictArea : Infinity;
  if (retryArea <= 0 || retryArea < strictArea) failures.push("area-regression");
  if (growth > policy.maxAreaGrowth) failures.push("area-growth-budget");
  const strictWall = strict.wallEdgeFraction;
  const retryWall = retry.wallEdgeFraction;
  if (retryWall < policy.minWallEdgeFraction) failures.push("wall-edge-floor");
  if (retryWall < strictWall - policy.maxWallEdgeDrop) failures.push("wall-edge-regression");
  if (retry.perimeterOnPreservedWall < strict.perimeterOnPreservedWall - policy.maxWallEdgeDrop) {
    failures.push("preserved-wall-regression");
  }
  if (retry.coverage < strict.coverage) failures.push("coverage-regression");
  if (retry.protectedOverlap > policy.maxProtectedOverlap) {
    failures.push("protected-class-overlap");
  }
  const strictErrors = strict.errorCount;
  const retryErrors = retry.errorCount;
  if (retryErrors > strictErrors + policy.maxErrorIncrease) failures.push("downstream-error-regression");
  if (retry.trappedSeedIds.length >= strict.trappedSeedIds.length) failures.push("trapped-seeds-not-improved");
  failures.push(...topologyRegressions(strict, retry));

  if (failures.length) {
    return {
      action: "keep-strict",
      selected: strict,
      strict,
      retry,
      reasons: [...new Set(failures)],
      areaGrowth: growth,
    };
  }
  return {
    action: "accept-transparent-retry",
    selected: retry,
    strict,
    retry,
    reasons: ["retry-within-budgets"],
    areaGrowth: growth,
  };
}
