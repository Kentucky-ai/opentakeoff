// Modifier-key labels — the one place this app has to know what computer it is
// running on.
//
// Every shortcut in the canvas is already platform-correct in BEHAVIOUR: the
// handlers test `e.metaKey || e.ctrlKey` together, and `altKey` is the same key
// on every platform. What was never correct is the LABEL. The tables, tooltips
// and commit messages were transcribed from a Mac and shipped Mac glyphs —
// so a Windows estimator opening the shortcut list saw ⌘ and ⌥, symbols that
// are not on the keyboard in front of them, describing shortcuts that in fact
// work fine. That reads as "this app is not for me", which is the complaint
// this module exists to remove.
//
// Pure and total: the mapping takes the platform as an argument, so it is
// testable without a DOM and never throws on a server render.

/** Mac glyph → the label the same key carries on a PC keyboard. */
const PC_LABEL: Readonly<Record<string, string>> = Object.freeze({
  "⌘": "Ctrl",       // ⌘ command → control
  "⌥": "Alt",        // ⌥ option  → alt
  "⇧": "Shift",      // ⇧
  "⏎": "Enter",      // ⏎
  "⌫": "Backspace",  // ⌫
});

/** Glyphs that combine into a chord when written adjacently (⇧⌘Z). */
const GLYPHS = "⌘⌥⇧⏎⌫";
const CHORD_RE = new RegExp(`([${GLYPHS}]+)([A-Za-z0-9])?`, "g");

/** True on macOS/iOS/iPadOS, where the Mac glyphs are the right labels.
 *  Defensive: any absent or hostile `navigator` reads as "not Apple", because
 *  spelling out Ctrl/Alt is legible on every platform while ⌘ is not. */
export function isApplePlatform(nav: unknown = typeof navigator === "undefined" ? null : navigator): boolean {
  const n = nav as { platform?: unknown; userAgent?: unknown } | null;
  if (!n) return false;
  const s = `${typeof n.platform === "string" ? n.platform : ""} ${typeof n.userAgent === "string" ? n.userAgent : ""}`;
  return /Mac|iPhone|iPad|iPod/i.test(s);
}

/** One key's label: a lone glyph from a shortcut table. Non-glyphs pass through. */
export function keyLabel(key: string, apple: boolean = isApplePlatform()): string {
  if (apple) return key;
  return PC_LABEL[key] ?? key;
}

/** Glyphs embedded in a sentence — "⌥-click carves…", "one undo step (⌘Z)".
 *  Adjacent glyphs plus an immediately following alphanumeric are one chord,
 *  so ⇧⌘Z becomes Shift+Ctrl+Z rather than three loose words. */
export function keyText(text: string, apple: boolean = isApplePlatform()): string {
  if (apple || !text) return text;
  return String(text).replace(CHORD_RE, (_m, glyphs: string, tail?: string) => {
    const parts = Array.from(glyphs).map((g) => PC_LABEL[g] ?? g);
    if (tail) parts.push(tail);
    return parts.join("+");
  });
}
