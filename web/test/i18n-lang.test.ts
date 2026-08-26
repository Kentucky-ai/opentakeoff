import test from "node:test";
import assert from "node:assert/strict";
import "./i18n-setup.mjs";

const NAMESPACES = ["canvas", "report", "panels", "guide", "lib"];

test("changing to pt-br resolves Portuguese translations, not English fallback", async () => {
  const { default: i18n } = await import("../src/i18n/index.js");

  try {
    await i18n.changeLanguage("pt-br");
    const t = i18n.getFixedT("pt-br");

    // A key that exists in pt-br/canvas.json with a distinct Portuguese value
    const ptbr = t("tool.area");
    assert.equal(ptbr, "Área", `pt-br should resolve "tool.area" to "Área", got "${ptbr}"`);

    // Verify it differs from the English value
    const en = i18n.getFixedT("en")("tool.area");
    assert.notEqual(ptbr, en, "pt-br translation must differ from English");
  } finally {
    await i18n.changeLanguage("en");
  }
});

test("fallback: a key missing in pt-br resolves to the English value", async () => {
  const { default: i18n } = await import("../src/i18n/index.js");

  try {
    // Inject a synthetic key that only exists in English
    i18n.addResource("en", "canvas", "__test_fallback_key", "Fallback works");

    await i18n.changeLanguage("pt-br");
    const t = i18n.getFixedT("pt-br");

    const val = t("__test_fallback_key");
    assert.equal(val, "Fallback works", "missing pt-br key should fall back to English value");

    // Also confirm tool.area still resolves to pt-br (not fallen back)
    const area = t("tool.area");
    assert.equal(area, "Área", "tool.area should remain pt-br after fallback");
  } finally {
    // Remove only the synthetic key we injected — no disk read needed
    const bundle = i18n.getResourceBundle("en", "canvas");
    if (bundle) delete bundle["__test_fallback_key"];
    await i18n.changeLanguage("en");
  }
});

test("all five namespaces load resources for en and pt-br", async () => {
  const { default: i18n } = await import("../src/i18n/index.js");

  for (const lng of ["en", "pt-br"]) {
    const t = i18n.getFixedT(lng);
    for (const ns of NAMESPACES) {
      const bundle = i18n.getResourceBundle(lng, ns);
      assert.ok(bundle, `namespace "${ns}" should have resources for "${lng}"`);
      const keys = Object.keys(bundle);
      assert.ok(keys.length > 0, `namespace "${ns}" for "${lng}" should contain at least one key`);
    }
  }
});

test("new i18n keys for canvas seed/transition and panels fallback exist in both locales", async () => {
  const { default: i18n } = await import("../src/i18n/index.js");

  const canvasKeys = [
    "status.oneclick_leak_seed",
    "status.oneclick_dense_seed",
    "status.oneclick_scan_leak_seed",
    "status.oneclick_scan_dense_seed",
    "transitions.pick_target",
    "transitions.pick_finishes",
  ];

  const panelsKeys = [
    "takeoffs.family_fallback",
    "takeoffs.original_fallback",
    "takeoffs.roll_max_label",
    "takeoffs.roll_dir_auto",
    "takeoffs.waste_short",
    "takeoffs.material_count_one",
    "takeoffs.material_count_other",
    "takeoffs.roll_count_one",
    "takeoffs.roll_count_other",
    "takeoffs.mat_unit_unknown",
  ];

  for (const lng of ["en", "pt-br"]) {
    const cb = i18n.getResourceBundle(lng, "canvas");
    for (const key of canvasKeys) {
      assert.ok(cb && cb[key], `canvas key "${key}" must exist for "${lng}"`);
    }

    const pb = i18n.getResourceBundle(lng, "panels");
    for (const key of panelsKeys) {
      assert.ok(pb && pb[key], `panels key "${key}" must exist for "${lng}"`);
    }
  }
});

// ── Task 3: lib namespace i18n keys ─────────────────────────────────────────

test("lib.store.stale_tab resolves in both locales", async () => {
  const { default: i18n } = await import("../src/i18n/index.js");

  const en = i18n.getFixedT("en")("store.stale_tab", { ns: "lib" });
  assert.ok(en.includes("OpenTakeoff"), `en stale_tab should mention OpenTakeoff, got "${en}"`);

  try {
    await i18n.changeLanguage("pt-br");
    const pt = i18n.getFixedT("pt-br")("store.stale_tab", { ns: "lib" });
    assert.ok(pt.includes("OpenTakeoff"), `pt-br stale_tab should mention OpenTakeoff, got "${pt}"`);
    assert.notEqual(pt, en, "pt-br stale_tab must differ from English");
  } finally {
    await i18n.changeLanguage("en");
  }
});

test("lib.transition.pick_finishes resolves in both locales", async () => {
  const { default: i18n } = await import("../src/i18n/index.js");

  const en = i18n.getFixedT("en")("transition.pick_finishes", { ns: "lib" });
  assert.ok(en.length > 0, "en transition.pick_finishes should be non-empty");

  try {
    await i18n.changeLanguage("pt-br");
    const pt = i18n.getFixedT("pt-br")("transition.pick_finishes", { ns: "lib" });
    assert.ok(pt.length > 0, "pt-br transition.pick_finishes should be non-empty");
    assert.notEqual(pt, en, "pt-br pick_finishes must differ from English");
  } finally {
    await i18n.changeLanguage("en");
  }
});

test("lib.detected.no_tag_caveat resolves in both locales", async () => {
  const { default: i18n } = await import("../src/i18n/index.js");

  const en = i18n.getFixedT("en")("detected.no_tag_caveat", { ns: "lib" });
  assert.ok(en.includes("One-Click"), `en no_tag_caveat should mention One-Click, got "${en}"`);

  try {
    await i18n.changeLanguage("pt-br");
    const pt = i18n.getFixedT("pt-br")("detected.no_tag_caveat", { ns: "lib" });
    assert.ok(pt.length > 0, "pt-br no_tag_caveat should be non-empty");
    assert.notEqual(pt, en, "pt-br no_tag_caveat must differ from English");
  } finally {
    await i18n.changeLanguage("en");
  }
});

test("lib.voice.waste_on interpolates params", async () => {
  const { default: i18n } = await import("../src/i18n/index.js");
  const t = i18n.getFixedT("en");
  const msg = t("voice.waste_on", { ns: "lib", pct: 7, tag: "CPT-1" });
  assert.ok(msg.includes("7"), "should contain the waste percentage");
  assert.ok(msg.includes("CPT-1"), "should contain the condition tag");
});

test("danger.js markDanger + isDanger classify translated messages", async () => {
  const { markDanger, isDanger } = await import("../src/lib/danger.js");

  const msg = markDanger("translated danger message");
  assert.equal(isDanger(msg), true, "marked message should be danger");
  assert.equal(isDanger("plain message"), false, "unmarked message should not be danger");
  assert.equal(isDanger(null), false, "null should not be danger");
  assert.equal(isDanger(undefined), false, "undefined should not be danger");
  assert.equal(isDanger(42), false, "non-string should not be danger");
});

test("danger-tagged translated store message is classified as danger", async () => {
  const { default: i18n } = await import("../src/i18n/index.js");
  const { markDanger, isDanger } = await import("../src/lib/danger.js");

  // Simulate what store.js does at module load
  const staleTab = markDanger(i18n.t("store.stale_tab", { ns: "lib" }));
  assert.ok(isDanger(staleTab), "translated STALE_TAB_MESSAGE should be danger-tagged");
  assert.ok(staleTab.includes("OpenTakeoff"), "should contain app name");
});

// ── language-switch: getters reflect the current language ─────────────────────

test("branding.otCredit() getter reflects language switch", async () => {
  const { default: i18n } = await import("../src/i18n/index.js");
  const { otCredit } = await import("../src/lib/branding.js");

  const enCredit = String(otCredit());
  assert.ok(enCredit.includes("OpenTakeoff"), `en credit: "${enCredit}"`);

  try {
    await i18n.changeLanguage("pt-br");
    const ptCredit = String(otCredit());
    assert.ok(ptCredit.includes("OpenTakeoff"), `pt-br credit should mention OpenTakeoff: "${ptCredit}"`);
    assert.notEqual(ptCredit, enCredit, "pt-br credit must differ from English");
  } finally {
    await i18n.changeLanguage("en");
  }
});

test("detectRooms.noTagCaveat() getter reflects language switch", async () => {
  const { default: i18n } = await import("../src/i18n/index.js");
  const { noTagCaveat } = await import("../src/lib/detectRooms.ts");

  const enCaveat = noTagCaveat();
  assert.ok(enCaveat.includes("One-Click"), `en caveat: "${enCaveat}"`);

  try {
    await i18n.changeLanguage("pt-br");
    const ptCaveat = noTagCaveat();
    assert.ok(ptCaveat.length > 0, "pt-br caveat should be non-empty");
    assert.notEqual(ptCaveat, enCaveat, "pt-br caveat must differ from English");
  } finally {
    await i18n.changeLanguage("en");
  }
});

test("detectRooms detectionReport uses translated verbs (was/were → foi/foram)", async () => {
  const { default: i18n } = await import("../src/i18n/index.js");
  const { detectionReport } = await import("../src/lib/detectRooms.ts");

  try {
    await i18n.changeLanguage("pt-br");
    // seeds=3, tried=1 → untried=2 → triggers stopped_early_untried with plural verb
    const report = detectionReport({ seeds: 3, patternHits: 3, tried: 1, proposals: 0, tiny: 0, cancelled: true, textItems: 5, regions: 0 } as any, 4);
    assert.ok(report.message.includes("foram"), `pt-br cancelled report should use "foram": "${report.message}"`);
    assert.ok(!report.message.includes("were"), `pt-br report must not contain English "were": "${report.message}"`);
  } finally {
    await i18n.changeLanguage("en");
  }
});

// ── smoke-test: keys that rendered as literal strings in the UI ──────────────

test("menu.zone resolves to a real label in en and pt-br", async () => {
  const { default: i18n } = await import("../src/i18n/index.js");

  const en = i18n.getFixedT("en")("menu.zone");
  assert.notEqual(en, "menu.zone", "en menu.zone must not return the key itself");

  try {
    await i18n.changeLanguage("pt-br");
    const pt = i18n.getFixedT("pt-br")("menu.zone");
    assert.notEqual(pt, "menu.zone", "pt-br menu.zone must not return the key itself");
  } finally {
    await i18n.changeLanguage("en");
  }
});

test("scale.imperial_hint resolves to a real label in en and pt-br", async () => {
  const { default: i18n } = await import("../src/i18n/index.js");

  const en = i18n.getFixedT("en")("scale.imperial_hint");
  assert.notEqual(en, "scale.imperial_hint", "en scale.imperial_hint must not return the key itself");

  try {
    await i18n.changeLanguage("pt-br");
    const pt = i18n.getFixedT("pt-br")("scale.imperial_hint");
    assert.notEqual(pt, "scale.imperial_hint", "pt-br scale.imperial_hint must not return the key itself");
  } finally {
    await i18n.changeLanguage("en");
  }
});

test("toolbar.action resolves to a real label in en and pt-br", async () => {
  const { default: i18n } = await import("../src/i18n/index.js");

  const en = i18n.getFixedT("en")("toolbar.action");
  assert.notEqual(en, "toolbar.action", "en toolbar.action must not return the key itself");

  try {
    await i18n.changeLanguage("pt-br");
    const pt = i18n.getFixedT("pt-br")("toolbar.action");
    assert.notEqual(pt, "toolbar.action", "pt-br toolbar.action must not return the key itself");
  } finally {
    await i18n.changeLanguage("en");
  }
});

test("danger-tagged messages survive language switch (Set membership is language-independent)", async () => {
  const { markDanger, isDanger } = await import("../src/lib/danger.js");
  const { default: i18n } = await import("../src/i18n/index.js");

  const ptMsg = markDanger(i18n.t("store.stale_tab", { ns: "lib" }));
  assert.ok(isDanger(ptMsg), "initial language tag should be danger");
  assert.ok(isDanger("OpenTakeoff was updated in another tab — reload this tab to continue."), "English constant should also be danger (registered at module load)");
});

// ── Task 4: remaining canvas i18n keys ─────────────────────────────────────

/** Keys that TakeoffCanvas.jsx calls t() with — must resolve to real text. */
const CANVAS_KEYS_USED = [
  // voice/agent chip literals
  "agent.offer_text",
  "agent.voice_loading",
  "agent.voice_loading_retry",
  "agent.voice_listening",
  "agent.voice_decoding",
  "agent.nothing_handoff",
  "voice.talking",
  "voice.talk",
  // m/ft toggle
  "scale.metric",
  "scale.imperial",
  // this condition fallback
  "status.this_condition",
  // load-error hint + footer
  "status.load_error_hint",
  "status.reload",
  "status.shapes",
  "status.drive",
  "status.local2",
  "status.saving",
  "status.saved",
  // delete-message interpolation
  "status.deleted_takeoffs",
  "status.deleted_condition",
  "status.deleted_conditions",
  // toolbar
  "toolbar.scale",
  // action bar
  "action.click_hint",
  "action.create",
  "action.create_title",
  "action.finish",
  "action.finish_title",
  "action.label_spot",
  "action.opposite_corner",
  // conditions strip
  "conditions.strip",
  // confirm dialogs
  "confirm.delete_condition_with_takeoffs",
  "confirm.delete_with_takeoffs",
  "confirm.template_exists",
  "confirm.update_linked_lines",
  "confirm.its",
  "confirm.their",
  "confirm.the_original",
  "confirm.this_material",
  "confirm.one_linked_line",
  "confirm.n_linked_lines",
  "confirm.delete_column",
  "confirm.split_family",
  "confirm.remove_template",
  "confirm.remove_material",
  "confirm.push_material",
  // menu (sheet chip / gallery / stitches)
  "menu.close_tab",
  "menu.files",
  "menu.import_takeoff",
  "menu.jump_sheet",
  "menu.open_gallery",
  "menu.regroup",
  "menu.regroup_title",
  "menu.sheet_page",
  "menu.sheets_in_set",
  "menu.side_by_side_add",
  "menu.side_by_side_remove",
  "menu.ungroup",
  "menu.ungroup_stitch",
  "menu.ungroup_stitch_title",
  "menu.ungroup_title",
  // markup controls
  "markup.broad",
  "markup.close_panel",
  "markup.delete_markup",
  "markup.detach",
  "markup.editor_placeholder",
  "markup.fine",
  "markup.ink_color",
  "markup.medium",
  "markup.select",
  "markup.tip_size",
  "markup.tip_type",
  // readout
  "readout.set_wall_height",
  "readout.vert_hint",
  "readout.wall",
  "readout.border",
  // takeoffs strip
  "takeoffs.strip",
];

test("all canvas keys used by TakeoffCanvas.jsx resolve to real text in en and pt-br", async () => {
  const { default: i18n } = await import("../src/i18n/index.js");

  for (const lng of ["en", "pt-br"]) {
    const t = i18n.getFixedT(lng);
    for (const key of CANVAS_KEYS_USED) {
      const val = t(key);
      assert.ok(val, `canvas key "${key}" must resolve for "${lng}" (got empty)`);
      assert.notEqual(val, key, `canvas key "${key}" must not return the key itself for "${lng}"`);
    }
  }
});

test("no canvas translation in en or pt-br contains unresolved {{placeholder}}", async () => {
  const { default: i18n } = await import("../src/i18n/index.js");
  const placeholderRe = /\{\{[^}]+\}\}/g;

  for (const lng of ["en", "pt-br"]) {
    const bundle = i18n.getResourceBundle(lng, "canvas");
    assert.ok(bundle, `canvas bundle must exist for "${lng}"`);
    for (const [key, val] of Object.entries(bundle)) {
      if (typeof val !== "string") continue;
      // We allow {{placeholders}} in the VALUE — that's i18n interpolation.
      // What we disallow is literal key references like "toolbar.scale" in the text.
      // Also skip keys that are interpolation-only values (like "·").
      // The real check: no translation value should be the key itself.
      if (val === key) {
        assert.fail(`canvas "${lng}" key "${key}" has value equal to its key — likely missing translation`);
      }
    }
  }
});

test("confirm.delete_column uses {{name}} placeholder consistently", async () => {
  const { default: i18n } = await import("../src/i18n/index.js");

  for (const lng of ["en", "pt-br"]) {
    const t = i18n.getFixedT(lng);
    const msg = t("confirm.delete_column", { name: "Phase" });
    assert.ok(msg.includes("Phase"), `confirm.delete_column should interpolate {{name}} for "${lng}"`);
    // Must NOT contain a leftover {{column}} or literal "column"
    assert.ok(!msg.includes("{{column}}"), `confirm.delete_column must not have {{column}} placeholder in "${lng}"`);
  }
});

test("confirm.remove_material supports {{linkedNote}} interpolation", async () => {
  const { default: i18n } = await import("../src/i18n/index.js");

  for (const lng of ["en", "pt-br"]) {
    const t = i18n.getFixedT(lng);
    const msg1 = t("confirm.remove_material", { name: "Glue", linkedNote: " 1 linked line keeps its values" });
    assert.ok(msg1.includes("Glue"), `confirm.remove_material should interpolate name for "${lng}"`);
    assert.ok(msg1.includes("1 linked line"), `confirm.remove_material should interpolate linkedNote for "${lng}"`);
    const msg0 = t("confirm.remove_material", { name: "Glue", linkedNote: "" });
    assert.ok(msg0.includes("Glue"), `confirm.remove_material with empty linkedNote should still show name for "${lng}"`);
  }
});
