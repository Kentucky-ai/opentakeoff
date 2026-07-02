# Changelog

All notable changes to OpenTakeoff. Dates are release/merge dates on `main`.

## 2026-07-01

### Added
- **45°/90° angle guides (polar tracking).** While tracing Area / Linear / Surface / Deduct, the segment locks to the 45° family (0°, 45°, 90°, 135° across the sheet) whenever the cursor comes within ~4° of an axis; a dashed guide stretches across the sheet along the locked axis and the click commits the exactly-on-axis point. Hold **⇧** to force the lock at any cursor angle. New **45°** toolbar toggle (on by default), sitting next to Snap. Endpoint Snap takes priority over the angle lock. The calibration line snaps the same way.
- **Liquid-glass magnifier crosshair.** The aim point now rides inside a circular lens that magnifies the sheet beneath the cursor at ~2.25× the current zoom — linework and text pass under the glass, with a fine cross through the lens center as the aim point. While angle-locked the rim glows cobalt and a chip below the lens reads the locked angle plus the live segment length (once the sheet has a scale); the chip reads `snap` when an endpoint snap is active. Full-page aim hairlines are now 1px and fainter.

### Docs
- New `CHANGELOG.md`, `AGENTS.md` (map of the repo for coding agents), `web/public/llms.txt`, and GitHub issue/PR templates.
- User guide: new "Angle guides & the magnifier crosshair" section + ⇧ shortcut row.

## 2026-06-28
- **Crisp detail-view canvas** — past ~1.15× zoom the visible region re-renders straight from the PDF vectors at the current zoom (Bluebeam/AutoCAD-style), so deep zoom never pixelates.

## 2026-06-23
- **Bundled sample plan** — a real (public, architect-sealed) medical-center floor finish plan with one-click **Load sample plan**; social card + README hero.

## 2026-06-19 → 06-22
- **WD-1 hardwood condition + assemblies** — trowel-aware adhesive, sealer/poly finish assemblies with real coverage rates (vendor-neutral).
- **Takeoffs panel** — edit assemblies and delete conditions inline.
- README rewrite, user guide + screenshots, one-click Netlify deploy button, SEO/OG pass.

## 2026-06-18
- **Relicensed MIT → Apache-2.0** (PRs #1–#2).
- **Supporting materials (assemblies) per condition** — coverage rate + basis → rounded order quantities; full condition edit/delete.
- **Ingest** — PDFs, images, and `.zip` plan sets through one in-browser path.

## 2026-06-15
- **Initial release** — open-source PDF takeoff canvas for flooring: One-Click Area, manual measure kit, per-sheet scale (auto-detect + calibrate), conditions with CAD hatches, waste %, reports with SF/SY/LF/EA and CSV/JSON export, client-only storage.
