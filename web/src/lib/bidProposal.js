// Bid proposal — what the proposal PDF says, as plain data (no pdf-lib here,
// so it is tested under node). Named "bid proposal" because "proposals" in this
// codebase are agent pencil batches (lib/proposals.js).
//
// The project's `bid_proposal` record holds its own copy of the proposal text,
// made from Company setup the first time the proposal is opened, so one job's
// exclusions can change without touching the firm's defaults:
//   { itemized, scope_note, inclusions, exclusions, terms, valid_days }
//
// Prices come from priceEstimate() (lib/estimate.js). An itemized proposal
// shows each line's SELL price: the base bid spread over the lines in
// proportion to their cost, in cents, the rounding remainder on the largest
// line, so the printed lines always add up to the printed base bid.

import { round2 } from "./num.js";
import { TEXT_FIELDS, TEXT_LIMIT, DEFAULT_VALID_DAYS } from "./companySetup.js";

const str = (v) => (typeof v === "string" ? v.slice(0, TEXT_LIMIT) : "");

/** @returns {{itemized: boolean, scope_note: string, inclusions: string, exclusions: string, terms: string, valid_days: number}} */
export function sanitizeBidProposal(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const days = Number(src.valid_days);
  const out = {
    itemized: src.itemized === true,
    scope_note: str(src.scope_note),
    valid_days: Number.isInteger(days) && days > 0 && days <= 365 ? days : DEFAULT_VALID_DAYS,
  };
  for (const k of TEXT_FIELDS) out[k] = str(src[k]);
  return out;
}

/** A project's first copy of the proposal text, from Company setup defaults. */
export function bidProposalFromDefaults(defaults) {
  const d = defaults || {};
  return sanitizeBidProposal({ itemized: false, scope_note: "", inclusions: d.inclusions, exclusions: d.exclusions, terms: d.terms, valid_days: d.valid_days });
}

// "One per line" text → the lines that say something.
export const textLines = (s) => String(s || "").split(/\r?\n/).map((l) => l.replace(/^\s*[-•*]\s*/, "").trim()).filter(Boolean);

// What a condition is, for a GC reading the scope: its imported spec
// description, else manufacturer / style / color, else nothing (the tag stands).
export function scopeDescription(c) {
  const sp = c?.spec || {};
  if (typeof sp.description === "string" && sp.description.trim()) return sp.description.trim();
  return [sp.manufacturer, sp.style, sp.color].filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim()).join(" · ");
}

/**
 * Spread `total` over `weights` in cents, proportional, remainder on the
 * largest weight. All-zero weights get nothing but the first line gets the total
 * (a lump sum with no cost basis still has to land somewhere).
 */
export function allocate(total, weights) {
  const cents = Math.round(total * 100);
  const sum = weights.reduce((n, w) => n + Math.max(0, w), 0);
  if (!weights.length) return [];
  if (!(sum > 0)) return weights.map((_, i) => (i === 0 ? round2(total) : 0));
  const parts = weights.map((w) => Math.floor((Math.max(0, w) / sum) * cents));
  parts[weights.indexOf(Math.max(...weights))] += cents - parts.reduce((n, p) => n + p, 0);
  return parts.map((p) => p / 100);
}

const fmtDate = (d) => d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

/**
 * @param {{ est: any, conditions: any[], company?: any, clientInfo?: any, projectName?: string,
 *   proposal?: any, today?: Date }} args
 */
export function buildBidProposal({ est, conditions = [], company = {}, clientInfo = {}, projectName = "", proposal = null, today = new Date() }) {
  const p = sanitizeBidProposal(proposal);
  const byId = new Map(conditions.map((c) => [c.id, c]));
  const sell = allocate(est.total, est.lines.map((l) => l.total));
  const valid = new Date(today.getTime());
  valid.setDate(valid.getDate() + p.valid_days);
  return {
    company: {
      name: str(company.name), address: str(company.address), phone: str(company.phone),
      email: str(company.email), license: str(company.license), logo: typeof company.logo === "string" ? company.logo : "",
    },
    client: { name: str(clientInfo.client_name), address: str(clientInfo.client_address), reference: str(clientInfo.reference) },
    project: str(projectName),
    date: fmtDate(today),
    valid_until: fmtDate(valid),
    itemized: p.itemized,
    scope: est.lines.map((l, i) => ({
      tag: l.finish_tag, description: scopeDescription(byId.get(l.id)),
      qty: l.labor_qty, unit: l.unit, price: sell[i],
    })),
    base_bid: est.total,
    scope_note: p.scope_note.trim(),
    inclusions: textLines(p.inclusions),
    exclusions: textLines(p.exclusions),
    terms: p.terms.trim(),
    complete: est.complete,
    unpriced: est.unpriced,
  };
}

export function bidProposalFileName(projectName) {
  const base = String(projectName || "").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
  return `${base ? base + " - " : ""}proposal.pdf`;
}
