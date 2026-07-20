# OpenTakeoff — QA Plan (demo‑ready → open‑source release)

A phased checklist so nothing slips. Work the phases in order — **don't demo until
Phase 4 is green; don't open‑source until Phase 7 is green.** Each phase has a
**goal**, **checks**, and a **pass bar**. Track status with `[ ]` → `[x]`.

> The single most important property of a takeoff tool is **the numbers are right**.
> Phase 1 is therefore non‑negotiable and gets the most rigor.

---

## Phase 0 — Smoke (it runs)
**Goal:** the app loads and the happy path works at all.
- [ ] `npm run dev` serves; page loads with no console errors.
- [ ] `npm run build` + `npm run preview` works (production bundle, not just dev).
- [ ] `npm test` green; `npm run typecheck` clean.
- [ ] Drag in a PDF → it renders. Gallery (`G`) lists sheets.
- [ ] Empty‑state copy makes sense (no plans / no conditions yet).

**Pass bar:** clean load + build + tests on a fresh checkout.

---

## Phase 1 — Measurement correctness (the core — be ruthless)
**Goal:** every measured quantity is provably right. Use a sheet with a **known**
dimension (a dimensioned room, or draw on graph paper exported to PDF).
- [ ] **Calibration:** calibrate to a known length; a second known length on the same sheet reads back within ~0.5%.
- [ ] **Area:** trace a room of known SF → matches hand‑calc (e.g. 20'×30' = 600 SF).
- [ ] **Rectangle:** same room via Rectangle = same SF as Area.
- [ ] **Deduct:** add a known void → floor SF drops by exactly that void.
- [ ] **Linear:** trace a known run → LF matches; with a thickness set, border SF = LF × T/12.
- [ ] **Surface Area:** run × condition height = expected wall SF.
- [ ] **Count:** N clicks = N EA.
- [ ] **Multiplier:** ×3 triples SF/LF/EA (and rounds materials off the multiplied basis).
- [ ] **Waste:** Report's "with waste" = measured × (1 + waste%); EA never gets waste.
- [ ] **Materials:** order qty = basis ÷ coverage, **rounded up**; `round:false` keeps the fraction; trowel pick sets the coverage; linear‑basis material uses LF not SF.
- [ ] **Per‑sheet scale:** the same physical size on two differently‑scaled sheets yields the same SF.
- [ ] **Report = canvas:** the per‑condition totals in the Report match the live readout; CSV and JSON match the on‑screen numbers exactly.
- [ ] **One‑Click:** an auto‑selected room's SF ≈ a hand‑traced Area of the same room (within a small tolerance); cutouts subtract.

**Pass bar:** every row above verified against an independent hand‑calc. Add a couple of these as automated cases in `web/test/totals.test.ts`.

---

## Phase 2 — Canvas tools & editing UX
**Goal:** every tool and edit behaves predictably.
- [ ] Each tool arms by click **and** by shortcut (P/V/A/R/L/S/C/D/⇧D/O/G, 1–9).
- [ ] Finish (Enter / double‑click), Esc cancel, Backspace removes last point, ⌘Z undo — all behave per the guide.
- [ ] Select → move a vertex, insert a midpoint, drag the whole shape, **reassign** to another condition, delete.
- [ ] Copy / Paste (lands under cursor, correct sheet) / Duplicate.
- [ ] Hatch/color/fill changes repaint immediately; legend/swatch matches.
- [ ] Multi‑sheet: open several, scale each, **Regroup** restores the composition; per‑sheet takeoffs stay put.
- [ ] Hi‑Res toggle changes crispness only — **quantities unchanged**.
- [ ] Snap (beta): snaps to real corners; degrades cleanly on raster sheets.
- [ ] Markup (cloud/callout/text) never affects totals.
- [ ] Delete a condition removes its takeoffs (with confirm); deleting/editing supporting materials (and labor/subfloor type) works from the Takeoffs panel.

**Pass bar:** no tool throws; no edit corrupts a shape or its totals.

---

## Phase 3 — Data integrity & persistence
**Goal:** work is never silently lost or corrupted.
- [ ] Reload mid‑project → drawings, scales, conditions, markups all return.
- [ ] Close/reopen the tab → same. (Note storage is per‑origin/port.)
- [ ] Re‑drop a renamed/edited PDF → de‑dupes by name, doesn't double‑count.
- [ ] Remove a sheet → its takeoffs handled sanely; remembered group prunes deleted members.
- [ ] Export → re‑import / re‑open → numbers stable.
- [ ] Large planset (e.g. a 50–70 MB building) loads and persists without wedging the tab.

**Pass bar:** no data loss across reload/close; no double‑count; large single building survives.

---

## Phase 4 — Robustness & edge cases (gate for demoing)
**Goal:** it doesn't embarrass you in front of a GC.
- [ ] Raster/scanned PDF → One‑Click/Snap report the limitation instead of failing silently.
- [ ] Huge or many‑page set → graceful (slow is OK; crash/blank is not). Document the practical ceiling.
- [ ] Weird scales / rotated sheets / oddly‑sized pages render and measure correctly.
- [ ] Zero/empty states (no scale set, no condition picked) → clear guidance, not a crash.
- [ ] Trace that "spills," self‑intersecting polygon, 1‑point shape, off‑sheet click → handled.
- [ ] Rapid tool switching / interrupted gestures don't leave the canvas stuck.

**Pass bar:** no white‑screen, no stuck canvas, no wrong number presented as right.

---

## Phase 5 — Cross‑browser & performance
**Goal:** works where you'll demo it.
- [ ] Chrome, Safari, Firefox: render, draw, scale, export all work.
- [ ] Pan/zoom stays smooth on a real building sheet.
- [ ] Memory doesn't balloon over a long session (open/close several sheets, draw a lot).
- [ ] Touch/trackpad gestures behave (pinch‑zoom vs draw).

**Pass bar:** demo‑smooth on your demo machine + one backup browser.

---

## Phase 6 — Demo readiness
**Goal:** a repeatable, impressive 5‑minute demo.
- [ ] A **bundled sample plan** that shows off One‑Click + finish takeoff + report (don't demo on client‑confidential plans).
- [ ] A written **demo script** (the 6 steps in the User Guide, timed).
- [ ] No console errors, no half‑built UI, no placeholder text visible.
- [ ] First‑run experience is obvious without narration (empty states guide the user).
- [ ] Report/CSV looks clean enough to hand to a GC.
- [ ] A reset path (fresh workspace) so each demo starts clean.

**Pass bar:** you can run the demo cold, twice, with no surprises.

---

## Phase 7 — Open‑source release readiness
**Goal:** safe and credible to publish.
- [ ] **License/NOTICE** present and correct (Apache‑2.0); third‑party notices complete.
- [ ] **No secrets** in git history (keys, tokens, `.env`); `.gitignore` covers build output, `node_modules`, local data.
- [ ] **No proprietary/client data** shipped — no real plansets, no pricing, no customer names in samples or fixtures.
- [ ] **README** = what it is, screenshot/GIF, install, run, build, the client‑only architecture, the `apiStore` seam.
- [ ] **CONTRIBUTING** + issue/PR templates; code of conduct.
- [ ] Clean `npm ci && npm run build && npm test` on a fresh clone (no local‑only deps).
- [ ] Pin/audit dependencies (`npm audit`); note the browser support matrix.
- [ ] Versioned release + changelog; tag.
- [ ] A short SECURITY note (it's client‑only; data stays in the browser).

**Pass bar:** a stranger can clone, build, run, and understand it — and you've shipped nothing you shouldn't.

---

### How to run a pass
1. Pick the lowest un‑green phase.
2. Work top to bottom; log failures as issues with repro + expected vs actual.
3. Re‑run the phase after fixes.
4. Phase 1 and Phase 4 get re‑run before **every** demo; Phase 7 before **every** public release.
