import test from "node:test";
import assert from "node:assert/strict";
import { isApplePlatform, keyLabel, keyText } from "../src/lib/keys.ts";

test("apple platforms keep the glyphs they own", () => {
  assert.equal(keyLabel("⌘", true), "⌘");
  assert.equal(keyText("one undo step (⌘Z).", true), "one undo step (⌘Z).");
});

test("each modifier maps to its PC label", () => {
  assert.equal(keyLabel("⌘", false), "Ctrl");
  assert.equal(keyLabel("⌥", false), "Alt");
  assert.equal(keyLabel("⇧", false), "Shift");
  assert.equal(keyLabel("⏎", false), "Enter");
  assert.equal(keyLabel("⌫", false), "Backspace");
});

test("non-modifier keys pass through untouched", () => {
  for (const k of ["D", "Z", "click", "scroll", "hold", "1", "–", "9"]) {
    assert.equal(keyLabel(k, false), k);
    assert.equal(keyLabel(k, true), k);
  }
});

test("adjacent glyphs become one chord, not loose words", () => {
  assert.equal(keyText("⌘Z", false), "Ctrl+Z");
  assert.equal(keyText("⇧⌘Z", false), "Shift+Ctrl+Z");
  assert.equal(keyText("⌘⏎ runs.", false), "Ctrl+Enter runs.");
});

test("a glyph followed by a non-alphanumeric keeps the punctuation", () => {
  assert.equal(keyText("⌥-click carves an enclosed cutout; ⏎ creates.", false),
    "Alt-click carves an enclosed cutout; Enter creates.");
  assert.equal(keyText("⌘/⇧ multi-select", false), "Ctrl/Shift multi-select");
});

test("several chords in one sentence each convert", () => {
  assert.equal(keyText("⧉ Copy / ⎘ Paste (⌘C / ⌘V)", false), "⧉ Copy / ⎘ Paste (Ctrl+C / Ctrl+V)");
});

test("keyText is a no-op on text with no glyphs", () => {
  assert.equal(keyText("Load sample plan", false), "Load sample plan");
  assert.equal(keyText("", false), "");
});

test("platform detection is defensive about a missing or hostile navigator", () => {
  assert.equal(isApplePlatform(null), false);   // explicit "no navigator" ⇒ spell the keys out
  assert.equal(isApplePlatform({}), false);
  assert.equal(isApplePlatform({ platform: 123, userAgent: {} }), false);
  assert.equal(isApplePlatform({ platform: "MacIntel" }), true);
  assert.equal(isApplePlatform({ userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0)" }), true);
  assert.equal(isApplePlatform({ platform: "Win32" }), false);
  assert.equal(isApplePlatform({ platform: "Linux x86_64" }), false);
});
