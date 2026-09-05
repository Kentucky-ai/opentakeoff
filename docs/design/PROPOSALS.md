# Proposals — a batch an agent can revise or withdraw, and a condition edit the estimator accepts

Closes #365. Companion proof with captures from the running app and the real MCP server:
[`proposals-verification.md`](proposals-verification.md).

## Why

Every shape an agent commits lands `origin.reviewed: false` and the estimator accepts or
deletes it. That covers *shapes*, one at a time. It does not cover the two other things an
agent legitimately wants to say:

1. **"I withdraw that."** An agent that commits a wrong batch of rooms, or re-measures and gets
   a better set, had no way to take its own pending work back except `undo_last` (which only
   reaches the last step) or `delete_shape` one id at a time.
2. **"I think this condition is wrong."** `edit_condition` is exactly the wrong power for that:
   a tag rename or a waste change should be a decision the estimator *makes*, not one they
   *discover* in the report.

## The model

**A takeoff proposal** is a named batch with one identity.

- `propose_takeoff {label, rationale}` opens it and makes it *current*. Both fields are
  required: the label is what the estimator reads on the Accept pill, the rationale is what
  decided the batch (the schedule row, the sheet, the rule).
- Every agent commit that follows attaches to the current proposal through
  `origin.proposal_id`. The stamp lives in **one place**, `Session.stampProposal`, called from
  `commit()` and from the two verbs that mint a shape without it (`cut_out`'s deduct receipt
  and a run cut's surviving pieces). No commit path can forget.
- Opening another proposal makes *that* one current. `withdraw_proposal` on the current one
  leaves nothing current — later commits land un-batched, exactly as before #365.
- The batch's **pending set** is "attached AND `reviewed !== true`". A shape the estimator
  accepted keeps the id as history and leaves the batch: no agent verb reaches it (the ink
  rule, unchanged).
- `revise_proposal {proposal_id, shapes[]}` replaces the pending set with a new one in **one
  journal step**. All-or-nothing: every replacement is validated (sheet, scale, vertex
  minimum, a height for `surface_area`) before the first pending shape is removed; the error
  names the entry (`shapes[i]`). The replacements quantify through `Session.quantify`, the
  same arithmetic `measure_polygon` / `measure_line` / `measure_surface` / `place_count` run,
  so a revised batch measures exactly as a fresh commit would.
- `withdraw_proposal {proposal_id}` removes the pending set in one step and marks the record
  withdrawn (the label stays; it is history). Accepted shapes stay and are counted in the reply.
- `undo_last` reverses each of these as one step: `proposal_open`, `proposal_revise`,
  `proposal_withdraw`. A withdrawn batch of forty shapes comes back with one call, in its
  recorded positions.

**A condition-edit proposal** is a diff held pending.

- `propose_condition_edit {condition, finish_tag?, waste_pct?, multiplier?, height_ft?,
  roll_setup?, rationale}` records only the fields that differ from the current value. It
  refuses a diff that changes nothing, and a rename onto a tag another condition already
  carries (two conditions on one tag would make one permanently unreachable — the
  `duplicate_condition` rule).
- One pending diff per condition; proposing again replaces the earlier one (journaled).
- `withdraw_condition_edit {proposal_id}` drops it. Both journal; both undo.
- **Acceptance is a host verb, not an agent tool.** `Session.acceptConditionEdit` exists for
  the reviewing surface and applies the diff through `applyConditionKnobs` — the same private
  method `edit_condition` writes through — which is what makes "after acceptance the report is
  byte-for-byte a direct `edit_condition`" true by construction. The canvas applies the same
  diff through its own condition patch path (`updateCondById`).

## What the estimator sees

- **Canvas Accept surface**: one pill per proposal (`Accept "Level 1 offices per finish
  schedule" · 3`) with a ✕ to reject the batch, plus the original `Accept N proposed shapes`
  pill for anything un-batched. Accept is the same `review` command the single pill always
  used — one undo entry. Reject deletes the batch's pending shapes — `⌘Z` restores them.
- **Takeoffs panel**: a pending condition diff sits under the row it targets — `waste 0% →
  10%`, `tag CPT-1 → CPT-1 (Broadloom)`, the rationale, **Accept** / **Reject**. The row above
  and every total keep showing the current values.
- **Report**: the condition row prints the current knobs with a `proposed: …` line beside them;
  the JSON export carries `proposed_condition_edits` (present only when any are pending, so a
  proposal-free report is byte-identical to a pre-#365 one).
- **MCP**: `takeoff_summary` carries the `proposals` ledger (pending / accepted / withdrawn /
  current per batch) and `proposed_condition_edits`; `export_report` carries the latter;
  `list_shapes` names each shape's `proposal_id`.

## What it never changes

- No new power. An agent still cannot change an accepted shape or an accepted condition
  without the estimator's click. `propose_takeoff` commits nothing; a proposal with no shapes
  is a heading.
- Every total, everywhere, is computed from the current condition values until acceptance.
- `export_takeoff` and the app's own save carry `proposals` / `condition_edit_proposals`
  **only when any exist** — a proposal-free payload is byte-identical to before.
- `import_takeoff` and the app's Import transport them (a diff follows its condition through
  the tag-identity merge; a diff onto a tag the operator already uses is dropped, never staged
  as a collision). An imported batch is history, not the session's current proposal.

## Tests

- `mcp/test/proposals.test.ts` — attachment through every commit path, all-or-nothing revise,
  the forty-shape withdraw/undo, the byte-for-byte acceptance control, every refusal, the
  export → import round trip, and reload clearing.
- `mcp/test/conformance.test.ts` — every verb's reply validates against its output schema on
  the wire; the six new journal ops survive `undo_last`'s output enum.
- `web/test/proposals.test.ts` — grouping into one pill per batch, the panel's patch
  semantics, the report rows, the import merge, and the report JSON's additive key.
- `mcp/test/tools.test.ts` / `staging.test.ts` / `gate.test.ts` — the five verbs are in the
  stage table and the published count (50) everywhere the count is generated.
