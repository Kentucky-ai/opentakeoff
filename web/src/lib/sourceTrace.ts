// Pure helpers for the ◎ source-trace mechanism (slice 3 of the Captures
// feature). No DOM, no React, no Date/Math.random — the risky part of this
// slice (the pendingSourceRef staleness guard) is factored here so it is
// node-testable in isolation, matching the reltime.ts / markupImage.ts
// precedent: every function is total (never throws) and degrades safely on
// malformed input.

// A capture's src_rect: normalized [[nx0,ny0],[nx1,ny1]] corners, in the
// SOURCE panel's own 0..1 space (see markupImage's capture site — the rect is
// normalized against the panel it was drawn on, not the panel it's traced
// back to display on).
export type NormRect = [[number, number], [number, number]];

// Midpoint of a normalized rect, order-independent (works for either corner
// order since (a+b)/2 doesn't care which corner is which). Total: a
// malformed shape (wrong arity, non-array, non-finite numbers) degrades to
// null rather than throwing or handing back a NaN anchor — a caller must
// treat null as "don't arm anything for this trace" (see
// pendingSourceOutcome's caller-side contract: validate BEFORE arming a
// pendingSourceRef, or a malformed rect burns the whole attempt budget on a
// trace that can never complete).
export function rectMidpoint(rect: unknown): [number, number] | null {
  if (!Array.isArray(rect) || rect.length !== 2) return null;
  const [c0, c1] = rect as unknown[];
  if (!Array.isArray(c0) || !Array.isArray(c1) || c0.length !== 2 || c1.length !== 2) return null;
  const [x0, y0] = c0 as unknown[];
  const [x1, y1] = c1 as unknown[];
  const nums = [x0, y0, x1, y1];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return [((x0 as number) + (x1 as number)) / 2, ((y0 as number) + (y1 as number)) / 2];
}

// A pending source-trace: the sheet named `sheet_id` was opened this tick but
// its panel bitmap isn't ready yet, so the phase-2 effect keeps re-checking
// until it is. Unlike pendingFlyRef (which carries a markup id it can
// re-validate against the live markups array), this carries no markup id —
// there IS no markup on the source sheet, only a synthetic rect — so it
// cannot ask "does the thing I'm waiting for still exist?" the same way.
export interface PendingSourceRef {
  sheet_id: string;
  rect: NormRect;
  token: number;
  attempts: number;
}

export type PendingSourceOutcome =
  | { action: "give-up" }
  | { action: "wait"; attempts: number }
  | { action: "complete" };

// Backstop attempt cap. This is deliberately NOT the primary guard — the
// primary guards are status==="error" and the source sheet no longer
// resolving to a real sheet (both computed by the caller from live state and
// passed in as ctx.status / ctx.sheetIsLive, since this module has no access
// to the sheets/stitches list). This cap only matters when something keeps
// nudging the effect's deps (panelImgs/groupSig/status) without the target
// sheet's render ever actually finishing — the scenario the plan calls out
// as the latent view-teleport: a pendingSourceRef with no markup id to
// validate against, sitting armed forever, ready to fire a stale
// center+flash the next time its target sheet happens to render for an
// unrelated reason.
export const MAX_SOURCE_TRACE_ATTEMPTS = 30;

// The single decision point for the pendingSourceRef phase-2 effect. Pure:
// given the ref and a snapshot of the three facts that matter (load status,
// whether the target sheet key still resolves to something real, whether its
// panel bitmap is ready), decide what the effect should do this tick. The
// effect owns the actual centering/flashing/ref-mutation; this function only
// picks the outcome, so the "never left set on a terminal outcome" claim is
// checkable by reading this one function instead of tracing the effect body.
export function pendingSourceOutcome(
  ref: PendingSourceRef | null,
  ctx: { status: string; sheetIsLive: boolean; panelReady: boolean },
): PendingSourceOutcome | null {
  if (!ref) return null;
  // terminal guards first — either one ends the trace regardless of how far
  // along `attempts` is, so a doomed trace doesn't wait out its own budget
  if (ctx.status === "error") return { action: "give-up" };
  if (!ctx.sheetIsLive) return { action: "give-up" };
  if (ctx.status === "ready" && ctx.panelReady) return { action: "complete" };
  const attempts = ref.attempts + 1;
  if (attempts >= MAX_SOURCE_TRACE_ATTEMPTS) return { action: "give-up" };
  return { action: "wait", attempts };
}
