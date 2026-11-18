// SPDX-License-Identifier: AGPL-3.0-only
// Is a condition a CEILING (drawn at its height in the 3D view)? Kept dependency-free so the canvas
// and condition panels can ask without pulling the lazy 3D engine into the main bundle.
const CEILING_RE = /\bACT\b|\bAPC\b|CEIL|\bCLG\b|\bSOFFIT\b|\bBULKHEAD\b|\bGWB\s*CLG|ACOUSTIC(AL)?\s*(CEILING|TILE|PANEL)/i;
export const isCeilingCondition = (c) => !!c && (c.flooring_type === "ceiling" || c.flooring_type === "act" || CEILING_RE.test(`${c.finish_tag || ""} ${c.name || ""}`));
