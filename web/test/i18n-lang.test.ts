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
