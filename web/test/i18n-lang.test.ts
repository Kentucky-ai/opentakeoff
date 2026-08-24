import test from "node:test";
import assert from "node:assert/strict";
import "./i18n-setup.mjs";

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

test("lowerCaseLng normalizes detected codes to lowercase locale dirs", async () => {
  const { default: i18n } = await import("../src/i18n/index.js");

  // Simulate what happens when the browser reports "PT-BR" or "pt-BR"
  // i18next with lowerCaseLng should normalise to "pt-br"
  await i18n.changeLanguage("PT-BR");
  assert.equal(i18n.language, "pt-br", "language code should be normalised to lowercase pt-br");

  const t = i18n.getFixedT("pt-br");
  const val = t("tool.area");
  assert.equal(val, "Área", "lowercased pt-br should still resolve Portuguese");

  await i18n.changeLanguage("en");
});
