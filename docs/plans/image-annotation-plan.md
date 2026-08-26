# Plan — Image annotation markup (upload + marquee screenshot)

> Revised after four parallel adversarial plan reviews (correctness, regression,
> test-design, security/edge). Every finding is folded into the body below; the
> "Review findings → resolution" table at the end is the audit trail.

## Problem

The markup layer (a separate layer the takeoff totals never count) supports
`cloud`, `callout`, `text`, `highlight` (box + freehand), `dimension`, plus
`arrow`/`bubble`/`svg` (via stamps and SVG import). There is **no way to place a
raster image** on a sheet. Estimators want to drop:

- an **uploaded image** — a photo, a spec-sheet clip, a detail from another
  document — onto the sheet as an annotation; and
- a **marquee screenshot** — rubber-band a rectangle over the current sheet and
  capture that region of the rendered plan as a floating image.

Both should render on the canvas, move/resize, persist, round-trip through
export/import, and burn into the Marked Set PDF — like every other markup.

## Design

Add a markup type **`image`**, modeled on the `svg` markup (`at` center + a
width fraction + a fixed aspect, sized off sheet width, placed centered on `at`).

### Record shape

```js
{
  // common fields minted by addMarkup():
  id, type: "image", sheet_id, created_at, rfi_id: "", condition_id,
  at: [nx, ny],     // CENTER, normalized to the panel image (0..1)
  w: number,        // width as a fraction of sheet WIDTH (like svg m.w)
  aspect: number,   // natural height / width (> 0)
  src: string,      // data URL — ALWAYS "data:image/png;base64,…" or "data:image/jpeg;…"
  source: "capture" | "upload",   // provenance (audit trail)
}
```

No `color`/`line_style`/`weight` — an image renders as-is. Selection halo and the
RFI/condition-link badges still apply (shared render helpers).

### Storage decision — inline data URL, hard-capped, NOT a separate store

Inline `src` on the record (not a side IndexedDB store). Verified reasons:

- **Round-trip is free.** `importTakeoff.js:143-144,170` passes markups through
  wholesale; `buildPayload` (`TakeoffCanvas.jsx:2060`) serializes them wholesale.
  An inline `src` survives `export_takeoff` → `import_takeoff` unchanged. A side
  store would vanish on JSON export/import and across devices.
- **Cloud sync is free.** Annotations sync as one blob; a side store needs its own
  channel or images disappear across devices.
- **Render/move/delete are synchronous.** `<image href={src}>` needs no async
  resolve.
- **Privacy holds.** `contribute.js` whitelists derived shape data only and never
  includes markups (`contribute.js:8`) — a screenshot can't leak into the
  training-contribution payload.

The cost — the `annotations` blob re-saves (debounced, `TakeoffCanvas.jsx:2288`)
on every markup/shape edit, and re-uploads to Drive on the sync path — is bounded
**three ways**, all mandatory (reviews flagged the single 1600px cap as
insufficient):

1. **Per-image pixel cap.** Every stored image is downscaled to
   `MARKUP_IMG_MAX = 1600` px longest side and re-encoded through a canvas
   (capture AND upload). ~0.1–0.6 MB each.
2. **Decode-area guard (pixel bomb).** Reject/limit an upload whose *decoded*
   dimensions exceed a `MAX_CANVAS_AREA`-style ceiling **before** it is drawn — a
   small file can declare 30000×30000 and OOM the tab at decode. Use
   `createImageBitmap(file, { resizeWidth, resizeQuality, imageOrientation })` so
   the decode itself allocates at the capped size.
3. **Aggregate budget.** Refuse a new image (with a message) when the project's
   total image-markup bytes would exceed `MAX_IMAGE_MARKUP_BYTES` (≈16 MB) — N
   capped images otherwise defeat the per-image cap and push the blob past quota.

And the quota failure that inline images first make reachable is no longer
silent: the autosave catch (`TakeoffCanvas.jsx:2278-2281`) currently surfaces
only stale-tab errors, dropping `QuotaExceededError` to `"idle"` with no message —
so a too-big blob silently fails to persist *the entire takeoff*. Fix: on a
non-stale error, `setCommitMsg(friendlyStoreError(e))` (the quota copy already
exists, `store.js:139-141`) and set an explicit error save-state, not `"idle"`.

Migration to a dedicated blob store stays **out of scope**.

### Coordinate frame (verified)

Markup coords are normalized `[0,1]` of the panel image (`p.img.w`/`p.img.h`, the
`RENDER_SCALE = 2.0` viewport dims). Canvas `p.img.w` and export `W = vpR.width`
are **both** `pageW × 2.0` from the same `lib/sheets.ts`, so `w`-as-width-fraction
maps identically screen↔PDF. `w` is a fraction of sheet **width**; placed box is
`bw = w*sheetW`, `bh = bw*aspect`, centered on `at`.

### Pure, testable helpers — `web/src/lib/markupImage.ts` (new)

The risky math is pulled OUT of the canvas/PDF integration into pure functions
(the `winAnsiSafe`/`svgPlacedBox` precedent — export/geometry modules keep their
branchy logic node-testable):

- `imagePlacedBox(w, aspect, sheetW) → {bw, bh}` — `bw = w*sheetW`,
  `bh = bw*aspect`. Guard `w>0 && aspect>0 && Number.isFinite(sheetW)` → else
  `{bw:0, bh:0}`. **Note the deliberate difference from `svgPlacedBox`**
  (`svgpath.js:451`), which scales off the *longest* viewBox extent; `image` is
  *width-anchored*. Documented in a header comment; the tall-aspect test pins it.
- `captureRectToImageGeom(rect, sheetW, sheetH) → {at, w, aspect}` — rect is in
  image px (already clamped to sheet bounds by the caller). `w = |x1-x0|/sheetW`,
  `aspect = |y1-y0|/|x1-x0|`, `at = [midX/sheetW, midY/sheetH]`. Corner-order
  independent. Guard `sheetW>0 && sheetH>0` finite and `|x1-x0|>0`; degenerate →
  `w:0, aspect:0` (never NaN/Infinity); clamp `at` into `[0,1]`.
- `resizeImageFromCorner(fixedTL, pointer, aspect, sheetW, sheetH) → {w, at}` —
  fixed top-left corner stays put; `bw = pointerX − fixedTL.x`; **clamp `w` first**
  (`clampImageWidth`), THEN derive `bh = bw*aspect` and the new center so the
  top-left is invariant *including at the clamp rails*. Cross-axis normalization is
  explicit: `at = [(fixedTL.x + bw/2)/sheetW, (fixedTL.y + bh/2)/sheetH]` (bw over
  width, bh over height). This is the highest-risk new math — it is a pure helper
  precisely so it is tested.
- `clampImageWidth(w) → number` — clamp into `[0.02, 2]`.
- `aspectFromDims(w, h) → number` — `h/w` with `w<=0`/non-finite → fallback `1`.
- `pickEmbedFormat(src) → "jpg" | "png" | null` — `"jpg"` for
  `data:image/jpeg`, `"png"` for `data:image/png`, else `null`. The export and the
  store-time assertion both use it; `null` is a clean skip, never an exception.

`imagePlacedBox` and `pickEmbedFormat` are imported by `markedset.js` (JS importing
a `.ts` lib is fine — `markedset.js` already imports `./sheets`). Use the
**extensionless** specifier `from "./markupImage"` (matches `./sheets`; a
`.ts` extension trips `tsc --noEmit`).

### Two entry points

1. **Marquee screenshot** — a new `image` tool in `MARKUP_TOOLS`. Armed, it is a
   two-click marquee like `schedule`/`symbol` (`TakeoffCanvas.jsx:2770-2778`):
   first click drops `imageAnchor`, second click calls
   `captureRegionMarkup(anchor, p)`. Live rubber-band reuses `rectRef` — wire an
   `imgDraw` flag into `TakeoffCanvas.jsx:3186-3194` beside `schedDraw`/`symDraw`.
   `image` routes **only** through this marquee branch — it must NOT be added to
   the `placeMarkup` OR-list at `2780` (that has no image case and would no-op).
   Capture:
   - Guards mirror `importScheduleFromRect` (`5816-5823`): both corners in one
     panel; a real `pageObjsRef` page (refuse on a stitched composite — no single
     source page, message the user); a non-degenerate box.
   - **Clamp the rect to `[0,p.img.w]×[0,p.img.h]` before geom** (an over-drag past
     the sheet edge must not park `at` outside `[0,1]`).
   - Render offscreen with its **own** factor `min(1, MARKUP_IMG_MAX/max(regW,regH))`
     in rs-viewport px — do NOT inherit `rasterizeRegion`'s `scanRasterScale`
     (which caps at 4096 and blows the 1600 budget). `canvas.toDataURL("image/png")`.
   - `captureRectToImageGeom` → `at/w/aspect`; `addMarkup({type:"image", …,
     source:"capture"})` after the aggregate-budget check.
2. **Upload** — an "Upload image…" button in the Markups dock (near the markup
   list `7325-7425`), reusing the StampPanel hidden-file-input pattern
   (`StampPanel.jsx:86-89`, incl. `e.target.value=""` to allow re-picking).
   `accept="image/*"`, but **do not trust `accept`**:
   - **Reject SVG explicitly** (`f.type === "image/svg+xml"` or `/\.svg$/i`) — an
     SVG can carry script; it is exactly what `svgImport.js:423-428` bans.
   - Decode via `createImageBitmap(file, { imageOrientation: "from-image" })`
     (honors JPEG EXIF orientation) with a decode-area ceiling.
   - **Unconditional re-encode** through a downscale canvas (≤1600 longest) →
     `toDataURL` — PNG, or JPEG when the source is JPEG (smaller for photos). Only
     the canvas output is stored; original file bytes are never kept. This reduces
     the feature to "pixels only" (SSRF-/script-safe) and guarantees
     `pickEmbedFormat(src) !== null`.
   - Wrap decode+encode in try/catch → "Couldn't read that image." on failure
     (corrupt, zero-byte, tainted-canvas `SecurityError`).
   - `aspect = aspectFromDims(bitmap.width, bitmap.height)`; default `w = 0.2`;
     place centered in the current view; `source:"upload"`; aggregate-budget check.

### Move & resize

- **Move** needs **no new move code**, but ships with the hit-test: an `image` has
  `at`, so the existing markup move-drag arms with `orig = { at }`
  (`2978`, the fallthrough) and onPointerMove translates `at` (`3446`) — *only once*
  `hitMarkup` has an `image` branch (below). Not independently "done."
- **Resize** (new): when an image is selected, render a small BR corner handle
  (screen-constant, `/z`). In `selectAt`, BEFORE the generic markup search (insert
  ~`2957`), resolve `selectedMarkupId` → markup, **confirm `type === "image"`**,
  and if the pointer is on its BR handle, arm
  `dragRef = { kind:"markupResize", markupId, sheetId, tl:[…], aspect, ox, imgW,
  imgH }` (fixed top-left). onPointerMove calls `resizeImageFromCorner` and live
  `setMarkups`. onPointerUp (`3488-3511`) sees `kind` ∉ {vertex,edge,move},
  dispatches no shape command, releases capture (verified — mirrors `markupMove`).
  Like every markup edit, resize is **not** on the ⌘Z stack (markups aren't;
  consistency over inventing undo).

### Rendering (canvas)

Add an `image` branch in the markup map (`7787` region, beside `svg`). It must be
**self-contained and always return** — the map ends in an unconditional `text`
fallthrough (`7807-7816`), so a guard-failing image would otherwise paint a
phantom empty note box:

```jsx
if (m.type === "image") {
  const { bw, bh } = imagePlacedBox(m.w, m.aspect, p.img.w);
  if (!(m.src && Array.isArray(m.at) && bw > 0 && bh > 0)) return null;   // never fall through
  const x0 = m.at[0]*p.img.w - bw/2, y0 = m.at[1]*p.img.h - bh/2;
  return (
    <g key={m.id}>
      {halo(x0, y0, x0+bw, y0+bh)}
      <image href={m.src} x={x0} y={y0} width={bw} height={bh}
             preserveAspectRatio="none" style={{ pointerEvents:"none" }} />
      {selM && <rect x={x0+bw-4/z} y={y0+bh-4/z} width={8/z} height={8/z}
                     fill="#1f3fc7" stroke="#fff" strokeWidth={1.5/z} />}
      {badge(x0, y0 - 9/z)}
    </g>
  );
}
```

No dark-mode inversion (a screenshot is captured from the light PDF render).

### Hit-test

Add an `image` branch to `hitMarkup` (`2874`-style, `at ± box/2` via
`imagePlacedBox`; `&&`-guarded so a bad record falls to `false`). In `selectAt`'s
markup search and `editMarkupAt`, test images **last** (three tiers:
non-image-non-highlight → highlight → image) so a large image never shadows other
markups from selection; shapes beneath a large image are shielded (same as a
highlight box today) — documented in the user guide.

`editMarkupAt` (`4732`): add `|| m.type === "image"` to the select-only guard
(images carry no text — no dead-end editor writing a phantom `m.text`).

### Marked Set PDF export

Add `else if (m.type === "image" && m.at && m.src)` in `markedset.js:788` (before
the `text` fallthrough), inside the async `for (const m of marksHere)` (sequential
`await` preserves draw order):

- **Skip rotated sheets for v1**: if `page.rotate % 360 !== 0`, skip the image
  (canvas `toPage` carries the rotation affine but `pg.drawImage` takes only a
  bottom-left point + axis-aligned w/h, so a rotated sheet mis-places AND
  mis-proportions it). Documented limitation.
- `const fmt = pickEmbedFormat(m.src); if (!fmt) continue;` (clean skip, not an
  exception).
- `{bw,bh} = imagePlacedBox(m.w, m.aspect, W)`; box top-left `(x0,y0)` in image px;
  map the box's bottom-left `(x0, y0+bh)` through `toPage`; size via `ptScale`;
  `img = await (fmt === "jpg" ? doc.embedJpg : doc.embedPng)(m.src)`;
  `pg.drawImage(img, { x, y, width: bw*ptScale, height: bh*ptScale })`.
- Wrap in try/catch → skip on failure (the logo precedent `277`) so one corrupt
  image never kills the marked set.

## Files touched

**New**
- `web/src/lib/markupImage.ts` — the pure helpers above.
- `web/test/markupImage.test.ts` — node:test over every helper.
- `docs/plans/image-annotation-plan.md` — this file.

**Edited**
- `web/src/lib/canvasConstants.js` — add the `image` tool to `MARKUP_TOOLS`; add
  `MARKUP_IMG_MAX`, `MAX_IMAGE_MARKUP_BYTES` (and a decode-area constant if not
  reusing `MAX_CANVAS_AREA`).
- `web/src/pages/TakeoffCanvas.jsx` — `imageAnchor` state; marquee dispatch
  (`~2779`, NOT the `2780` OR-list); `rectRef` preview (`3186-3194`); Escape +
  tool-change reset of `imageAnchor` (`~2647`); `captureRegionMarkup`; upload
  handler + browser decode/downscale util; aggregate-budget guard; autosave
  quota-error surfacing (`2278-2281`); render branch (`~7787`); `hitMarkup` branch
  + three-tier ordering (`2874`/`2961-2967`); `editMarkupAt` guard (`4732`);
  `selectAt` resize-handle arm (`~2957`); onPointerMove `markupResize`; Markups-dock
  "Upload image…" button (`~7325`); import the new helpers. **Do NOT touch
  `reportJson` in `totals.js`** (its markup key whitelist is asserted by
  `totals.test.ts:156`).
- `web/src/lib/markedset.js` — import `imagePlacedBox`/`pickEmbedFormat`; the
  `image` export branch.
- `web/src/components/ReportPanel.jsx` — exclude `image` from the "Revisions
  noted" table (`827` and `840`: `m.type !== "svg" && m.type !== "image"`).
- `web/src/brand/icons.jsx` — add an `image` icon (none exists).
- `README.md`, `docs/USER_GUIDE.md`, `CHANGELOG.md` — per AGENTS.md doc-sync list
  (Markups feature line + "What's in the box" row; user-guide markups section, the
  shadowing note, the "images sync/export with the takeoff" note, and the
  rotated-sheet export limitation). **No MCP docs** (no new MCP verb; the export
  branch benefits MCP for free via `markedset.js`).

## Test plan

Pure math is the red→green TDD target (`web/test/markupImage.test.ts`, node:test
via tsx). Red is natural: `markupImage.ts` doesn't exist, so the import fails.

- `imagePlacedBox`: `(0.5,0.5,1000)→{500,250}`; `(0.25,2,800)→{200,400}` (tall
  case — documents the width-anchor divergence from `svgPlacedBox`); `w≤0`,
  `aspect≤0`, non-finite `sheetW`→`{0,0}`.
- `captureRectToImageGeom`: `({100,50,300,150},1000,800)→{w:0.2, aspect:0.5,
  at:[0.2,0.125]}`; corner-order independent; degenerate `x0==x1`→`{w:0,aspect:0}`;
  `sheetW=0`/non-finite guarded (no Infinity); `at` clamped `[0,1]`.
- `resizeImageFromCorner`: top-left invariant on a normal drag; **top-left still
  invariant at both clamp rails**; aspect preserved; a non-square `sheetW/sheetH`
  case (catches a width/height-swap bug).
- `clampImageWidth`: rails and just-outside (`0.019→0.02`, `2.001→2`, `NaN→`clamp).
- `aspectFromDims`: `(200,100)→0.5`; `w≤0`/non-finite→`1`.
- `pickEmbedFormat`: `jpeg→"jpg"`, `png→"png"`, `webp`/`gif`/`""`/`svg`→`null`.

Canvas wiring, upload/decode/downscale, capture, resize interaction, and PDF
export are integration — **hand-verified in the running app** (AGENTS.md: grep new
identifiers; load the app once). Phase 6 verification:

1. `cd web && npm run check` green (typecheck+lint+test+bench+build).
2. Sample plan, set a scale.
3. Marquee-screenshot a detail → lands within the marquee, drag it away, resize by
   the corner (aspect locked, top-left fixed), reload → persists.
4. Upload PNG + JPEG (rotated phone photo → correct orientation); move/resize/persist.
   Upload an SVG → refused. Upload a huge image → capped/refused, no OOM.
5. Export Takeoff JSON → new project → Import → images reappear.
6. Export Marked Set (light + dark) → images at right place/size; rotated sheet →
   image omitted (documented).
7. Delete (Delete key) → gone; RFI-link an image → badge shows and prints; image
   is NOT a row in the report's "Revisions noted".
8. Fill the aggregate budget → placement refused with a message (not a silent
   quota failure).

## Risks / edge cases (post-review)

- **Blob bloat / quota** — bounded by the three caps + surfaced quota errors;
  blob-store migration is future work (out of scope).
- **Rotated sheets** — RESOLVED in a follow-up: `imageDrawParams` derives the
  drawImage anchor + rotation from `toPage`, so images land correctly on rotated
  source pages in the marked set (was omitted in the first cut).
- **Large image shadows shapes/markups beneath** — images hit last among markups
  (other markups stay clickable); shapes under an image are shielded like a
  highlight box; documented ("move it to reach what's under it").
- **Stitched composites** — capture refuses (no single `pageObj`); upload is fine
  (export uses the composite `toPage`).
- **Privacy** — never in the contribution payload; but for Drive/JSON users the
  inline image *does* travel with the takeoff (a screenshot is a render of the
  PDF, which already syncs) — noted in the user guide so it isn't a surprise.
- **Corrupt `src`** — render returns null; export `pickEmbedFormat`→skip + try/catch.

## Out of scope

- A dedicated IndexedDB blob store for image bytes (future).
- An MCP `annotate` image verb (canvas only).
- Rotating/cropping after placement; multi-select; freehand (non-rect) capture.

## Review findings → resolution (audit trail)

| # | Finding (lens) | Resolution |
|---|---|---|
| Corr-D1 / Sec-8 | Capture inherits `rasterizeRegion`'s 4096 cap, blows the 1600 budget | Capture computes its own `min(1,1600/max(regW,regH))` factor |
| Corr-D2 / Reg-D2 | Render guard-fail falls through to text renderer → phantom box | `image` branch is self-contained, `return null` on guard-fail |
| Corr-D3 / Reg-D3 | `editMarkupAt` writes phantom `text` onto images | Add `|| m.type==="image"` at 4732 (required, not descriptive) |
| Corr-D4 | Rotated-sheet export mis-placed/mis-proportioned | Skip images on rotated sheets in v1; documented |
| Corr-D5 | Escape/tool-change must clear `imageAnchor` | Explicit `setImageAnchor(null)` at 2647 + tool switch |
| Corr-D7 | Over-drag parks `at` off-sheet | Clamp rect to sheet bounds before geom; `at` clamped in helper |
| Reg-D1 / Sec-3 | Quota failure silently loses whole takeoff | Autosave catch → `friendlyStoreError` + error state |
| Reg-D4 | Large image shadows shapes/markups | Images hit last; shielding documented |
| Reg-D5 / Sec-3 | No cap on image count | `MAX_IMAGE_MARKUP_BYTES` aggregate budget, refuse up front |
| Reg-D6 | Image becomes empty NOTE row in report | Exclude `image` at ReportPanel 827/840 |
| Reg-D7 | `reportJson` key-whitelist test breaks if edited | Leave `totals.js` untouched; noted for implementer |
| Reg-D8 | `image` in `placeMarkup` OR-list → no-op | Route only via the marquee branch |
| Reg-D9 | Resize arm could fire on a non-image markup | Gate the arm on resolved `type==="image"` |
| Test-1 | Resize math untested in `onPointerMove` | Pure `resizeImageFromCorner`, tested incl. clamp rails |
| Test-2 | Export sniff inlined/untested | Pure `pickEmbedFormat`, tested; skip on `null` |
| Test-3 | Upload re-encode invariant unstated | Unconditional re-encode; pure `aspectFromDims` guard |
| Test-4 | Duplicates `svgPlacedBox` silently | Documented width-anchor distinction; tall-case test |
| Test-5 | Coverage gaps (non-finite/degenerate/clamp) | Added to the test list above |
| Sec-1 | SVG upload not rejected | Explicit SVG reject + unconditional raster re-encode |
| Sec-2 | Pixel/decompression bomb | Decode-area guard via `createImageBitmap` resize |
| Sec-5 | JPEG EXIF orientation dropped | `createImageBitmap({imageOrientation:"from-image"})` |
| Sec-6/7 | Decode/encode failure, objectURL leak | try/catch + message; no `createObjectURL` |
| Sec-9 | "Never leaves browser" false for sync/export | User-guide note that images travel with the takeoff |
