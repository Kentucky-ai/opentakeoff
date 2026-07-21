// The canvas "busy" predicate for the sync reconciler's defer-gate (Slice 5b),
// extracted as a PURE function so it's unit-testable (the 5a cascade bug survived
// because the React-bound bits were never unit-tested). The store's maybeFlush
// declines to adopt-over-local while this returns true, and the canvas re-checks it
// at apply time before re-hydrating — so it must report EVERY interaction mode a
// mid-session re-hydrate would visibly clobber, not just the trace-in-progress ones.
//
// Inputs are plain values the caller reads from state + refs at call time:
//   - poly/calib/check: in-progress trace / calibration / check vertex arrays
//   - proposal/scaleGuide/prevScale: One-Click review, scale guide, prev-scale prompt
//   - saveState === "saving": a debounced save is scheduled (CRITICAL-b: a re-hydrate
//     now would cancel the trace's pending save via the autosave effect's clearTimeout)
//   - dragging: a shape/vertex/markup move OR a One-Click proposal-edit drag is live
//   - editing: the inline on-canvas text editor is open (unsaved keystrokes)
//   - scanning: a paid OCR read is in flight
//   - agentRunning: the agent tool-use loop is mid-run (a re-hydrate would wipe
//     conditions it minted and orphan the proposals it's still staging)
//   - agentProposals: dashed agent proposals await accept/reject — the agent's
//     analog of One-Click's `proposal` review gate, deferred for the same reason
export interface CanvasBusyState {
  poly?: unknown[];
  calib?: unknown[];
  check?: unknown[];
  proposal?: unknown;
  scaleGuide?: unknown;
  prevScale?: unknown;
  saveState?: string;
  dragging?: boolean;
  editing?: boolean;
  scanning?: boolean;
  agentRunning?: boolean;
  agentProposals?: unknown[];
}

export function isCanvasBusy(s: CanvasBusyState): boolean {
  return (
    (s.poly?.length ?? 0) > 0 ||
    (s.calib?.length ?? 0) > 0 ||
    (s.check?.length ?? 0) > 0 ||
    s.proposal != null ||
    s.scaleGuide != null ||
    s.prevScale != null ||
    s.saveState === "saving" ||
    !!s.dragging ||
    !!s.editing ||
    !!s.scanning ||
    !!s.agentRunning ||
    (s.agentProposals?.length ?? 0) > 0
  );
}
