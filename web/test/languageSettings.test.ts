// LanguageSettings — tests for SUPPORTED_LANGUAGES constant, locale key
// coverage, and the LanguageSettings component's accessibility contract.
import test from "node:test";
import assert from "node:assert/strict";
import "./i18n-setup.mjs";

// ── SUPPORTED_LANGUAGES constant ─────────────────────────────────────────────

test("SUPPORTED_LANGUAGES is exported and contains en and pt-br", async () => {
  const { SUPPORTED_LANGUAGES } = await import("../src/i18n/index.js");
  assert.ok(Array.isArray(SUPPORTED_LANGUAGES), "should be an array");
  const codes = SUPPORTED_LANGUAGES.map((l) => l.code);
  assert.ok(codes.includes("en"), "should include en");
  assert.ok(codes.includes("pt-br"), "should include pt-br");
});

test("SUPPORTED_LANGUAGES drives i18next supportedLngs", async () => {
  const { default: i18n, SUPPORTED_LANGUAGES } = await import("../src/i18n/index.js");
  const expected = SUPPORTED_LANGUAGES.map((l) => l.code);
  // i18next lowercases, so compare lowercased
  const supportedLngs = i18n.options.supportedLngs as readonly string[];
  const actual = supportedLngs.map((l: string) => l.toLowerCase());
  for (const code of expected) {
    assert.ok(actual.includes(code), `supportedLngs should include ${code}`);
  }
});

// ── Locale key coverage ──────────────────────────────────────────────────────

test("en/panels.json has all language.* keys", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.resolve(import.meta.dirname, "..");
  const enPanels = JSON.parse(
    fs.readFileSync(path.join(root, "public", "locales", "en", "panels.json"), "utf8")
  );
  const requiredKeys = [
    "language.title",
    "language.description",
    "language.legend",
    "language.note",
    "language.close",
  ];
  for (const key of requiredKeys) {
    assert.ok(
      typeof enPanels[key] === "string" && enPanels[key].length > 0,
      `en/panels.json should have non-empty key "${key}"`
    );
  }
});

test("pt-br/panels.json has all language.* keys", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.resolve(import.meta.dirname, "..");
  const ptPanels = JSON.parse(
    fs.readFileSync(path.join(root, "public", "locales", "pt-br", "panels.json"), "utf8")
  );
  const requiredKeys = [
    "language.title",
    "language.description",
    "language.legend",
    "language.note",
    "language.close",
  ];
  for (const key of requiredKeys) {
    assert.ok(
      typeof ptPanels[key] === "string" && ptPanels[key].length > 0,
      `pt-br/panels.json should have non-empty key "${key}"`
    );
  }
});

// ── i18next translation resolution ───────────────────────────────────────────

test("language keys resolve to distinct values in en vs pt-br", async () => {
  const { default: i18n } = await import("../src/i18n/index.js");

  const enT = i18n.getFixedT("en", "panels");
  const ptT = i18n.getFixedT("pt-br", "panels");

  const keys = ["language.title", "language.close"];
  for (const key of keys) {
    const enVal = enT(key);
    const ptVal = ptT(key);
    assert.ok(enVal.length > 0, `en "${key}" should be non-empty`);
    assert.ok(ptVal.length > 0, `pt-br "${key}" should be non-empty`);
    assert.notEqual(enVal, ptVal, `"${key}" should differ between en and pt-br`);
  }
});

// ── LanguageSettings component accessibility ──────────────────────────────────

test("LanguageSettings component file exists and has expected structure", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.resolve(import.meta.dirname, "..");
  const src = fs.readFileSync(
    path.join(root, "src", "components", "LanguageSettings.jsx"),
    "utf8"
  );
  assert.ok(src.includes("export default function LanguageSettings"), "should export a default function component");
  assert.ok(src.includes("useTranslation"), "should use useTranslation hook");
  assert.ok(src.includes("SUPPORTED_LANGUAGES"), "should reference SUPPORTED_LANGUAGES");
});

// ── LanguageSettings mirrors UnitSettings accessibility contract ───────────────

test("LanguageSettings source includes role=dialog and aria-modal", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.resolve(import.meta.dirname, "..");
  const src = fs.readFileSync(
    path.join(root, "src", "components", "LanguageSettings.jsx"),
    "utf8"
  );
  assert.ok(src.includes('role="dialog"'), "should have role=dialog");
  assert.ok(src.includes('aria-modal="true"'), "should have aria-modal=true");
  assert.ok(src.includes("aria-labelledby"), "should have aria-labelledby");
  assert.ok(src.includes("aria-describedby"), "should have aria-describedby");
});

test("LanguageSettings source includes focus trap for Tab/Shift+Tab", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.resolve(import.meta.dirname, "..");
  const src = fs.readFileSync(
    path.join(root, "src", "components", "LanguageSettings.jsx"),
    "utf8"
  );
  assert.ok(src.includes("Shift+Tab") || src.includes("shiftKey"), "should handle Shift+Tab");
  assert.ok(src.includes('"Tab"'), "should handle Tab key");
});

test("LanguageSettings source restores focus to triggerRef on unmount", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.resolve(import.meta.dirname, "..");
  const src = fs.readFileSync(
    path.join(root, "src", "components", "LanguageSettings.jsx"),
    "utf8"
  );
  assert.ok(src.includes("trigger.focus()") || src.includes("triggerRef"), "should restore focus to trigger");
});

// ── LanguageSettings renders radio buttons from SUPPORTED_LANGUAGES ───────────

test("LanguageSettings source maps SUPPORTED_LANGUAGES into radio inputs", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.resolve(import.meta.dirname, "..");
  const src = fs.readFileSync(
    path.join(root, "src", "components", "LanguageSettings.jsx"),
    "utf8"
  );
  assert.ok(src.includes('type="radio"'), "should render radio inputs");
  assert.ok(src.includes("SUPPORTED_LANGUAGES"), "should reference SUPPORTED_LANGUAGES");
  assert.ok(src.includes(".map("), "should map over the list");
});

// ── TakeoffCanvas uses the modal, not a direct toggle ────────────────────────

test("TakeoffCanvas imports LanguageSettings and uses controlled modal state", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.resolve(import.meta.dirname, "..");
  const src = fs.readFileSync(
    path.join(root, "src", "pages", "TakeoffCanvas.jsx"),
    "utf8"
  );
  assert.ok(src.includes('import LanguageSettings'), "should import LanguageSettings");
  assert.ok(src.includes("showLanguageSettings"), "should have showLanguageSettings state");
  assert.ok(src.includes("<LanguageSettings"), "should render the LanguageSettings component");
});

test("TakeoffCanvas no longer has a direct one-click i18n.changeLanguage toggle in the tool menu", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.resolve(import.meta.dirname, "..");
  const src = fs.readFileSync(
    path.join(root, "src", "pages", "TakeoffCanvas.jsx"),
    "utf8"
  );
  // The old pattern was: onSelect: () => i18n.changeLanguage(...)
  // The new pattern is:  onSelect: () => setShowLanguageSettings(true)
  // Find the "language" menu item and verify it opens the modal.
  const langIdx = src.indexOf('id: "language"');
  assert.ok(langIdx >= 0, "should find the language menu item");
  // Grab the next 300 chars which contain the full item including onSelect
  const langSection = src.slice(langIdx, langIdx + 300);
  assert.ok(
    langSection.includes("setShowLanguageSettings(true)"),
    `language menu item onSelect should open the modal, got: ${langSection.slice(0, 200)}`
  );
  // Verify no changeLanguage call in the item's onSelect
  const onSelectEnd = langSection.indexOf("}", langSection.indexOf("onSelect"));
  const onSelectBody = langSection.slice(0, onSelectEnd > 0 ? onSelectEnd : 300);
  assert.ok(
    !onSelectBody.includes("changeLanguage"),
    "language menu item should not directly call changeLanguage"
  );
});

// ── Canvas namespace: menu.language key (Finding 1) ──────────────────────────

test("en/canvas.json has menu.language and menu.language_label keys", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.resolve(import.meta.dirname, "..");
  const enCanvas = JSON.parse(
    fs.readFileSync(path.join(root, "public", "locales", "en", "canvas.json"), "utf8")
  );
  assert.ok(typeof enCanvas["menu.language"] === "string" && enCanvas["menu.language"].length > 0,
    'en/canvas.json should have non-empty "menu.language"');
  assert.ok(typeof enCanvas["menu.language_label"] === "string" && enCanvas["menu.language_label"].length > 0,
    'en/canvas.json should have non-empty "menu.language_label"');
  assert.ok(enCanvas["menu.language_label"].includes("{{name}}"),
    'en/canvas.json "menu.language_label" should contain {{name}} interpolation');
});

test("pt-br/canvas.json has menu.language and menu.language_label keys", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.resolve(import.meta.dirname, "..");
  const ptCanvas = JSON.parse(
    fs.readFileSync(path.join(root, "public", "locales", "pt-br", "canvas.json"), "utf8")
  );
  assert.ok(typeof ptCanvas["menu.language"] === "string" && ptCanvas["menu.language"].length > 0,
    'pt-br/canvas.json should have non-empty "menu.language"');
  assert.ok(typeof ptCanvas["menu.language_label"] === "string" && ptCanvas["menu.language_label"].length > 0,
    'pt-br/canvas.json should have non-empty "menu.language_label"');
  assert.ok(ptCanvas["menu.language_label"].includes("{{name}}"),
    'pt-br/canvas.json "menu.language_label" should contain {{name}} interpolation');
});

test("TakeoffCanvas language menu item uses canvas namespace key, not panels namespace", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.resolve(import.meta.dirname, "..");
  const src = fs.readFileSync(
    path.join(root, "src", "pages", "TakeoffCanvas.jsx"),
    "utf8"
  );
  // Should use menu.language or menu.language_label (canvas namespace)
  assert.ok(src.includes("menu.language_label") || src.includes("menu.language"),
    "should use menu.language_label or menu.language from canvas namespace");
  // Should NOT use language.title (panels namespace) for the menu label
  const langItemMatch = src.match(
    /\{\s*id:\s*"language"[^}]*label:\s*([^,}]+)\s*[,}]/
  );
  assert.ok(langItemMatch, "should find the language menu item with label");
  const labelExpr = langItemMatch[1];
  assert.ok(!labelExpr.includes("language.title"),
    `language menu label should not use panels namespace "language.title", got: ${labelExpr}`);
});

// ── Language action label uses t('menu.language') ──────────────────────────

test("TakeoffCanvas language menu item label uses t('menu.language')", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.resolve(import.meta.dirname, "..");
  const src = fs.readFileSync(
    path.join(root, "src", "pages", "TakeoffCanvas.jsx"),
    "utf8"
  );
  // Find the language menu item — label must use the menu.language key
  const langItemMatch = src.match(
    /\{\s*id:\s*"language"[^}]*label:\s*([^,}]+)\s*[,}]/
  );
  assert.ok(langItemMatch, "should find the language menu item with label");
  const labelExpr = langItemMatch[1];
  assert.ok(
    labelExpr.includes("menu.language"),
    `language menu label should use t('menu.language'), got: ${labelExpr}`
  );
});

// ── ToolMenu accepts triggerRef prop ───────────────────────────────────────

test("ToolMenu accepts and attaches optional triggerRef prop to trigger button", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.resolve(import.meta.dirname, "..");
  const src = fs.readFileSync(
    path.join(root, "src", "components", "ToolMenu.jsx"),
    "utf8"
  );
  // Should destructure triggerRef in props
  assert.ok(src.includes("triggerRef"), "ToolMenu should accept a triggerRef prop");
  // Should attach it to the trigger <button>
  assert.ok(
    src.includes("<button ref={triggerRef}") || src.includes("<button\n ref={triggerRef}") || src.includes("<button ref={triggerRef}\n"),
    "ToolMenu should attach triggerRef to the trigger button element"
  );
});

// ── TakeoffCanvas removes unused i18n import (Finding 5) ────────────────────

test("TakeoffCanvas does not import default i18n (unused)", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.resolve(import.meta.dirname, "..");
  const src = fs.readFileSync(
    path.join(root, "src", "pages", "TakeoffCanvas.jsx"),
    "utf8"
  );
  // Should not have: import i18n from "../i18n/index.js"
  assert.ok(!src.includes('import i18n from "../i18n/index.js"'),
    "should not have unused default i18n import");
  // Should not have: import i18n from '../../i18n/index.js' etc.
  assert.ok(!src.match(/import\s+i18n\s+from\s+["'].*i18n\/index/),
    "should not import i18n as default from any i18n/index path");
});

// ── LanguageSettings calls onClose after language selection (Finding 2) ──────

test("LanguageSettings calls onClose after successful language change", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.resolve(import.meta.dirname, "..");
  const src = fs.readFileSync(
    path.join(root, "src", "components", "LanguageSettings.jsx"),
    "utf8"
  );
  // The onChange handler for radio inputs should call both changeLanguage and onClose
  assert.ok(src.includes("changeLanguage") && src.includes("onClose"),
    "should call both changeLanguage and onClose in the radio onChange handler");
  // Verify the pattern: onChange={() => { i18n.changeLanguage(...); onClose(); }}
  assert.ok(
    /onChange.*changeLanguage[\s\S]*?onClose/.test(src) ||
    /changeLanguage[\s\S]{0,200}?onClose/.test(src),
    "onClose should be called after changeLanguage in the same handler"
  );
});

// ── LanguageSettings triggerRef wired to DOM (Finding 3) ────────────────────

test("TakeoffCanvas wires languageSettingsTriggerRef via ToolMenu triggerRef prop", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.resolve(import.meta.dirname, "..");
  const src = fs.readFileSync(
    path.join(root, "src", "pages", "TakeoffCanvas.jsx"),
    "utf8"
  );
  // languageSettingsTriggerRef should be passed to the overflow ToolMenu via triggerRef prop
  assert.ok(src.includes('triggerRef={languageSettingsTriggerRef}'),
    "languageSettingsTriggerRef should be passed via triggerRef prop to ToolMenu and/or LanguageSettings");
  // Should also be passed as triggerRef to the LanguageSettings component
  assert.ok(src.includes('triggerRef={languageSettingsTriggerRef}'),
    "languageSettingsTriggerRef should be passed to LanguageSettings as triggerRef prop");
  // The old hidden dummy button pattern should be removed
  assert.ok(
    !src.includes('aria-hidden="true"') || !src.match(/ref=\{languageSettingsTriggerRef\}[^>]*aria-hidden="true"/),
    "should no longer have a visually-hidden anchor button with the ref (replaced by ToolMenu triggerRef)"
  );
});

// ── TakeoffCanvas imports SUPPORTED_LANGUAGES for current-language marker ────

test("TakeoffCanvas imports SUPPORTED_LANGUAGES from i18n module", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.resolve(import.meta.dirname, "..");
  const src = fs.readFileSync(
    path.join(root, "src", "pages", "TakeoffCanvas.jsx"),
    "utf8"
  );
  assert.ok(src.includes('SUPPORTED_LANGUAGES') && src.includes('from "../i18n/index.js"'),
    "should import SUPPORTED_LANGUAGES from i18n/index.js");
});
