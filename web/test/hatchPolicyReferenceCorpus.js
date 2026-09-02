function segment(id, x1, y1, x2, y2, extra = {}) {
  return { id, x1, y1, x2, y2, strokeWidth: 1, ...extra };
}

function verticalFamily(prefix, xs, y1, y2, extra = {}) {
  return xs.map((x, index) => segment(`${prefix}-${index}`, x, y1, x, y2, extra));
}

function horizontalFamily(prefix, ys, x1, x2, extra = {}) {
  return ys.map((y, index) => segment(`${prefix}-${index}`, x1, y, x2, y, extra));
}

function clippedBoundary(x1, y1, x2, y2) {
  return [
    segment("clip-top", x1, y1, x2, y1, { strokeWidth: 2, contextRole: "clip-boundary" }),
    segment("clip-bottom", x1, y2, x2, y2, { strokeWidth: 2, contextRole: "clip-boundary" }),
  ];
}

const regular = [10, 20, 30, 40, 50, 60, 70];

export const familyCases = [
  {
    name: "native-hatch",
    segments: verticalFamily("hatch", regular, 0, 100, {
      native: { groupId: "native-hatch-1", kind: "dxf-hatch", role: "pattern-stroke" },
    }),
    context: {},
    options: { trustedProvenanceGroups: new Set(["native-hatch-1"]) },
    expectedLabel: "hatch",
  },
  {
    name: "flattened-hatch-with-clip",
    segments: [
      ...verticalFamily("hatch", regular, 0, 100),
      ...clippedBoundary(0, 0, 80, 100),
    ],
    context: { sharedClipEvidenceId: "clip-1" },
    options: { trustedEvidenceIds: new Set(["clip-1"]) },
    expectedLabel: "hatch",
  },
  {
    name: "split-row-carpet-with-fill-evidence",
    segments: regular.flatMap((x, row) => [
      segment(`dash-${row}-a`, x, 0, x, 42),
      segment(`dash-${row}-b`, x, 58, x, 100),
    ]),
    context: { regionFillEvidenceId: "fill-1" },
    options: { trustedEvidenceIds: new Set(["fill-1"]) },
    expectedLabel: "hatch",
  },
  {
    name: "stair-treads",
    segments: [
      ...horizontalFamily("tread", regular, 0, 50),
      segment("stringer-left", 0, 0, 0, 80, { contextRole: "structure" }),
      segment("stringer-right", 50, 0, 50, 80, { contextRole: "structure" }),
    ],
    context: {},
    expectedLabel: "repeated-building-element",
  },
  {
    name: "dimension-ticks",
    segments: [
      ...verticalFamily("tick", regular, 0, 12),
      segment("dimension-line", 0, 6, 80, 6, { contextRole: "structure" }),
    ],
    context: { protectedKind: "dimension" },
    expectedLabel: "uncertain",
  },
  {
    name: "ceiling-grid-without-provenance",
    segments: [
      ...verticalFamily("grid-v", regular, 0, 80),
      ...horizontalFamily("grid-h", regular, 0, 80),
    ],
    context: {},
    expectedLabel: "uncertain",
  },
  {
    name: "same-pen-partition-bank",
    segments: [
      ...verticalFamily("partition", regular, 0, 100),
      segment("bank-top", 0, 0, 80, 0, { strokeWidth: 2, contextRole: "structure" }),
      segment("bank-bottom", 0, 100, 80, 100, { strokeWidth: 2, contextRole: "structure" }),
    ],
    context: {},
    expectedLabel: "repeated-building-element",
  },
  {
    name: "irregular-parallels",
    segments: verticalFamily("irregular", [10, 18, 31, 47, 68, 91, 119], 0, 100),
    context: {},
    expectedLabel: null,
  },
];

const strictRun = {
  status: "trapped",
  trapped: true,
  area: 40,
  wallEdgeFraction: 0.72,
  coverage: 0.4,
  perimeterOnPreservedWall: 0.72,
  invalidPolygonCount: 0,
  protectedOverlap: 0,
  errorCount: 0,
  exteriorLeak: false,
  assignedSeedIds: ["room-a"],
  trappedSeedIds: ["room-b"],
  roomBySeed: { "room-a": "strict-a", "room-b": null },
};

const safeRetry = {
  status: "ok",
  area: 92,
  wallEdgeFraction: 0.76,
  coverage: 0.9,
  perimeterOnPreservedWall: 0.76,
  invalidPolygonCount: 0,
  protectedOverlap: 0,
  errorCount: 0,
  exteriorLeak: false,
  assignedSeedIds: ["room-a", "room-b"],
  trappedSeedIds: [],
  roomBySeed: { "room-a": "retry-a", "room-b": "retry-b" },
};

export const gateCases = [
  {
    name: "safe-recovery",
    decision: { label: "hatch", confidence: 0.9, testable: true },
    strict: { ...strictRun },
    retry: { ...safeRetry },
    expectedAction: "accept-transparent-retry",
  },
  {
    name: "eligible-hatch-family-can-be-probed",
    decision: { label: "hatch", confidence: 0.8, testable: true },
    strict: { ...strictRun },
    retry: null,
    expectedAction: "run-transparent-retry",
  },
  {
    name: "wall-edge-regression-keeps-strict",
    decision: { label: "hatch", confidence: 0.8, testable: true },
    strict: { ...strictRun, wallEdgeFraction: 0.8, perimeterOnPreservedWall: 0.8 },
    retry: { ...safeRetry, wallEdgeFraction: 0.61, perimeterOnPreservedWall: 0.61 },
    expectedAction: "keep-strict",
  },
  {
    name: "protected-class-overlap-keeps-strict",
    decision: { label: "hatch", confidence: 0.9, testable: true },
    strict: { ...strictRun },
    retry: { ...safeRetry, protectedOverlap: 1 },
    expectedAction: "keep-strict",
  },
  {
    name: "known-building-element-never-retries",
    decision: { label: "repeated-building-element", confidence: 0.95, testable: false },
    strict: { ...strictRun },
    retry: null,
    expectedAction: "keep-strict",
  },
];
