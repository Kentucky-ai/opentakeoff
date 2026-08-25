// oracle-findings.test.ts — focused tests for the oracle audit findings:
// namespace resolution, markup tool titles, highlighter locale keys, compact
// rail labels, stamp surfaces, and user-name safety.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import "./i18n-setup.mjs";

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

// ── 1. Namespace resolution: TakeoffCanvas uses canvas ns for strip ─────────

test("TakeoffCanvas uses conditions.strip (canvas ns), not takeoffs.strip (panels ns)", () => {
  const canvas = loadSrc("src/pages/TakeoffCanvas.jsx");

  // The tab-strip label must use the canvas-namespace key
  assert.match(
    canvas,
    /t\(\s*['"]conditions\.strip['"]\s*\)/,
    "TakeoffCanvas must render the strip label via t('conditions.strip') (canvas ns)",
  );

  // Must NOT use the panels-namespace key in the canvas component
  assert.doesNotMatch(
    canvas,
    /t\(\s*['"]takeoffs\.strip['"]\s*\)/,
    "TakeoffCanvas must not reference 'takeoffs.strip' (panels ns key)",
  );
});

test("en and pt-br canvas.json have conditions.strip", () => {
  for (const lng of ["en", "pt-br"]) {
    const val = getVal(loadJson(lng, "canvas"), "conditions.strip");
    assert.ok(val && typeof val === "string" && val.trim(), `${lng}/canvas.json: conditions.strip missing or empty`);
  }
});

// ── 2. Per-tool markup titles in getMarkupTools ─────────────────────────────

test("getMarkupTools items carry a title property", () => {
  const src = loadSrc("src/lib/canvasConstants.js");

  // Each tool object should have a title property set via _t()
  const markupSection = src.slice(src.indexOf("getMarkupTools"));
  assert.match(
    markupSection,
    /title:\s*_t\(["']markup_tool\.\w+_title["']\)/,
    "getMarkupTools must include a title property for each tool",
  );
});

test("en and pt-br lib.json have markup tool title keys for all five tools", () => {
  const tools = ["highlighter_title", "cloud_title", "callout_title", "text_title", "highlight_title"];
  for (const lng of ["en", "pt-br"]) {
    const lib = loadJson(lng, "lib");
    for (const key of tools) {
      const val = getVal(lib, `markup_tool.${key}`);
      assert.ok(val && typeof val === "string" && val.trim(), `${lng}/lib.json: markup_tool.${key} missing or empty`);
    }
  }
});

// ── 3. Highlighter locale keys ──────────────────────────────────────────────

test("en and pt-br canvas.json have all highlighter popover locale keys", () => {
  const keys = ["markup.ink_color", "markup.tip_size", "markup.fine", "markup.medium", "markup.broad", "markup.tip_type"];
  for (const lng of ["en", "pt-br"]) {
    const canvas = loadJson(lng, "canvas");
    for (const key of keys) {
      const val = getVal(canvas, key);
      assert.ok(val && typeof val === "string" && val.trim(), `${lng}/canvas.json: ${key} missing or empty`);
    }
  }
});

test("TakeoffCanvas highlighter popover uses translated keys for ink_color, tip_size, tip_type", () => {
  const canvas = loadSrc("src/pages/TakeoffCanvas.jsx");

  assert.match(canvas, /t\(['"]markup\.ink_color['"]\)/, "highlighter popover must use t('markup.ink_color')");
  // tip_size, fine, medium, broad, tip_type are used as interpolation inside other t() calls
  assert.match(canvas, /markup\.tip_size/, "highlighter popover must reference markup.tip_size");
  assert.match(canvas, /markup\.fine/, "highlighter popover must reference markup.fine");
  assert.match(canvas, /markup\.medium/, "highlighter popover must reference markup.medium");
  assert.match(canvas, /markup\.broad/, "highlighter popover must reference markup.broad");
  assert.match(canvas, /markup\.tip_type/, "highlighter popover must reference markup.tip_type");
});

// ── 4. Compact rail labels use translated keys ─────────────────────────────

test("TakeoffCanvas rail labels use t() calls, not hardcoded strings", () => {
  const canvas = loadSrc("src/pages/TakeoffCanvas.jsx");

  // Should use t('rail.sel') etc., not railLabel("SEL")
  assert.match(canvas, /railLabel\(\s*t\(['"]rail\.sel['"]\)\s*\)/, "rail SEL must use t('rail.sel')");
  assert.match(canvas, /railLabel\(\s*t\(['"]rail\.meas['"]\)\s*\)/, "rail MEAS must use t('rail.meas')");
  assert.match(canvas, /railLabel\(\s*t\(['"]rail\.cut['"]\)\s*\)/, "rail CUT must use t('rail.cut')");
  // rail.mark removed — annotation/markup tools moved to the toolbar row
  assert.match(canvas, /railLabel\(\s*t\(['"]rail\.cal['"]\)\s*\)/, "rail CAL must use t('rail.cal')");

  // Must NOT have the old hardcoded strings
  assert.doesNotMatch(canvas, /railLabel\("SEL"\)/, "no hardcoded railLabel('SEL')");
  assert.doesNotMatch(canvas, /railLabel\("MEAS"\)/, "no hardcoded railLabel('MEAS')");
  assert.doesNotMatch(canvas, /railLabel\("CUT"\)/, "no hardcoded railLabel('CUT')");
  assert.doesNotMatch(canvas, /railLabel\("MARK"\)/, "no hardcoded railLabel('MARK')");
  assert.doesNotMatch(canvas, /railLabel\("CAL"\)/, "no hardcoded railLabel('CAL')");
});

test("en and pt-br canvas.json have rail.* keys", () => {
  const railKeys = ["rail.sel", "rail.meas", "rail.cut", "rail.mark", "rail.cal"];
  for (const lng of ["en", "pt-br"]) {
    const canvas = loadJson(lng, "canvas");
    for (const key of railKeys) {
      const val = getVal(canvas, key);
      assert.ok(val && typeof val === "string" && val.trim(), `${lng}/canvas.json: ${key} missing or empty`);
    }
  }
});

// ── 5. TOOL_VERB footer uses translated status.verb.* keys ──────────────────

test("TOOL_VERB maps tool IDs to translation keys, not raw English strings", () => {
  const canvas = loadSrc("src/pages/TakeoffCanvas.jsx");

  // TOOL_VERB should map to "status.verb.*" keys
  assert.match(canvas, /status\.verb\.select/, "TOOL_VERB[select] must map to status.verb.select");
  assert.match(canvas, /status\.verb\.measure_polygon/, "TOOL_VERB[area] must map to status.verb.measure_polygon");
  assert.match(canvas, /status\.verb\.cut_out/, "TOOL_VERB[deduct] must map to status.verb.cut_out");
  assert.match(canvas, /status\.verb\.annotate/, "TOOL_VERB[highlighter] must map to status.verb.annotate");

  // Footer must call t() to translate the verb
  assert.match(canvas, /t\(\s*TOOL_VERB\[tool\]\s*\)/, "footer must translate TOOL_VERB via t()");
});

test("en and pt-br canvas.json have status.verb.* keys", () => {
  const verbKeys = [
    "status.verb.select", "status.verb.measure_polygon", "status.verb.cut_out",
    "status.verb.measure_line", "status.verb.measure_surface", "status.verb.place_count",
    "status.verb.one_click", "status.verb.set_scale", "status.verb.check_dimension",
    "status.verb.zone_check", "status.verb.stitch_align", "status.verb.find_schedule",
    "status.verb.annotate",
  ];
  for (const lng of ["en", "pt-br"]) {
    const canvas = loadJson(lng, "canvas");
    for (const key of verbKeys) {
      const val = getVal(canvas, key);
      assert.ok(val && typeof val === "string" && val.trim(), `${lng}/canvas.json: ${key} missing or empty`);
    }
  }
});

// ── 6. All stamp surfaces: armed message, placement status, Place title ─────

test("en and pt-br panels.json have all stamp surface keys", () => {
  const keys = [
    "stamp.armed_message",
    "stamp.place_message",
    "stamp.place_message_text",
    "stamp.place_button",
    "stamp.place_title",
    "stamp.armed_button",
    "stamp.stmp_direction",
    "stamp.stmp_seam",
    "stamp.stmp_origin",
    "stamp.set_flooring",
  ];
  for (const lng of ["en", "pt-br"]) {
    const panels = loadJson(lng, "panels");
    for (const key of keys) {
      const val = getVal(panels, key);
      assert.ok(val && typeof val === "string" && val.trim(), `${lng}/panels.json: ${key} missing or empty`);
    }
  }
});

test("StampPanel Place button uses stamp.place_title tooltip", () => {
  const src = loadSrc("src/components/StampPanel.jsx");

  // Place button must use stamp.place_title, not stamp.save_selected_title
  assert.match(
    src,
    /title=\{\s*t\(\s*["']stamp\.place_title["']\s*\)\s*\}/,
    "StampPanel Place button must use t('stamp.place_title') as tooltip",
  );

  // Must NOT use save_selected_title for the Place button
  const placeButtonMatch = src.match(/onArm\(s\)\}[\s\S]*?title=\{[^}]+\}/);
  if (placeButtonMatch) {
    assert.doesNotMatch(
      placeButtonMatch[0],
      /save_selected_title/,
      "Place button must not use save_selected_title tooltip",
    );
  }
});

// ── 7. User-name safety: no dangerouslySetInnerHTML with user data ──────────

test("StampPanel does not use dangerouslySetInnerHTML for armed_message (user name)", () => {
  const src = loadSrc("src/components/StampPanel.jsx");

  // The armed message must render as text, not HTML (stamp names are user data)
  assert.doesNotMatch(
    src,
    /dangerouslySetInnerHTML[\s\S]*?stamp\.armed_message/,
    "stamp.armed_message must NOT use dangerouslySetInnerHTML (user-provided name)",
  );

  // It should render as a plain text React element — built-in names go through
  // stampDisplayName; user/imported names fall back to armedStamp.name.
  assert.match(
    src,
    /t\(\s*["']stamp\.armed_message["']\s*,\s*\{\s*name:/,
    "stamp.armed_message must render as text via t('stamp.armed_message', { name: … })",
  );
});

test("StampPanel place_message uses text-only key, not dangerouslySetInnerHTML", () => {
  const src = loadSrc("src/components/StampPanel.jsx");

  // Must not use dangerouslySetInnerHTML for the place message
  assert.doesNotMatch(
    src,
    /dangerouslySetInnerHTML[\s\S]*?stamp\.place_message[^_]*/ ,
    "stamp.place_message must NOT use dangerouslySetInnerHTML",
  );
});

test("TakeoffCanvas rule.offer and rule.staged use Trans, not dangerouslySetInnerHTML with user data", () => {
  const canvas = loadSrc("src/pages/TakeoffCanvas.jsx");
  const lines = canvas.split("\n");

  // Find the line containing rule.offer and check it doesn't use dangerouslySetInnerHTML
  const ruleOfferLine = lines.find((l) => l.includes("rule.offer"));
  assert.ok(ruleOfferLine, "rule.offer must be present in TakeoffCanvas.jsx");
  assert.doesNotMatch(
    ruleOfferLine,
    /dangerouslySetInnerHTML/,
    "rule.offer line must NOT use dangerouslySetInnerHTML (tag is user data)",
  );
  // Must use Trans component
  assert.match(ruleOfferLine, /i18nKey=["']rule\.offer["']/, "rule.offer must use <Trans> i18nKey");

  // Find the line containing rule.staged and check it doesn't use dangerouslySetInnerHTML
  const ruleStagedLine = lines.find((l) => l.includes("rule.staged") && l.includes("i18nKey"));
  assert.ok(ruleStagedLine, "rule.staged must be present in TakeoffCanvas.jsx");
  assert.doesNotMatch(
    ruleStagedLine,
    /dangerouslySetInnerHTML/,
    "rule.staged line must NOT use dangerouslySetInnerHTML (label is user data)",
  );
  assert.match(ruleStagedLine, /i18nKey=["']rule\.staged["']/, "rule.staged must use <Trans> i18nKey");
});

test("TakeoffCanvas imports Trans from react-i18next", () => {
  const canvas = loadSrc("src/pages/TakeoffCanvas.jsx");
  assert.match(
    canvas,
    /import\s*\{[^}]*Trans[^}]*\}\s*from\s*["']react-i18next["']/,
    "TakeoffCanvas must import Trans from react-i18next",
  );
});

// ── 8. pt-br lib callout is translated, not English ─────────────────────────

test("pt-br lib.json has translated callout, not English 'Callout'", () => {
  const pt = loadJson("pt-br", "lib");
  const val = getVal(pt, "markup_tool.callout");
  assert.ok(val && typeof val === "string", "pt-br/lib.json: markup_tool.callout must exist");
  assert.notEqual(val, "Callout", "pt-br/lib.json: markup_tool.callout must not be English 'Callout'");
  assert.equal(val, "Indicação", "pt-br/lib.json: markup_tool.callout should be 'Indicação'");
});

// ── 9. stamp.place_title in canvas.json (for the canvas-level status) ──────

test("en and pt-br canvas.json have stamp.place_title", () => {
  for (const lng of ["en", "pt-br"]) {
    const val = getVal(loadJson(lng, "canvas"), "stamp.place_title");
    assert.ok(val && typeof val === "string" && val.trim(), `${lng}/canvas.json: stamp.place_title missing or empty`);
  }
});

// ── 10. Markup tool titles forwarded to button props ──────────────────────

test("TakeoffCanvas passes markup tool title through to markup tool buttons", () => {
  const canvas = loadSrc("src/pages/TakeoffCanvas.jsx");
  // The getMarkupTools().map() block must use each item's title on the rendered button
  assert.match(
    canvas,
    /getMarkupTools\(\)\.map[\s\S]*?title=\{mt\.title/,
    "TakeoffCanvas markup tool buttons must use `mt.title` for their title prop",
  );
});

// ── 11. Highlighter chisel/round tip locale keys ──────────────────────────

test("en and pt-br canvas.json have markup.tip_chisel and markup.tip_round", () => {
  for (const lng of ["en", "pt-br"]) {
    const chisel = getVal(loadJson(lng, "canvas"), "markup.tip_chisel");
    assert.ok(chisel && typeof chisel === "string" && chisel.trim(), `${lng}/canvas.json: markup.tip_chisel missing or empty`);
    const round = getVal(loadJson(lng, "canvas"), "markup.tip_round");
    assert.ok(round && typeof round === "string" && round.trim(), `${lng}/canvas.json: markup.tip_round missing or empty`);
  }
});

test("pt-br tip_chisel is 'cinzel', not English 'chisel'", () => {
  const val = getVal(loadJson("pt-br", "canvas"), "markup.tip_chisel");
  assert.equal(val, "cinzel", "pt-br canvas.json: markup.tip_chisel must be 'cinzel'");
});

test("pt-br tip_round is 'arredondada', not English 'round'", () => {
  const val = getVal(loadJson("pt-br", "canvas"), "markup.tip_round");
  assert.equal(val, "arredondada", "pt-br canvas.json: markup.tip_round must be 'arredondada'");
});

test("TakeoffCanvas highlighter tip buttons use translated tip names", () => {
  const canvas = loadSrc("src/pages/TakeoffCanvas.jsx");
  // The tip_type tooltip should interpolate the localized tip name via t(`markup.tip_${tip}`)
  assert.match(
    canvas,
    /t\(\s*["']markup\.tip_type["']\s*,\s*\{\s*type:\s*t\(`markup\.tip_\$\{tip\}`\)\s*\}\)/,
    "highlighter tip buttons must use t(`markup.tip_${tip}`) for localized tip names",
  );
});

// ── 12. TOOL_VERB approve mapping + locale key ─────────────────────────────

test("TOOL_VERB maps 'approve' to status.verb.approve", () => {
  const canvas = loadSrc("src/pages/TakeoffCanvas.jsx");
  assert.match(
    canvas,
    /approve:\s*["']status\.verb\.approve["']/,
    "TOOL_VERB must map 'approve' to 'status.verb.approve'",
  );
});

test("en and pt-br canvas.json have status.verb.approve", () => {
  for (const lng of ["en", "pt-br"]) {
    const val = getVal(loadJson(lng, "canvas"), "status.verb.approve");
    assert.ok(val && typeof val === "string" && val.trim(), `${lng}/canvas.json: status.verb.approve missing or empty`);
  }
});

// ── 13. Built-in stamp names localized via shared helper ────────────────────

test("stamps.js exports BUILT_IN_STAMP_IDS map and stampDisplayName helper", () => {
  const stamps = loadSrc("src/lib/stamps.js");
  // BUILT_IN_STAMP_IDS must be a Map from stamp id → i18n key
  assert.match(stamps, /BUILT_IN_STAMP_IDS/, "stamps.js must export BUILT_IN_STAMP_IDS");
  assert.match(stamps, /stamp\.stmp_direction/, "BUILT_IN_STAMP_IDS must map stmp-direction to stamp.stmp_direction");
  assert.match(stamps, /stamp\.stmp_seam/, "BUILT_IN_STAMP_IDS must map stmp-seam to stamp.stmp_seam");
  assert.match(stamps, /stamp\.stmp_origin/, "BUILT_IN_STAMP_IDS must map stmp-origin to stamp.stmp_origin");
  // stampDisplayName must be a function that takes (stamp, t)
  assert.match(stamps, /export\s+function\s+stampDisplayName/, "stamps.js must export stampDisplayName as a function");
  assert.match(stamps, /function\s+stampDisplayName\s*\(\s*stamp\s*,\s*t\s*\)/, "stampDisplayName(stamp, t) signature");
});

test("StampPanel armed message uses shared stampDisplayName helper", () => {
  const src = loadSrc("src/components/StampPanel.jsx");
  // StampPanel must import stampDisplayName from stamps.js
  assert.match(
    src,
    /import\s*\{[^}]*stampDisplayName[^}]*\}\s*from\s*["'][^"']*stamps\.js["']/,
    "StampPanel must import stampDisplayName from stamps.js",
  );
  // The armed message must call stampDisplayName(armedStamp, t) — not a .get() on a map
  assert.match(
    src,
    /stampDisplayName\(\s*armedStamp\s*,\s*t\s*\)/,
    "StampPanel armed message must call stampDisplayName(armedStamp, t)",
  );
});

test("StampPanel rename input uses displayName (localized for built-in, literal for user)", () => {
  const src = loadSrc("src/components/StampPanel.jsx");
  // The rename input defaultValue must use displayName, not raw s.name
  assert.match(
    src,
    /name="stamp-rename"[^>]*defaultValue=\{displayName\}/,
    "StampPanel rename input defaultValue must be `displayName` (localized for built-in stamps)",
  );
  assert.doesNotMatch(
    src,
    /name="stamp-rename"[^>]*defaultValue=\{s\.name\}/,
    "StampPanel rename input must NOT use raw s.name as defaultValue",
  );
});
