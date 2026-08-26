import test from "node:test";
import assert from "node:assert/strict";
import "./i18n-setup.mjs";

const NAMESPACES = ["canvas", "report", "panels", "guide", "lib"];

test("changing to pt-br resolves Portuguese translations, not English fallback", async () => {
  const { default: i18n } = await import("../src/i18n/index.js");

  await i18n.changeLanguage("pt-br");
  const t = i18n.getFixedT("pt-br");

  // A key that exists in pt-br/canvas.json with a distinct Portuguese value
  const ptbr = t("tool.area");
  assert.equal(ptbr, "Área", `pt-br should resolve "tool.area" to "Área", got "${ptbr}"`);

  // Verify it differs from the English value
  const en = i18n.getFixedT("en")("tool.area");
  assert.notEqual(ptbr, en, "pt-br translation must differ from English");

  // Restore default for other tests
  await i18n.changeLanguage("en");
});

test("fallback: a key missing in pt-br resolves to the English value", async () => {
  const { default: i18n } = await import("../src/i18n/index.js");

  // Inject a synthetic key that only exists in English
  i18n.addResource("en", "canvas", "__test_fallback_key", "Fallback works");

  await i18n.changeLanguage("pt-br");
  const t = i18n.getFixedT("pt-br");

  const val = t("__test_fallback_key");
  assert.equal(val, "Fallback works", "missing pt-br key should fall back to English value");

  // Also confirm tool.area still resolves to pt-br (not fallen back)
  const area = t("tool.area");
  assert.equal(area, "Área", "tool.area should remain pt-br after fallback");

  // Clean up
  i18n.removeResourceBundle("en", "canvas");
  // Re-add the original bundle for downstream tests
  const { readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const root = resolve(process.cwd(), "public", "locales");
  const raw = await readFile(resolve(root, "en", "canvas.json"), "utf8");
  i18n.addResourceBundle("en", "canvas", JSON.parse(raw), true, true);

  await i18n.changeLanguage("en");
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
