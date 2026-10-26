// The scan star's geometry — the agent's mark (brand/marks.jsx draws it in the app, pdfWatermark.js
// on every exported PDF). A four-point star cut into horizontal scan rows. Row half-widths follow a
// pinched astroid, w = reach·(1 − |y|^p)^q, so the points draw out thin; the centre row runs tip to
// tip. Few rows (icon sizes) get a softer pinch and fatter bars so the star still reads at 12px.
// Drawn in its own space: y in −1..1 (down), x in −reach..reach. `rows` should be odd.
export function scanStarRows(rows = 23, reach = 2.4) {
  const [p, q, fill] = rows <= 7 ? [0.9, 1.5, 0.7] : rows <= 11 ? [0.8, 1.7, 0.64] : [0.7, 1.9, 0.64];
  const pitch = 2 / rows, h = pitch * fill, mid = (rows - 1) / 2;
  return Array.from({ length: rows }, (_, i) => {
    const y = -1 + pitch * (i + 0.5);
    const w = i === mid ? reach : Math.max(h / 2, reach * Math.max(0, 1 - Math.abs(y) ** p) ** q);
    return { x: -w, y: y - h / 2, w: 2 * w, h, ring: Math.abs(i - mid) };
  });
}
