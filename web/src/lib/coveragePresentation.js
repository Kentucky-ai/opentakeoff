// Coverage cell text for CSV/Excel materials tabs. Imperial output matches
// totals.js coverageLabel byte for byte (rule "each" and an item's own waste %
// included); metric converts the per-basis rate to m / m².
export function coverageText(m, units = 'imperial') {
  const metric = units === 'metric';
  const count = m.basis === 'count';
  const linear = m.basis === 'linear' || m.basis === 'seam_lf';
  const factor = metric ? count ? 1 : linear ? 0.3048 : 0.09290304 : 1;
  const label = count ? 'EA' : metric ? linear ? 'm' : 'm²' : linear ? m.basis === 'seam_lf' ? 'seam LF' : 'LF' : 'SF';
  const u = m.unit || 'unit';
  const per = Number(m.per) || 0;
  const base = m.rule === 'each'
    ? Number((per / factor).toFixed(6)) + ' ' + u + ' / 1 ' + label
    : '1 ' + u + ' / ' + Number((per * factor).toFixed(6)) + ' ' + label;
  const w = Math.max(0, Number(m.waste_pct) || 0);
  return w > 0 ? base + ' + ' + w + '% waste' : base;
}
