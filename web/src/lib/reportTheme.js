// Report theme import — map an external design-token file (Claude Design's
// DTCG-flavored tokens.json) onto the small internal theme model the report and
// marked-set renderers consume, then project that model onto the app's real CSS
// custom-property names.
//
// The internal model is deliberately tiny and PARTIAL: only the brand primitives
// a document needs (color roles + font families). Anything the source omits is
// left unset so the renderers fall back to the tokens.css defaults.

// Canonical #RRGGBB (uppercase). Accepts "#abc", "abc", "#aabbcc", "AABBCC".
// Returns null for anything that isn't a 3- or 6-digit hex triple.
export function normalizeHex(raw) {
  const s = String(raw ?? "").trim().replace(/^#/, "");
  const hex = s.length === 3 ? s.split("").map((c) => c + c).join("") : s;
  return /^[0-9a-fA-F]{6}$/.test(hex) ? "#" + hex.toUpperCase() : null;
}

/**
 * @typedef {{ ink?: string, accent?: string, paper?: string, paper2?: string, paper3?: string, positive?: string, warning?: string, danger?: string }} ThemeColor
 * @typedef {{ display?: string, body?: string, mono?: string }} ThemeFont
 * @typedef {{ name?: string, color: ThemeColor, font: ThemeFont }} Theme
 */

// ── importer ────────────────────────────────────────────────────────────────
// parseThemeFile(json) -> { theme, warnings }
//   theme.color: { ink, accent, paper, positive, warning, danger }  (present-only)
//   theme.font:  { display, body, mono }                            (present-only)
/** @param {any} json @returns {{ theme: Theme, warnings: string[] }} */
export function parseThemeFile(json) {
  const color = {};
  const font = {};

  const warnings = [];
  /** @type {Theme} */
  const theme = { color, font };
  if (typeof json?.name === "string" && json.name.trim()) theme.name = json.name.trim();

  const neutral = json?.color?.neutral || {};
  // a role that's ABSENT is silently skipped (partial themes are normal); a role
  // that's PRESENT but unparseable is a real authoring mistake — warn and omit
  const setColor = (role, raw) => {
    if (raw == null) return;
    const h = normalizeHex(raw);
    if (h) color[role] = h;
    else warnings.push(`color.${role}: "${raw}" is not a hex color — skipped`);
  };
  setColor("ink", neutral.ink?.value);
  // the neutral paper scale: base / raised / pressed — maps to bright/cream/shadow
  setColor("paper", neutral.paper?.value);
  setColor("paper2", neutral["paper-2"]?.value);
  setColor("paper3", neutral["paper-3"]?.value);

  // accents live in one or more `accent-*` groups (brand-specific naming like
  // accent-345 / accent-fin). We don't hard-code brands — classify each token by
  // its color NAME and take the first match for each semantic role, so 345+Fin
  // (or any producer) map without configuration. A token that classifies to a
  // role already filled is skipped (first-wins), which is why group + token order
  // is honored.
  const classify = (key) =>
    // "blueprint" is a wash tone, not the brand accent — exclude it so a
    // blueprint-before-blue ordering can't steal the accent role (first-wins)
    (/blue/i.test(key) && !/blueprint/i.test(key)) ? "accent"
    : /green/i.test(key) ? "positive"
    : /(orange|amber|gold|yellow)/i.test(key) ? "warning"
    : /(red|danger|error)/i.test(key) ? "danger"
    : null;
  for (const [group, tokens] of Object.entries(json?.color || {})) {
    if (!/^accent/i.test(group) || !tokens || typeof tokens !== "object") continue;
    for (const [key, tok] of Object.entries(tokens)) {
      const role = classify(key);
      if (role && color[role] === undefined) setColor(role, tok?.value);
    }
  }

  const web = json?.font?.family?.web || {};
  for (const role of ["display", "body", "mono"]) {
    if (typeof web[role] === "string" && web[role].trim()) font[role] = web[role].trim();
  }

  return { theme, warnings };
}

// ── CSS adapter ───────────────────────────────────────────────────────────────
// Internal role → the app's real tokens.css custom property. This is the ONE
// place that knows the app's variable names, so the model stays app-agnostic and
// reusable (the future estimating module maps through the same table).
// simple 1:1 roles; the paper scale is handled separately (1 role → 2-3 vars).
const COLOR_VARS = {
  ink: "--ink",
  accent: "--cobalt",
  positive: "--c-positive",
  warning: "--c-warning",
  danger: "--c-danger",
};
const FONT_VARS = { display: "--f-display", body: "--f-body", mono: "--f-mono" };

// themeToCssVars(theme) -> { "--ink": "#…", … } — present-only, so an absent role
// leaves the tokens.css default in place (partial override).
/** @param {Theme} theme @returns {Record<string, string>} */
export function themeToCssVars(theme) {
  const out = {};
  const color = theme?.color || {};
  for (const [role, varName] of Object.entries(COLOR_VARS)) {
    if (color[role]) out[varName] = color[role];
  }
  // paper scale → base/raised/pressed. A lone `paper` also seeds --paper-cream
  // (the report backdrop + totals band + group heads all read --paper-cream), so
  // those surfaces recolor with the tables instead of stranding on the default.
  if (color.paper) { out["--paper-bright"] = color.paper; out["--paper-cream"] = color.paper; }
  if (color.paper2) out["--paper-cream"] = color.paper2;
  if (color.paper3) out["--paper-shadow"] = color.paper3;
  const font = theme?.font || {};
  for (const [role, varName] of Object.entries(FONT_VARS)) {
    if (font[role]) out[varName] = font[role];
  }
  return out;
}

// ── active-theme apply layer (browser only) ──────────────────────────────────
// The imported design-token FILE is stored verbatim under this key; it's parsed
// and adapted at apply time so a schema change only touches parseThemeFile.
const ACTIVE_KEY = "opentakeoff_report_theme";

// activeTheme() -> { vars, name, warnings } for the CURRENT imported theme, or an
// empty shell if none / private mode / corrupt. `vars` is spread onto the report
// root so the theme scopes to the document subtree, not the whole app; imported
// font families get a graceful fallback since they may not be loaded in-app.
/** @returns {{ vars: Record<string, string>, name: string|null, warnings: string[] }} */
export function activeTheme() {
  const empty = { vars: {}, name: null, warnings: [] };
  try {
    const raw = localStorage.getItem(ACTIVE_KEY);
    if (!raw) return empty;
    const { theme, warnings } = parseThemeFile(JSON.parse(raw));
    const vars = themeToCssVars(theme);
    // append a fallback stack in case the imported family isn't loaded in-app;
    // mono keeps a MONOSPACE fallback so numeric columns stay aligned
    const FALLBACK = { "--f-display": "system-ui, sans-serif", "--f-body": "system-ui, sans-serif", "--f-mono": "ui-monospace, monospace" };
    for (const [k, fb] of Object.entries(FALLBACK)) {
      if (vars[k]) vars[k] = `"${vars[k]}", ${fb}`;
    }
    return { vars, name: theme.name || null, warnings };
  } catch {
    return empty; // private mode / SSR / corrupt JSON → no theme, defaults stand
  }
}

// Back-compat/convenience: just the CSS vars for the active theme.
/** @returns {Record<string, string>} */
export function activeThemeVars() {
  return activeTheme().vars;
}

// saveActiveThemeFile(json)/clearActiveTheme() — the import + reset seam a UI
// picker calls. Stores the raw file so re-parsing always reflects the importer.
export function saveActiveThemeFile(json) {
  try { localStorage.setItem(ACTIVE_KEY, typeof json === "string" ? json : JSON.stringify(json)); } catch { /* private mode */ }
}
export function clearActiveTheme() {
  try { localStorage.removeItem(ACTIVE_KEY); } catch { /* private mode */ }
}
