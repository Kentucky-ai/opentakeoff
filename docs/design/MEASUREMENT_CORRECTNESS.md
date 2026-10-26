# Measurement correctness

Changing a sheet's scale must update its stored quantities, and accepting agent
work must be an explicit review decision. Phase 1 repairs these invariants across
the canvas, imports, sync and MCP exports.

## Scope and placement

| Concern | Behavior | Implementation |
|---|---|---|
| Recalibration | Recompute dimensional quantities and pre-cut restore snapshots together; keep counts unchanged | Shared pure `recalibrateShapes` in `shapeMetrics.js`, called by canvas and MCP |
| MCP undo | Restore scale and affected quantities as one journal entry | `Session.setScale` and `undoLast` |
| Reviewed work | MCP refuses recalibration of human-reviewed dimensional work | Session boundary; the canvas remains the human editing surface |
| Import conflict | Refuse a new dimensional measurement at a conflicting local scale before changing any project state | Pure import merge, used by browser and MCP |
| Agent review | Missing review flags on legacy agent work normalize to false; explicit approval stays intact | Shared `normalizeAgentReview` at hydration and import boundaries |
| Sheet sync | Key calibration rows by `sheet_id`; preserve each sheet's dimensional geometry with its scale | Three-way merge and existing backup-before-adoption store path |
| Interior voids | Carry retained holes through creation; calculate area from the final simplified geometry | Network result, agent proposal transport and canvas commit paths |
| Confirmation | Persist confirming a scale even when no shape changes | Canvas autosave dependencies |

## Data and compatibility

The annotation schema and export formats stay unchanged. Normalized vertices are
not rescaled when calibration changes. Computed values change to match the selected
calibration. Counts, condition settings and waste settings retain their values.
Existing explicit review decisions are preserved.

When both devices change dimensional work on the same sheet at different scales,
the remote calibration and dimensional measurements are adopted together. The
local alternative is backed up before adoption and the sheet is flagged for review.
Independent edits on different sheets still merge.

## Existing detector thresholds

| Rule | Value | Phase 1 change |
|---|---|---|
| Retain interior voids | At least 40 SF by default (`HOLESF`) | None; carry the holes the detector already retains |
| Network room simplification | 0.12 ft collinearity, 0.4 ft notch tolerance | None; calculate the quantity after simplification |
| Network field simplification | 0.15 ft collinearity, 1.0 ft notch tolerance | None; calculate the quantity after simplification |

There are no new UI tokens or detector tuning parameters. Existing calibration,
import, review and sync controls remain in their current locations. The default
sample, its PDF bytes and the benchmark goldens are unchanged. Demo selection,
drafting-convention handling, engine parity and a UI redesign are separate work.

See [live verification](measurement-correctness-verification.md) and the
[test guide](../PHASE_1_TESTING.md).
