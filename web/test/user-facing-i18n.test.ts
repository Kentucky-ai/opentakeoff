import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

// ── helpers ─────────────────────────────────────────────────────────────────

/** Recursively collect all dot-separated keys from a nested JSON object. */
function collectKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out.push(...collectKeys(v as Record<string, unknown>, full));
    } else {
      out.push(full);
    }
  }
  return out;
}

/** Load a locale JSON file. */
function loadJson(locale: string, ns: string): Record<string, unknown> {
  const p = path.join(root, "public", "locales", locale, `${ns}.json`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/** Get a nested value from a locale object by dot-separated key path. */
function getVal(obj: Record<string, unknown>, dotPath: string): unknown {
  if (Object.prototype.hasOwnProperty.call(obj, dotPath)) return obj[dotPath];
  return dotPath.split(".").reduce<unknown>((acc, seg) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[seg];
    return undefined;
  }, obj);
}

// ── 1. Preserved: message sinks do not contain direct English literals ──────

const userFacingFiles = [
  "src/pages/TakeoffCanvas.jsx",
  "src/components/ReportPanel.jsx",
  "src/components/RollPanel.jsx",
  "src/components/TakeoffsPanel.jsx",
  "src/main.jsx",
  "src/lib/markedset.js",
  "src/lib/revisions.js",
  "src/lib/rfi.js",
  "src/lib/totals.js",
  "src/lib/xlsx.js",
];

test("user-facing message sinks do not contain direct English literals", () => {
  const violations: string[] = [];
  for (const relative of userFacingFiles) {
    const source = fs.readFileSync(path.join(root, relative), "utf8");
    for (const [index, line] of source.split("\n").entries()) {
      if (/setCommitMsg\((?:["'`])[^"'`]+|window\.prompt\((?:["'`])[^"'`]+/.test(line)) {
        violations.push(`${relative}:${index + 1}:${line.trim()}`);
      }
    }
  }
  assert.deepEqual(violations, [], `hardcoded user-facing messages:\n${violations.join("\n")}`);
});

// ── 2. ReportPanel: COL_HINTS must use t(...) for hint rendering ────────────

test("ReportPanel COL_HINTS uses t(...) for hint rendering, not hardcoded English", () => {
  const src = fs.readFileSync(
    path.join(root, "src/components/ReportPanel.jsx"),
    "utf8",
  );

  // --- contract A: COL_HINTS object must not contain raw English strings ---
  assert.doesNotMatch(
    src,
    /COL_HINTS\s*=\s*\{[^}]*Waste SF\/LF/,
    "COL_HINTS must not contain hardcoded 'Waste SF/LF'; use t('hints.waste_lf')",
  );
  assert.doesNotMatch(
    src,
    /COL_HINTS\s*=\s*\{[^}]*Perimeter is reference/,
    "COL_HINTS must not contain hardcoded 'Perimeter is reference'; use t('hints.perimeter_ref')",
  );

  // --- contract B: rendering must call t() for hint text ---
  assert.match(
    src,
    /t\(\s*['"]hints\.waste_lf['"]\s*,/,
    "ReportPanel must call t('hints.waste_lf') for the waste-lf column hint",
  );
  assert.match(
    src,
    /t\(\s*['"]hints\.perimeter_ref['"]\s*\)/,
    "ReportPanel must call t('hints.perimeter_ref') for the perimeter-ref column hint",
  );
});

// ── 3. Six required canvas keys must be non-empty in both locales ───────────

const REQUIRED_CANVAS_KEYS = [
  "menu.import_takeoff",     // import-from-schedule menu item
  "conditions.strip",        // compact strip-mode toggle label
  "toolbar.scale",           // scale cluster label on toolbar
  "markup.delete_markup",    // markup panel delete action title
  "markup.editor_placeholder", // inline text-editor placeholder
  "markup.select",           // markup condition-link "Select" button
  "markup.detach",           // markup condition-link "Detach" button
  "readout.set_wall_height", // wall-height clear-button title
  "confirm.its",             // possessive pronoun in split-family confirm dialog
];

test("nine required canvas keys exist and are non-empty in en and pt-br", () => {
  const en = loadJson("en", "canvas") as Record<string, unknown>;
  const pt = loadJson("pt-br", "canvas") as Record<string, unknown>;
  const missing: string[] = [];

  for (const key of REQUIRED_CANVAS_KEYS) {
    const enVal = getVal(en, key);
    const ptVal = getVal(pt, key);
    if (!enVal || typeof enVal !== "string" || !enVal.trim()) {
      missing.push(`en canvas.json: "${key}" missing or empty`);
    }
    if (!ptVal || typeof ptVal !== "string" || !ptVal.trim()) {
      missing.push(`pt-br canvas.json: "${key}" missing or empty`);
    }
  }

  assert.deepEqual(missing, [], `required canvas locale keys:\n${missing.join("\n")}`);
});

// ── 4. Report locale: empty-state, Optional, total, waste/perimeter, theme ──

test("report locale covers empty-state, Optional, total, waste/perimeter hints, and theme import", () => {
  const en = loadJson("en", "report") as Record<string, unknown>;
  const pt = loadJson("pt-br", "report") as Record<string, unknown>;

  const contracts: Array<[string, string]> = [
    ["empty",              "report empty-state ('Nothing measured yet')"],
    ["columns.optional",   "column picker 'Optional' section divider"],
    ["total",              "footer 'Total' label"],
    ["hints.waste_lf",     "column hint for waste-lf"],
    ["hints.perimeter_ref","column hint for perimeter-ref"],
    ["theme.import_btn",   "theme section import button label"],
    ["theme.import_title", "theme import file-picker title"],
  ];

  const missing: string[] = [];
  for (const [key, desc] of contracts) {
    const enVal = getVal(en, key);
    const ptVal = getVal(pt, key);
    if (!enVal || typeof enVal !== "string" || !enVal.trim()) {
      missing.push(`en: ${desc} — key "${key}" missing or empty`);
    }
    if (!ptVal || typeof ptVal !== "string" || !ptVal.trim()) {
      missing.push(`pt-br: ${desc} — key "${key}" missing or empty`);
    }
  }

  assert.deepEqual(missing, [], `report locale contracts:\n${missing.join("\n")}`);
});

// ── 5. Canvas locale: compact tool labels and status strings ────────────────

test("canvas locale has compact tool labels and status strings in both locales", () => {
  const en = loadJson("en", "canvas") as Record<string, unknown>;
  const pt = loadJson("pt-br", "canvas") as Record<string, unknown>;

  const contracts: Array<[string, string]> = [
    ["tool.area",    "tool label 'Area'"],
    ["tool.linear",  "tool label 'Linear'"],
    ["tool.surface", "tool label 'Surface Area'"],
    ["tool.count",   "tool label 'Count'"],
    ["status.empty", "status bar empty-state message"],
    ["markup.empty", "annotation panel empty-state message"],
  ];

  const missing: string[] = [];
  for (const [key, desc] of contracts) {
    const enVal = getVal(en, key);
    const ptVal = getVal(pt, key);
    if (!enVal || typeof enVal !== "string" || !enVal.trim()) {
      missing.push(`en: ${desc} — key "${key}" missing or empty`);
    }
    if (!ptVal || typeof ptVal !== "string" || !ptVal.trim()) {
      missing.push(`pt-br: ${desc} — key "${key}" missing or empty`);
    }
  }

  assert.deepEqual(missing, [], `canvas locale contracts:\n${missing.join("\n")}`);
});

// ── 5b. Panels locale: built-in stamp names and set name ───────────────────

test("panels locale has built-in stamp and set names in both locales", () => {
  const en = loadJson("en", "panels") as Record<string, unknown>;
  const pt = loadJson("pt-br", "panels") as Record<string, unknown>;

  const contracts: Array<[string, string]> = [
    ["stamp.stmp_direction", "built-in stamp: plank/tile direction"],
    ["stamp.stmp_seam",      "built-in stamp: seam direction"],
    ["stamp.stmp_origin",    "built-in stamp: pattern origin"],
    ["stamp.set_flooring",   "built-in stamp set: flooring shop drawings"],
  ];

  const missing: string[] = [];
  for (const [key, desc] of contracts) {
    const enVal = getVal(en, key);
    const ptVal = getVal(pt, key);
    if (!enVal || typeof enVal !== "string" || !enVal.trim()) {
      missing.push(`en: ${desc} — key "${key}" missing or empty`);
    }
    if (!ptVal || typeof ptVal !== "string" || !ptVal.trim()) {
      missing.push(`pt-br: ${desc} — key "${key}" missing or empty`);
    }
  }

  assert.deepEqual(missing, [], `panels stamp locale contracts:\n${missing.join("\n")}`);
});

// ── 5c. Markup pick_tool and check.same_point use dangerouslySetInnerHTML ──

test("markup.pick_tool and check.same_point use dangerouslySetInnerHTML for <b> tags", () => {
  const canvas = fs.readFileSync(
    path.join(root, "src/pages/TakeoffCanvas.jsx"),
    "utf8",
  );

  // markup.pick_tool contains <b> tags — must use dangerouslySetInnerHTML
  assert.match(
    canvas,
    /dangerouslySetInnerHTML\s*=\s*\{\s*\{\s*__html:\s*t\(\s*['"]markup\.pick_tool['"]/,
    "markup.pick_tool must render via dangerouslySetInnerHTML (locale value contains <b> tags)",
  );

  // check.same_point contains <b> tags — must use dangerouslySetInnerHTML
  assert.match(
    canvas,
    /dangerouslySetInnerHTML\s*=\s*\{\s*\{\s*__html:\s*t\(\s*['"]check\.same_point['"]/,
    "check.same_point must render via dangerouslySetInnerHTML (locale value contains <b> tags)",
  );
});

// ── 5d. StampPanel localizes built-in stamp names via shared helper ─────────

test("stamps.js exports shared BUILT_IN_STAMP_IDS and stampDisplayName helper", () => {
  const stamps = fs.readFileSync(
    path.join(root, "src/lib/stamps.js"),
    "utf8",
  );

  // BUILT_IN_STAMP_IDS must map each built-in ID to its i18n key
  assert.match(
    stamps,
    /BUILT_IN_STAMP_IDS/,
    "stamps.js must export BUILT_IN_STAMP_IDS map",
  );
  // stampDisplayName must be an exported function
  assert.match(
    stamps,
    /export\s+function\s+stampDisplayName/,
    "stamps.js must export stampDisplayName function",
  );
});

test("StampPanel imports and uses stampDisplayName for localized stamp labels", () => {
  const panelSrc = fs.readFileSync(
    path.join(root, "src/components/StampPanel.jsx"),
    "utf8",
  );

  // Must import stampDisplayName from stamps.js
  assert.match(
    panelSrc,
    /import\s*\{[^}]*stampDisplayName[^}]*\}\s*from\s*["'][^"']*stamps\.js["']/,
    "StampPanel must import stampDisplayName from stamps.js",
  );
  // Must use stampDisplayName(s, t) for display — not raw s.name
  assert.match(
    panelSrc,
    /stampDisplayName\(\s*s\s*,\s*t\s*\)/,
    "StampPanel must call stampDisplayName(s, t) for stamp display names",
  );
  // Must use displayName, not s.name, for the visible stamp label
  assert.match(
    panelSrc,
    /displayName/,
    "StampPanel must use a localized displayName for stamp labels",
  );
});

// ── 6. en/pt-br parity: same key set across every namespace ─────────────────

const LOCALE_NAMESPACES = ["canvas", "report", "panels", "guide", "lib"];

test("en and pt-br locale files have the same key set (namespace parity)", () => {
  const diffs: string[] = [];

  for (const ns of LOCALE_NAMESPACES) {
    const enKeys = new Set(collectKeys(loadJson("en", ns) as Record<string, unknown>));
    const ptKeys = new Set(collectKeys(loadJson("pt-br", ns) as Record<string, unknown>));

    for (const k of enKeys) {
      if (!ptKeys.has(k)) diffs.push(`${ns}.json: pt-br missing "${k}"`);
    }
    for (const k of ptKeys) {
      if (!enKeys.has(k)) diffs.push(`${ns}.json: en missing "${k}" (in pt-br only)`);
    }
  }

  assert.deepEqual(diffs, [], `en/pt-br locale key mismatch:\n${diffs.join("\n")}`);
});
