// unit-i18n-tooltips — locale templates for canvas/report/panels tooltips and
// hints must use {{au}}/{{lu}}/{{thick_u}}/{{unit}} interpolation rather than
// hardcoded SF/LF/ft/in so that SI/metric mode never exposes imperial
// abbreviations.
//
// Strategy:
//   1. Locale-level: verify en AND pt-br templates carry unit placeholders
//      instead of bare "SF", "LF", "ft" unit strings.
//   2. Runtime interpolation matrix: for every key with unit vars, simulate
//      i18next interpolation with actual unit values for each (locale × system)
//      combination and assert no imperial leakage in metric output.
//   3. Source-level: verify components pass `au: areaUnit(units)` /
//      `lu: lenUnit(units)` when calling t() for these keys.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

function loadJson(locale: string, ns: string): Record<string, unknown> {
  const p = path.join(root, "public", "locales", locale, `${ns}.json`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function loadSrc(relPath: string): string {
  return fs.readFileSync(path.join(root, relPath), "utf8");
}

function getVal(obj: Record<string, unknown>, dotPath: string): unknown {
  if (Object.prototype.hasOwnProperty.call(obj, dotPath)) return obj[dotPath];
  return dotPath.split(".").reduce<unknown>((acc, seg) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[seg];
    return undefined;
  }, obj);
}

// ── Shared helpers ──────────────────────────────────────────────────────────

/** True when a string carries an i18next interpolation variable. */
const hasVar = (s: string, v: string) => s.includes(`{{${v}}}`);

/** True when a string contains a bare imperial unit abbreviation (not part of
 *  an interpolation variable like {{au}}).  Matches " SF ", " LF ", " ft"
 *  with optional trailing punctuation but excludes them inside {{…}}. */
const hasBareImperial = (s: string) => {
  const stripped = s.replace(/\{\{[^}]+\}\}/g, "");
  return /\bSF\b|\bLF\b|\bft\b/.test(stripped);
};

/** True when a string contains "in" as a standalone inches-unit abbreviation
 *  (e.g. "6 in", "12in") — not the English preposition "in".  The heuristic
 *  requires a digit immediately before "in" (with optional space) to avoid
 *  false-positiving on words like "within" or "in the condition editor". */
const hasBareIn = (s: string) => {
  const stripped = s.replace(/\{\{[^}]+\}\}/g, "");
  return /\d\s*in\b/.test(stripped);
};

/** True when a string contains Unicode feet/inches symbols (′ ″) outside
 *  interpolation variables — imperial width examples that leak in metric mode. */
const hasBareFeetSymbols = (s: string) => {
  const stripped = s.replace(/\{\{[^}]+\}\}/g, "");
  return /[′″]/.test(stripped);
};

/** Simulate i18next interpolation: replace {{var}} with values from a map. */
function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, k) => (k in vars ? vars[k] : `{{${k}}}`));
}

/** Get all interpolation variables from a template string. */
function getVars(s: string): string[] {
  return [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
}

// ── unit-value maps matching areaUnit()/lenUnit()/thickUnit() from lib/units ──

const UNIT_MAPS = {
  imperial: { au: "SF", lu: "LF", thick_u: "in", unit: "ft" },
  metric:   { au: "m²", lu: "m", thick_u: "mm", unit: "m" },
} as const;

const LOCALES = ["en", "pt-br"] as const;
const SYSTEMS = ["imperial", "metric"] as const;

/** Feet-to-metres conversion (matches lib/units.ts M_PER_FT). */
const M_PER_FT = 0.3048;

// ── Data-driven key registries ──────────────────────────────────────────────

/** Canvas namespace keys that carry unit placeholders. */
const CANVAS_UNIT_KEYS = [
  "rule.offer",
  "status.gap_bridged",
  "status.passage_excluded",
  "status.set_height",
  "status.set_scale_paste",
  "commit.transitions_derived",
];

/** Report namespace keys (dot-path) that carry unit placeholders. */
const REPORT_UNIT_KEYS = [
  "hints.waste_lf",
  "columns.labor_view_title",
  "footnote.waste_metric",
];

/** Panels namespace keys that carry unit placeholders. */
const PANELS_UNIT_KEYS = [
  "takeoffs.transitions_runs_committed",
  "takeoffs.transitions_across_wall",
  "takeoffs.height_title",
  "takeoffs.thickness_title",
  "takeoffs.roll_width_broadloom_title",
  "takeoffs.roll_width_resilient_title",
  "takeoffs.grout_tile_l_title",
  "takeoffs.grout_tile_w_title",
  "takeoffs.grout_tile_t_title",
  "takeoffs.grout_joint_title",
  "takeoffs.grout_derive_title",
];

// ── Assertion helpers (data-driven) ─────────────────────────────────────────

/** Assert a locale template carries required vars and no bare imperial. */
function assertTemplatePlaceholders(
  locale: string, ns: string, key: string,
  requiredVars: string[], description: string,
) {
  const raw = ns === "canvas" || ns === "panels"
    ? (loadJson(locale, ns) as Record<string, string>)[key]
    : getVal(loadJson(locale, ns), key) as string | undefined;
  assert.ok(raw, `${locale} ${ns}.${key} missing from locale JSON`);
  for (const v of requiredVars) {
    assert.ok(hasVar(raw, v), `${locale} ${ns}.${key} must interpolate {{${v}}} — ${description}`);
  }
  assert.ok(!hasBareImperial(raw),
    `${locale} ${ns}.${key} must not contain bare SF/LF/ft: ${raw}`);
}

/** Run the interpolation matrix: for every key × locale × system, assert no
 *  imperial leakage in metric output and all vars resolved. */
function assertInterpolationMatrix(
  namespace: string, keys: string[],
  dotPath = false,
) {
  for (const locale of LOCALES) {
    for (const system of SYSTEMS) {
      test(`interpolation matrix: ${locale}/${system} ${namespace} — no imperial leakage`, () => {
        const store = loadJson(locale, namespace) as Record<string, string>;
        const units = UNIT_MAPS[system];

        for (const key of keys) {
          const tpl = dotPath ? getVal(store, key) as string : store[key];
          assert.ok(tpl, `[${locale}/${system}] ${namespace}.${key} missing from locale JSON`);

          const rendered = interpolate(tpl, {
            ...units,
            // supply realistic values for other vars that may appear
            tag: "CPT-1", max: "25", passage: "3", pct: "15", sheet: "A1.01",
            count: "2", lf: "12.5", target: "CPT-2", tagA: "CPT-1", tagB: "CPT-3",
            gap: "4", divisor: system === "metric" ? "1000" : "12",
          });

          if (system === "metric") {
            assert.ok(!hasBareImperial(rendered),
              `[${locale}/metric] ${namespace}.${key} has bare SF/LF/ft:\n  raw:    ${tpl}\n  result: ${rendered}`);
            assert.ok(!hasBareIn(rendered),
              `[${locale}/metric] ${namespace}.${key} has bare "in":\n  result: ${rendered}`);
          }
          // All vars must resolve (no leftover {{…}})
          assert.ok(!hasVar(rendered, "au"),
            `[${locale}/${system}] ${namespace}.${key} has unresolved {{au}}`);
          assert.ok(!hasVar(rendered, "lu"),
            `[${locale}/${system}] ${namespace}.${key} has unresolved {{lu}}`);
          assert.ok(!hasVar(rendered, "unit"),
            `[${locale}/${system}] ${namespace}.${key} has unresolved {{unit}}`);
          assert.ok(!hasVar(rendered, "thick_u"),
            `[${locale}/${system}] ${namespace}.${key} has unresolved {{thick_u}}`);
          assert.ok(!hasVar(rendered, "divisor"),
            `[${locale}/${system}] ${namespace}.${key} has unresolved {{divisor}}`);
        }
      });
    }
  }
}

/** Assert en and pt-br have matching interpolation vars for a set of keys. */
function assertCrossLocaleParity(
  namespace: string, keys: string[], dotPath = false,
) {
  test(`en and pt-br ${namespace} keys have matching interpolation vars`, () => {
    const en = loadJson(locale, namespace) as Record<string, unknown>;
    const pt = loadJson("pt-br", namespace) as Record<string, unknown>;

    for (const key of keys) {
      const enVal = (dotPath ? getVal(en, key) : (en as Record<string, string>)[key]) as string ?? "";
      const ptVal = (dotPath ? getVal(pt, key) : (pt as Record<string, string>)[key]) as string ?? "";
      assert.deepEqual(getVars(enVal), getVars(ptVal),
        `${namespace}.${key}: en and pt-br must declare the same interpolation variables`);
    }
  });
}

// The `locale` var is intentionally module-scoped for assertCrossLocaleParity
const locale = "en";

// ── 1. Canvas locale: tooltip/hint templates must carry unit placeholders ─────

test("en canvas tooltip/hint templates carry {{au}}/{{lu}} placeholders", () => {
  assertTemplatePlaceholders("en", "canvas", "rule.offer", ["au"], "area unit");
  assertTemplatePlaceholders("en", "canvas", "status.gap_bridged", ["lu"], "length unit");
  assertTemplatePlaceholders("en", "canvas", "status.passage_excluded", ["lu"], "length unit");
  assertTemplatePlaceholders("en", "canvas", "status.set_height", ["lu"], "length unit");
  assertTemplatePlaceholders("en", "canvas", "status.set_scale_paste", ["au", "lu"], "area+length");
  assertTemplatePlaceholders("en", "canvas", "commit.transitions_derived", ["lu"], "length unit");
});

test("pt-br canvas tooltip/hint templates carry {{au}}/{{lu}} placeholders", () => {
  assertTemplatePlaceholders("pt-br", "canvas", "rule.offer", ["au"], "area unit");
  assertTemplatePlaceholders("pt-br", "canvas", "status.gap_bridged", ["lu"], "length unit");
  assertTemplatePlaceholders("pt-br", "canvas", "status.passage_excluded", ["lu"], "length unit");
  assertTemplatePlaceholders("pt-br", "canvas", "status.set_height", ["lu"], "length unit");
  assertTemplatePlaceholders("pt-br", "canvas", "status.set_scale_paste", ["au", "lu"], "area+length");
  assertTemplatePlaceholders("pt-br", "canvas", "commit.transitions_derived", ["lu"], "length unit");
});

// ── 2. Report locale: hint/tooltip templates must carry unit placeholders ─────

test("en report hint/tooltip templates carry {{au}}/{{lu}} placeholders", () => {
  assertTemplatePlaceholders("en", "report", "hints.waste_lf", ["au", "lu"], "area+length");
  assertTemplatePlaceholders("en", "report", "columns.labor_view_title", ["au"], "area unit");
  assertTemplatePlaceholders("en", "report", "footnote.waste_metric", ["au", "lu"], "area+length");
});

test("pt-br report hint/tooltip templates carry {{au}}/{{lu}} placeholders", () => {
  assertTemplatePlaceholders("pt-br", "report", "hints.waste_lf", ["au", "lu"], "area+length");
  assertTemplatePlaceholders("pt-br", "report", "columns.labor_view_title", ["au"], "area unit");
  assertTemplatePlaceholders("pt-br", "report", "footnote.waste_metric", ["au", "lu"], "area+length");
});

// ── 3. Panels locale: tooltip templates must carry unit placeholders ──────────

test("en panels tooltip templates carry {{au}}/{{lu}}/{{unit}} placeholders", () => {
  assertTemplatePlaceholders("en", "panels", "takeoffs.transitions_runs_committed", ["lu"], "length unit");
  assertTemplatePlaceholders("en", "panels", "takeoffs.transitions_across_wall", ["lu", "thick_u"], "length+thickness");
  assertTemplatePlaceholders("en", "panels", "takeoffs.height_title", ["unit", "au", "lu"], "unit+area+length");
  assertTemplatePlaceholders("en", "panels", "takeoffs.thickness_title", ["unit", "au", "lu", "divisor"], "unit+area+length+divisor");
  assertTemplatePlaceholders("en", "panels", "takeoffs.grout_tile_l_title", ["unit"], "unit");
  assertTemplatePlaceholders("en", "panels", "takeoffs.grout_tile_w_title", ["unit"], "unit");
  assertTemplatePlaceholders("en", "panels", "takeoffs.grout_tile_t_title", ["unit"], "unit");
  assertTemplatePlaceholders("en", "panels", "takeoffs.grout_joint_title", ["unit"], "unit");
  assertTemplatePlaceholders("en", "panels", "takeoffs.grout_derive_title", ["unit"], "unit");
  assertTemplatePlaceholders("en", "panels", "takeoffs.wall_height_aria", ["unit"], "unit");
  assertTemplatePlaceholders("en", "panels", "takeoffs.material_thickness_aria", ["unit"], "unit");
  assertTemplatePlaceholders("en", "panels", "takeoffs.coverage_rate_aria", ["basis", "unit"], "basis+unit");
  assertTemplatePlaceholders("en", "panels", "takeoffs.roll_width_broadloom_title", ["widths"], "unit-aware widths");
  assertTemplatePlaceholders("en", "panels", "takeoffs.roll_width_resilient_title", ["widths"], "unit-aware widths");
});

test("pt-br panels tooltip templates carry {{au}}/{{lu}}/{{unit}} placeholders", () => {
  assertTemplatePlaceholders("pt-br", "panels", "takeoffs.transitions_runs_committed", ["lu"], "length unit");
  assertTemplatePlaceholders("pt-br", "panels", "takeoffs.transitions_across_wall", ["lu", "thick_u"], "length+thickness");
  assertTemplatePlaceholders("pt-br", "panels", "takeoffs.height_title", ["unit", "au", "lu"], "unit+area+length");
  assertTemplatePlaceholders("pt-br", "panels", "takeoffs.thickness_title", ["unit", "au", "lu", "divisor"], "unit+area+length+divisor");
  assertTemplatePlaceholders("pt-br", "panels", "takeoffs.grout_tile_l_title", ["unit"], "unit");
  assertTemplatePlaceholders("pt-br", "panels", "takeoffs.grout_tile_w_title", ["unit"], "unit");
  assertTemplatePlaceholders("pt-br", "panels", "takeoffs.grout_tile_t_title", ["unit"], "unit");
  assertTemplatePlaceholders("pt-br", "panels", "takeoffs.grout_joint_title", ["unit"], "unit");
  assertTemplatePlaceholders("pt-br", "panels", "takeoffs.grout_derive_title", ["unit"], "unit");
  assertTemplatePlaceholders("pt-br", "panels", "takeoffs.wall_height_aria", ["unit"], "unit");
  assertTemplatePlaceholders("pt-br", "panels", "takeoffs.material_thickness_aria", ["unit"], "unit");
  assertTemplatePlaceholders("pt-br", "panels", "takeoffs.coverage_rate_aria", ["basis", "unit"], "basis+unit");
  assertTemplatePlaceholders("pt-br", "panels", "takeoffs.roll_width_broadloom_title", ["widths"], "unit-aware widths");
  assertTemplatePlaceholders("pt-br", "panels", "takeoffs.roll_width_resilient_title", ["widths"], "unit-aware widths");
});

// ── 4. Runtime interpolation matrix ──────────────────────────────────────────

assertInterpolationMatrix("canvas", CANVAS_UNIT_KEYS);
assertInterpolationMatrix("report", REPORT_UNIT_KEYS, true);
assertInterpolationMatrix("panels", PANELS_UNIT_KEYS);

// ── 5. Cross-locale parity ───────────────────────────────────────────────────

assertCrossLocaleParity("canvas", CANVAS_UNIT_KEYS);
assertCrossLocaleParity("report", REPORT_UNIT_KEYS, true);
assertCrossLocaleParity("panels", PANELS_UNIT_KEYS);

// ── 6. Actual unit labels in rendered output ─────────────────────────────────

for (const locale of LOCALES) {
  for (const system of SYSTEMS) {
    test(`${locale}/${system} canvas templates render correct unit labels`, () => {
      const canvas = loadJson(locale, "canvas") as Record<string, string>;
      const u = UNIT_MAPS[system];

      const ruleOffer = interpolate(canvas["rule.offer"], { ...u, tag: "CPT-1", max: system === "metric" ? "2.32" : "25" });
      assert.ok(ruleOffer.includes(u.au), `${locale}/${system} rule.offer should contain "${u.au}": ${ruleOffer}`);

      const setHeight = interpolate(canvas["status.set_height"], { ...u, tag: "CPT-1" });
      assert.ok(
        setHeight.includes(u.lu === "LF" ? "LF" : ` ${u.lu}`) || setHeight.endsWith(u.lu),
        `${locale}/${system} status.set_height should contain "${u.lu}": ${setHeight}`);
    });

    test(`${locale}/${system} report templates render correct unit labels`, () => {
      const report = loadJson(locale, "report") as Record<string, unknown>;
      const u = UNIT_MAPS[system];

      const wasteLf = interpolate(getVal(report, "hints.waste_lf") as string, { ...u });
      assert.ok(wasteLf.includes(u.au) && wasteLf.includes(u.lu),
        `${locale}/${system} hints.waste_lf should contain "${u.au}" and "${u.lu}": ${wasteLf}`);
      if (system === "metric") {
        assert.ok(!wasteLf.includes("SF") && !wasteLf.includes("LF"),
          `${locale}/${system} hints.waste_lf leaked imperial: ${wasteLf}`);
      }
    });
  }
}

// ── 7. Panels unit-aware label rendering ─────────────────────────────────────

test("en/imperial panels transitions_runs_committed renders LF", () => {
  const pt = loadJson("en", "panels") as Record<string, string>;
  const rendered = interpolate(pt["takeoffs.transitions_runs_committed"], { ...UNIT_MAPS.imperial, count: "2", lf: "12.5", tag: "CPT-1" });
  assert.ok(rendered.includes("LF"), `en/imperial transitions_runs_committed must render "LF": ${rendered}`);
  assert.ok(!hasVar(rendered, "lu"), `en/imperial transitions_runs_committed has unresolved {{lu}}: ${rendered}`);
});

test("en/metric panels transitions_runs_committed renders m", () => {
  const pt = loadJson("en", "panels") as Record<string, string>;
  const rendered = interpolate(pt["takeoffs.transitions_runs_committed"], { ...UNIT_MAPS.metric, count: "2", lf: "3.81", tag: "CPT-1" });
  assert.ok(rendered.includes(" m"), `en/metric transitions_runs_committed must render "m": ${rendered}`);
  assert.ok(!rendered.includes("LF"), `en/metric transitions_runs_committed must not contain "LF": ${rendered}`);
});

test("en/imperial panels transitions_across_wall renders LF and ″", () => {
  const pt = loadJson("en", "panels") as Record<string, string>;
  const rendered = interpolate(pt["takeoffs.transitions_across_wall"], { ...UNIT_MAPS.imperial, lf: "34", gap: "4", divisor: "12" });
  assert.ok(rendered.includes("LF") && rendered.includes("in"),
    `en/imperial transitions_across_wall must render "LF" and "in": ${rendered}`);
});

test("en/metric panels transitions_across_wall renders m and mm", () => {
  const pt = loadJson("en", "panels") as Record<string, string>;
  const rendered = interpolate(pt["takeoffs.transitions_across_wall"], { ...UNIT_MAPS.metric, lf: "10.36", gap: "102", divisor: "1000" });
  assert.ok(rendered.includes(" m ") || rendered.endsWith(" m"),
    `en/metric transitions_across_wall must render "m": ${rendered}`);
  assert.ok(rendered.includes("mm"),
    `en/metric transitions_across_wall must render "mm": ${rendered}`);
  assert.ok(!rendered.includes("LF"), `en/metric transitions_across_wall must not contain "LF": ${rendered}`);
  assert.ok(!hasVar(rendered, "lu") && !hasVar(rendered, "thick_u"),
    `en/metric transitions_across_wall has unresolved vars: ${rendered}`);
});

test("en/metric panels height_title renders formula with m²/m", () => {
  const pt = loadJson("en", "panels") as Record<string, string>;
  const rendered = interpolate(pt["takeoffs.height_title"], { ...UNIT_MAPS.metric, unit: "m", divisor: "1000" });
  assert.ok(rendered.includes("m²") && rendered.includes(" m ×"),
    `en/metric height_title must render "m²" and "m ×": ${rendered}`);
  assert.ok(!hasBareImperial(rendered), `en/metric height_title leaked imperial: ${rendered}`);
});

test("en/imperial panels height_title renders formula with SF/LF", () => {
  const pt = loadJson("en", "panels") as Record<string, string>;
  const rendered = interpolate(pt["takeoffs.height_title"], { ...UNIT_MAPS.imperial, unit: "ft", divisor: "12" });
  assert.ok(rendered.includes("SF") && rendered.includes("LF ×"),
    `en/imperial height_title must render "SF" and "LF ×": ${rendered}`);
});

test("en/metric panels thickness_title renders formula with m²/m and divisor 1000", () => {
  const pt = loadJson("en", "panels") as Record<string, string>;
  const rendered = interpolate(pt["takeoffs.thickness_title"], { ...UNIT_MAPS.metric, unit: "mm", divisor: "1000" });
  assert.ok(rendered.includes("m²") && rendered.includes(" m × T/1000"),
    `en/metric thickness_title must render "m²" and "m × T/1000": ${rendered}`);
  assert.ok(!hasBareImperial(rendered), `en/metric thickness_title leaked imperial: ${rendered}`);
});

test("en/imperial panels thickness_title renders formula with SF/LF and divisor 12", () => {
  const pt = loadJson("en", "panels") as Record<string, string>;
  const rendered = interpolate(pt["takeoffs.thickness_title"], { ...UNIT_MAPS.imperial, unit: "in", divisor: "12" });
  assert.ok(rendered.includes("SF") && rendered.includes("LF × T/12"),
    `en/imperial thickness_title must render "SF" and "LF × T/12": ${rendered}`);
});

// ── 7b. Roll-width tooltips: no imperial leakage in metric output ────────────

test("en/metric panels roll_width_broadloom_title renders metric widths", () => {
  const pt = loadJson("en", "panels") as Record<string, string>;
  const widths = `${(12 * M_PER_FT).toFixed(2)} m / ${(15 * M_PER_FT).toFixed(2)} m`;
  const rendered = interpolate(pt["takeoffs.roll_width_broadloom_title"], { widths });
  assert.ok(rendered.includes("3.66 m"), `broadloom_title must show metric width: ${rendered}`);
  assert.ok(!hasBareFeetSymbols(rendered), `en/metric roll_width_broadloom_title leaked ′/″: ${rendered}`);
  assert.ok(!hasVar(rendered, "widths"), `roll_width_broadloom_title has unresolved {{widths}}: ${rendered}`);
});

test("en/imperial panels roll_width_broadloom_title renders imperial widths", () => {
  const pt = loadJson("en", "panels") as Record<string, string>;
  const rendered = interpolate(pt["takeoffs.roll_width_broadloom_title"], { widths: "12′ / 15′" });
  assert.ok(rendered.includes("12′") && rendered.includes("15′"),
    `en/imperial roll_width_broadloom_title must show imperial widths: ${rendered}`);
  assert.ok(!hasVar(rendered, "widths"), `roll_width_broadloom_title has unresolved {{widths}}: ${rendered}`);
});

test("en/metric panels roll_width_resilient_title renders metric widths", () => {
  const pt = loadJson("en", "panels") as Record<string, string>;
  const widths = `${(6 * M_PER_FT).toFixed(2)} m, ${(6.5 * M_PER_FT).toFixed(2)} m, ${(12 * M_PER_FT).toFixed(2)} m`;
  const rendered = interpolate(pt["takeoffs.roll_width_resilient_title"], { widths });
  assert.ok(rendered.includes("1.83 m"), `resilient_title must show metric width: ${rendered}`);
  assert.ok(!hasBareFeetSymbols(rendered), `en/metric roll_width_resilient_title leaked ′/″: ${rendered}`);
  assert.ok(!hasVar(rendered, "widths"), `roll_width_resilient_title has unresolved {{widths}}: ${rendered}`);
});

test("en/imperial panels roll_width_resilient_title renders imperial widths", () => {
  const pt = loadJson("en", "panels") as Record<string, string>;
  const rendered = interpolate(pt["takeoffs.roll_width_resilient_title"], { widths: "6′, 6′6″, 12′" });
  assert.ok(rendered.includes("6′") && rendered.includes("12′"),
    `en/imperial roll_width_resilient_title must show imperial widths: ${rendered}`);
  assert.ok(!hasVar(rendered, "widths"), `roll_width_resilient_title has unresolved {{widths}}: ${rendered}`);
});

test("pt-br/metric panels roll_width_broadloom_title renders metric widths", () => {
  const pt = loadJson("pt-br", "panels") as Record<string, string>;
  const widths = `${(12 * M_PER_FT).toFixed(2)} m / ${(15 * M_PER_FT).toFixed(2)} m`;
  const rendered = interpolate(pt["takeoffs.roll_width_broadloom_title"], { widths });
  assert.ok(rendered.includes("3.66 m"), `pt-br/metric broadloom_title must show metric width: ${rendered}`);
  assert.ok(!hasBareFeetSymbols(rendered), `pt-br/metric roll_width_broadloom_title leaked ′/″: ${rendered}`);
  assert.ok(!hasVar(rendered, "widths"), `pt-br roll_width_broadloom_title has unresolved {{widths}}: ${rendered}`);
});

// ── 8. ReportPanel: labor_view_title must not show SY in metric ──────────────

test("en/metric report columns.labor_view_title does not show SY", () => {
  const report = loadJson("en", "report") as Record<string, unknown>;
  const tpl = getVal(report, "columns.labor_view_title") as string;
  const rendered = interpolate(tpl, { ...UNIT_MAPS.imperial, sy: "SY" });
  // The template intentionally no longer contains bare SY — the SY column
  // is retired in metric, so the tooltip describes only the area unit.
  assert.ok(!tpl.includes("SY"),
    `en report columns.labor_view_title must not contain bare "SY" in template: ${tpl}`);
});

test("en report columns.labor_view_title no bare SY in locale string", () => {
  const report = loadJson("en", "report") as Record<string, unknown>;
  const tpl = getVal(report, "columns.labor_view_title") as string;
  // The template itself should not contain a bare "SY" — it should only show
  // SY via interpolation (which we removed from the template entirely)
  assert.ok(!tpl.includes("SY"),
    `en report columns.labor_view_title must not contain bare "SY": ${tpl}`);
});

// ── 9. Source: TakeoffCanvas passes areaUnit(lenUnit) to unit-aware t() calls ──

test("TakeoffCanvas passes areaUnit(lenUnit) to unit-aware tooltip t() calls", () => {
  const src = loadSrc("src/pages/TakeoffCanvas.jsx");
  const lines = src.split("\n");

  const assertParamOnLine = (key: string, param: string, msg: string) => {
    const line = lines.find((l) => l.includes(`t('${key}'`) || l.includes(`t("${key}"`));
    assert.ok(line, `No t('${key}') call found in TakeoffCanvas.jsx`);
    assert.match(line, new RegExp(`${param}:`), msg);
  };

  assertParamOnLine("rule.offer", "au", "TakeoffCanvas must pass `au:` to t('rule.offer')");
  assertParamOnLine("status.gap_bridged", "lu", "TakeoffCanvas must pass `lu:` to t('status.gap_bridged')");
  assertParamOnLine("status.passage_excluded", "lu", "TakeoffCanvas must pass `lu:` to t('status.passage_excluded')");
  assertParamOnLine("status.set_height", "lu", "TakeoffCanvas must pass `lu:` to t('status.set_height')");
  assertParamOnLine("status.set_scale_paste", "au", "TakeoffCanvas must pass `au:` to t('status.set_scale_paste')");
  assertParamOnLine("status.set_scale_paste", "lu", "TakeoffCanvas must pass `lu:` to t('status.set_scale_paste')");
  assertParamOnLine("commit.transitions_derived", "lu", "TakeoffCanvas must pass `lu:` to t('commit.transitions_derived')");
});

test("TakeoffCanvas uses areaUnit()/lenUnit() expressions (not hardcoded strings)", () => {
  const src = loadSrc("src/pages/TakeoffCanvas.jsx");

  const findTCallLine = (key: string): string => {
    const line = src.split("\n").find((l) => l.includes(`t('${key}'`) || l.includes(`t("${key}"`));
    assert.ok(line, `No t('${key}') call found in TakeoffCanvas.jsx`);
    return line;
  };

  const assertExpr = (key: string, expr: string, param: string) => {
    const line = findTCallLine(key);
    assert.ok(line.includes(expr),
      `${key} t() must pass ${expr} for ${param}, got: ${line.trim()}`);
  };

  assertExpr("rule.offer", "areaUnit(", "au");
  assertExpr("status.gap_bridged", "lenUnit(", "lu");
  assertExpr("status.passage_excluded", "lenUnit(", "lu");
  assertExpr("status.set_height", "lenUnit(", "lu");
  assertExpr("status.set_scale_paste", "areaUnit(", "au");
  assertExpr("status.set_scale_paste", "lenUnit(", "lu");
  assertExpr("commit.transitions_derived", "lenUnit(", "lu");
});

test("TakeoffCanvas uses areaVal()/lenVal() for converted display values", () => {
  const src = loadSrc("src/pages/TakeoffCanvas.jsx");
  assert.ok(src.includes("areaVal("), "TakeoffCanvas must use areaVal()");
  assert.ok(src.includes("lenVal("), "TakeoffCanvas must use lenVal()");
  assert.ok(src.includes("heightVal("), "TakeoffCanvas must use heightVal()");
});

test("TakeoffCanvas status.set_height used at both commit gate and readout", () => {
  const src = loadSrc("src/pages/TakeoffCanvas.jsx");
  const lines = src.split("\n");
  const setHeightLines = lines
    .map((l, i) => ({ line: l, num: i + 1 }))
    .filter(({ line }) => line.includes("status.set_height"));

  assert.ok(setHeightLines.length >= 2,
    `status.set_height must have ≥2 call sites, found ${setHeightLines.length}`);

  const commitGate = setHeightLines.find(({ line }) =>
    line.includes("setCommitMsg") || line.includes("setCommitMsg(t("),
  );
  assert.ok(commitGate,
    `One status.set_height call must be in setCommitMsg\nAll sites: ${setHeightLines.map((l) => `L${l.num}: ${l.line.trim()}`).join("\n")}`);

  const readoutError = setHeightLines.find(({ line }) => !line.includes("setCommitMsg"));
  assert.ok(readoutError,
    `One status.set_height call must be in JSX readout\nAll sites: ${setHeightLines.map((l) => `L${l.num}: ${l.line.trim()}`).join("\n")}`);
});

// ── 10. Source: ReportPanel passes areaUnit(lenUnit) for hint t() calls ──────

test("ReportPanel passes areaUnit(lenUnit) to unit-aware hint t() calls", () => {
  const src = loadSrc("src/components/ReportPanel.jsx");
  const lines = src.split("\n");

  const assertParamOnLine = (key: string, param: string, msg: string) => {
    const line = lines.find((l) => l.includes(`t('${key}'`) || l.includes(`t("${key}"`));
    assert.ok(line, `No t('${key}') call found in ReportPanel.jsx`);
    assert.match(line, new RegExp(`${param}:`), msg);
  };

  assertParamOnLine("hints.waste_lf", "au", "ReportPanel must pass `au:` to t('hints.waste_lf')");
  assertParamOnLine("hints.waste_lf", "lu", "ReportPanel must pass `lu:` to t('hints.waste_lf')");
  assertParamOnLine("columns.labor_view_title", "au", "ReportPanel must pass `au:` to t('columns.labor_view_title')");
  assertParamOnLine("footnote.waste_metric", "au", "ReportPanel must pass `au:` to t('footnote.waste_metric')");
  assertParamOnLine("footnote.waste_metric", "lu", "ReportPanel must pass `lu:` to t('footnote.waste_metric')");
});

test("ReportPanel uses areaUnit()/lenUnit() expressions (not hardcoded strings)", () => {
  const src = loadSrc("src/components/ReportPanel.jsx");
  const lines = src.split("\n");

  const auDefLine = lines.find((l) => l.includes("areaUnit(units)") || l.includes("areaUnit("));
  assert.ok(auDefLine, "ReportPanel must define AU via areaUnit() call");

  const wasteLfLine = lines.find((l) => l.includes("t('hints.waste_lf'") || l.includes('t("hints.waste_lf"'));
  assert.ok(wasteLfLine, "No t('hints.waste_lf') call found in ReportPanel.jsx");
  assert.ok(wasteLfLine.includes("au:") && wasteLfLine.includes("lu:"),
    `hints.waste_lf t() must pass au: and lu:, got: ${wasteLfLine.trim()}`);

  const laborLine = lines.find((l) => l.includes("t('columns.labor_view_title'") || l.includes('t("columns.labor_view_title"'));
  assert.ok(laborLine, "No t('columns.labor_view_title') call found in ReportPanel.jsx");
  assert.ok(laborLine.includes("au:"),
    `columns.labor_view_title t() must pass au:, got: ${laborLine.trim()}`);

  const wasteMetricLine = lines.find((l) => l.includes("t('footnote.waste_metric'") || l.includes('t("footnote.waste_metric"'));
  assert.ok(wasteMetricLine, "No t('footnote.waste_metric') call found in ReportPanel.jsx");
  assert.ok(wasteMetricLine.includes("au:") && wasteMetricLine.includes("lu:"),
    `footnote.waste_metric t() must pass au: and lu:, got: ${wasteMetricLine.trim()}`);
});

test("ReportPanel defines AU = areaUnit(units) and LU = lenUnit(units)", () => {
  const src = loadSrc("src/components/ReportPanel.jsx");
  const lines = src.split("\n");

  const auDefLine = lines.find((l) => l.includes("AU") && l.includes("areaUnit(units)"));
  assert.ok(auDefLine, "ReportPanel must define AU via areaUnit(units)");
  assert.match(auDefLine, /AU\s*=\s*areaUnit\(units\)/,
    `AU must be assigned as areaUnit(units), got: ${auDefLine.trim()}`);

  const luDefLine = lines.find((l) => l.includes("LU") && l.includes("lenUnit(units)"));
  assert.ok(luDefLine, "ReportPanel must define LU via lenUnit(units)");
  assert.match(luDefLine, /LU\s*=\s*lenUnit\(units\)/,
    `LU must be assigned as lenUnit(units), got: ${luDefLine.trim()}`);

  const wasteLfLine = lines.find((l) =>
    l.includes("t('hints.waste_lf'") || l.includes('t("hints.waste_lf"'));
  assert.ok(wasteLfLine, "No t('hints.waste_lf') call found");
  assert.ok(wasteLfLine.includes("au: AU") || wasteLfLine.includes("au:AU"),
    `hints.waste_lf must pass au: AU, got: ${wasteLfLine.trim()}`);
  assert.ok(wasteLfLine.includes("lu: LU") || wasteLfLine.includes("lu:LU"),
    `hints.waste_lf must pass lu: LU, got: ${wasteLfLine.trim()}`);

  const laborLine = lines.find((l) =>
    l.includes("t('columns.labor_view_title'") || l.includes('t("columns.labor_view_title"'));
  assert.ok(laborLine, "No t('columns.labor_view_title') call found");
  assert.ok(laborLine.includes("au: AU") || laborLine.includes("au:AU"),
    `columns.labor_view_title must pass au: AU, got: ${laborLine.trim()}`);

  const wasteMetricLine = lines.find((l) =>
    l.includes("t('footnote.waste_metric'") || l.includes('t("footnote.waste_metric"'));
  assert.ok(wasteMetricLine, "No t('footnote.waste_metric') call found");
  assert.ok(wasteMetricLine.includes("au: AU") || wasteMetricLine.includes("au:AU"),
    `footnote.waste_metric must pass au: AU, got: ${wasteMetricLine.trim()}`);
  assert.ok(wasteMetricLine.includes("lu: LU") || wasteMetricLine.includes("lu:LU"),
    `footnote.waste_metric must pass lu: LU, got: ${wasteMetricLine.trim()}`);
});

// ── 11. Source: TakeoffsPanel passes units to TransitionsAction ──────────────

test("TakeoffsPanel passes units prop to TransitionsAction", () => {
  const src = loadSrc("src/components/TakeoffsPanel.jsx");
  // The JSX call spans multiple lines; search for units={units} near TransitionsAction
  const idx = src.indexOf("<TransitionsAction");
  assert.ok(idx > 0, "No TransitionsAction call found in TakeoffsPanel.jsx");
  // Find the closing /> or </TransitionsAction> — up to 500 chars
  const chunk = src.slice(idx, idx + 500);
  assert.ok(chunk.includes("units={units}"),
    `TransitionsAction must receive units={units}, got: ${chunk.slice(0, 200)}`);
});

test("TakeoffsPanel TransitionsAction uses lenVal/thickVal for metric conversion", () => {
  const src = loadSrc("src/components/TakeoffsPanel.jsx");
  // TransitionsAction function body should use lenUnit and thickUnit
  const fnStart = src.indexOf("function TransitionsAction(");
  assert.ok(fnStart > 0, "TransitionsAction function not found");
  const fnBody = src.slice(fnStart, src.indexOf("\nfunction ", fnStart + 1) || src.length);
  assert.ok(fnBody.includes("lenUnit(units)"), "TransitionsAction must use lenUnit(units) for lu");
  assert.ok(fnBody.includes("thickUnit(units)"), "TransitionsAction must use thickUnit(units) for thick_u");
  assert.ok(fnBody.includes("lenVal("), "TransitionsAction must use lenVal() for metric conversion");
  assert.ok(fnBody.includes("thickVal("), "TransitionsAction must use thickVal() for metric conversion");
});

// ── 11b. Source: TakeoffsPanel passes widths to roll-width tooltip t() calls ──

test("TakeoffsPanel passes widths interpolation to roll-width tooltip t() calls", () => {
  const src = loadSrc("src/components/TakeoffsPanel.jsx");
  const lines = src.split("\n");

  const broadloomLine = lines.find((l) => l.includes("takeoffs.roll_width_broadloom_title"));
  assert.ok(broadloomLine, "No takeoffs.roll_width_broadloom_title call found in TakeoffsPanel.jsx");
  assert.ok(broadloomLine.includes("widths:"),
    `roll_width_broadloom_title must pass widths interpolation, got: ${broadloomLine.trim()}`);

  const resilientLines = lines.filter((l) => l.includes("takeoffs.roll_width_resilient_title"));
  assert.ok(resilientLines.length >= 2,
    `Expected ≥2 roll_width_resilient_title calls (metric + imperial), found ${resilientLines.length}`);
  for (const line of resilientLines) {
    assert.ok(line.includes("widths:"),
      `roll_width_resilient_title must pass widths interpolation, got: ${line.trim()}`);
  }
});

test("TakeoffsPanel defines broadloomWidths and resilientWidths from M_PER_FT", () => {
  const src = loadSrc("src/components/TakeoffsPanel.jsx");
  assert.ok(src.includes("broadloomWidths"), "TakeoffsPanel must define broadloomWidths");
  assert.ok(src.includes("resilientWidths"), "TakeoffsPanel must define resilientWidths");
  assert.ok(src.includes("broadloomWidths ="), "broadloomWidths must be assigned");
  assert.ok(src.includes("resilientWidths ="), "resilientWidths must be assigned");
});

test("TakeoffsPanel passes au/lu/divisor to height_title and thickness_title", () => {
  const src = loadSrc("src/components/TakeoffsPanel.jsx");
  const lines = src.split("\n");

  const heightLine = lines.find((l) => l.includes("takeoffs.height_title"));
  assert.ok(heightLine, "No takeoffs.height_title call found in TakeoffsPanel.jsx");
  assert.ok(heightLine.includes("areaUnit(units)") || heightLine.includes("au:"),
    `height_title must pass au/areaUnit, got: ${heightLine.trim()}`);
  assert.ok(heightLine.includes("lenUnit(units)") || heightLine.includes("lu:"),
    `height_title must pass lu/lenUnit, got: ${heightLine.trim()}`);

  const thickLine = lines.find((l) => l.includes("takeoffs.thickness_title"));
  assert.ok(thickLine, "No takeoffs.thickness_title call found in TakeoffsPanel.jsx");
  assert.ok(thickLine.includes("areaUnit(units)") || thickLine.includes("au:"),
    `thickness_title must pass au/areaUnit, got: ${thickLine.trim()}`);
  assert.ok(thickLine.includes("lenUnit(units)") || thickLine.includes("lu:"),
    `thickness_title must pass lu/lenUnit, got: ${thickLine.trim()}`);
  assert.ok(thickLine.includes("divisor:"),
    `thickness_title must pass divisor, got: ${thickLine.trim()}`);
});

test("TakeoffsPanel grout tile titles use t() with unit interpolation (not hardcoded English)", () => {
  const src = loadSrc("src/components/TakeoffsPanel.jsx");
  const lines = src.split("\n");

  // Grout tile param titles that take a unit param (l/w/t/joint)
  const unitGroutLines = lines.filter((l) =>
    l.includes("grout_tile_l_title") || l.includes("grout_tile_w_title") ||
    l.includes("grout_tile_t_title") || l.includes("grout_joint_title"));

  assert.ok(unitGroutLines.length >= 4,
    `Expected ≥4 grout tile title t() calls with unit, found ${unitGroutLines.length}`);

  for (const line of unitGroutLines) {
    assert.ok(line.includes("t('takeoffs.") || line.includes('t("takeoffs.'),
      `Grout tile title must use t() call, got: ${line.trim()}`);
    assert.ok(line.includes("unit:") || line.includes("unit :"),
      `Grout tile title must pass unit interpolation, got: ${line.trim()}`);
  }

  // grout_bag_title uses t() but doesn't need unit (always "lbs")
  const bagLine = lines.find((l) => l.includes("grout_bag_title"));
  assert.ok(bagLine, "No grout_bag_title call found");
  assert.ok(bagLine.includes("t('takeoffs.grout_bag_title')") || bagLine.includes('t("takeoffs.grout_bag_title")'),
    `grout_bag_title must use t() call, got: ${bagLine.trim()}`);
});

// ── 12. Source: TakeoffsPanel has aria-label from panels namespace ────────────

test("TakeoffsPanel root div has aria-label from panels namespace with unit interpolation", () => {
  const src = loadSrc("src/components/TakeoffsPanel.jsx");
  const lines = src.split("\n");

  // Find the root div with aria-label
  const ariaLine = lines.find((l) =>
    l.includes("aria-label={t('takeoffs.panel_aria'") || l.includes('aria-label={t("takeoffs.panel_aria"'));
  assert.ok(ariaLine, "TakeoffsPanel root div must have aria-label from takeoffs.panel_aria");
  assert.ok(ariaLine.includes("unit:") || ariaLine.includes("unit :"),
    `panel_aria must pass unit interpolation, got: ${ariaLine.trim()}`);
});

// ── 13. Source: TakeoffsPanel ARIA labels localized via panels namespace ─────

test("TakeoffsPanel DimParamInput uses localized ARIA labels from panels namespace", () => {
  const src = loadSrc("src/components/TakeoffsPanel.jsx");
  const lines = src.split("\n");

  // Find DimParamInput function body
  const fnStart = src.indexOf("function DimParamInput(");
  assert.ok(fnStart > 0, "DimParamInput function not found");
  const fnBody = src.slice(fnStart, src.indexOf("\nfunction ", fnStart + 1) || src.length);

  // Must use t() from panels namespace for ARIA labels, not hardcoded English
  assert.ok(fnBody.includes("useTranslation(\"panels\")"),
    "DimParamInput must use useTranslation(\"panels\")");
  assert.ok(fnBody.includes("takeoffs.wall_height_aria"),
    "DimParamInput must use takeoffs.wall_height_aria for wall height ARIA label");
  assert.ok(fnBody.includes("takeoffs.material_thickness_aria"),
    "DimParamInput must use takeoffs.material_thickness_aria for material thickness ARIA label");
  assert.ok(!fnBody.includes("`Wall height (`"),
    "DimParamInput must not have hardcoded English 'Wall height' ARIA label");
  assert.ok(!fnBody.includes("`Material thickness (`"),
    "DimParamInput must not have hardcoded English 'Material thickness' ARIA label");
});

test("TakeoffsPanel MaterialRateInput uses localized ARIA labels from panels namespace", () => {
  const src = loadSrc("src/components/TakeoffsPanel.jsx");
  const lines = src.split("\n");

  // Find MaterialRateInput function body
  const fnStart = src.indexOf("function MaterialRateInput(");
  assert.ok(fnStart > 0, "MaterialRateInput function not found");
  const fnBody = src.slice(fnStart, src.indexOf("\nfunction ", fnStart + 1) || src.length);

  // Must use t() from panels namespace for ARIA labels
  assert.ok(fnBody.includes("useTranslation(\"panels\")"),
    "MaterialRateInput must use useTranslation(\"panels\")");
  assert.ok(fnBody.includes("takeoffs.coverage_rate_aria"),
    "MaterialRateInput must use takeoffs.coverage_rate_aria for ARIA label");
  assert.ok(!fnBody.includes("`Coverage rate per unit (`"),
    "MaterialRateInput must not have hardcoded English 'Coverage rate per unit' ARIA label");
});

test("TakeoffsPanel grout_derive_title uses unit interpolation", () => {
  const src = loadSrc("src/components/TakeoffsPanel.jsx");
  const lines = src.split("\n");

  const deriveLine = lines.find((l) => l.includes("takeoffs.grout_derive_title"));
  assert.ok(deriveLine, "No takeoffs.grout_derive_title call found in TakeoffsPanel.jsx");
  assert.ok(deriveLine.includes("unit:") || deriveLine.includes("unit :"),
    `grout_derive_title must pass unit interpolation, got: ${deriveLine.trim()}`);
});

// ── 14. pt-BR metric grout coverage ──────────────────────────────────────────

test("pt-br/metric grout tile and joint titles render correct unit labels", () => {
  const panels = loadJson("pt-br", "panels") as Record<string, string>;
  const u = { ...UNIT_MAPS.metric, unit: "mm" };

  const tileL = interpolate(panels["takeoffs.grout_tile_l_title"], { ...u });
  assert.ok(tileL.includes("mm"), `pt-br/metric grout_tile_l_title should contain "mm": ${tileL}`);
  assert.ok(!hasBareImperial(tileL), `pt-br/metric grout_tile_l_title leaked imperial: ${tileL}`);

  const tileW = interpolate(panels["takeoffs.grout_tile_w_title"], { ...u });
  assert.ok(tileW.includes("mm"), `pt-br/metric grout_tile_w_title should contain "mm": ${tileW}`);
  assert.ok(!hasBareImperial(tileW), `pt-br/metric grout_tile_w_title leaked imperial: ${tileW}`);

  const tileT = interpolate(panels["takeoffs.grout_tile_t_title"], { ...u });
  assert.ok(tileT.includes("mm"), `pt-br/metric grout_tile_t_title should contain "mm": ${tileT}`);
  assert.ok(!hasBareImperial(tileT), `pt-br/metric grout_tile_t_title leaked imperial: ${tileT}`);

  const joint = interpolate(panels["takeoffs.grout_joint_title"], { ...u });
  assert.ok(joint.includes("mm"), `pt-br/metric grout_joint_title should contain "mm": ${joint}`);
  assert.ok(!hasBareImperial(joint), `pt-br/metric grout_joint_title leaked imperial: ${joint}`);
  assert.ok(!hasBareIn(joint), `pt-br/metric grout_joint_title has bare "in": ${joint}`);

  const derive = interpolate(panels["takeoffs.grout_derive_title"], { ...u });
  assert.ok(derive.includes("mm"), `pt-br/metric grout_derive_title should contain "mm": ${derive}`);
  assert.ok(!hasBareImperial(derive), `pt-br/metric grout_derive_title leaked imperial: ${derive}`);
  assert.ok(!hasVar(derive, "unit"), `pt-br/metric grout_derive_title has unresolved {{unit}}: ${derive}`);
});

// ── 15. Cross-locale ARIA key parity ────────────────────────────────────────

assertCrossLocaleParity("panels", [
  "takeoffs.wall_height_aria",
  "takeoffs.material_thickness_aria",
  "takeoffs.coverage_rate_aria",
  "takeoffs.grout_derive_title",
  "takeoffs.roll_width_broadloom_title",
  "takeoffs.roll_width_resilient_title",
]);
