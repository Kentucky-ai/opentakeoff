// Language-independent danger message classification.
//
// The canvas commit-msg bar renders danger messages red + sticky. Historically,
// isDangerMsg keyed on English text prefixes ("Couldn't…", exact match with
// STALE_TAB_MESSAGE). After i18n, messages are translated and those checks
// break. This module replaces them with a registry: any message passed through
// markDanger() is classified as danger regardless of language content.
//
// Zero deps — importable by every lib module without circular risk.

/** @type {Set<string>} */
const _registry = new Set();

/** Tag a user-facing message as danger (red + sticky). Returns the message
 *  unchanged so call sites can inline: `throw new Error(markDanger(msg))`. */
export function markDanger(msg) { _registry.add(msg); return msg; }

/** Is this message danger-tagged? No English dependency. */
export function isDanger(s) { return typeof s === "string" && _registry.has(s); }
