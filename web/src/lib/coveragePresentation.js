export function coverageText(m, units = 'imperial') {
  const metric = units === 'metric';
  const count = m.basis === 'count';
  const linear = m.basis === 'linear' || m.basis === 'seam_lf';
  const factor = metric ? count ? 1 : linear ? 0.3048 : 0.09290304 : 1;
  const label = count ? 'EA' : metric ? linear ? 'm' : 'm²' : linear ? m.basis === 'seam_lf' ? 'seam LF' : 'LF' : 'SF';
  return '1 ' + (m.unit || 'unit') + ' / ' + Number(((m.per || 0) * factor).toFixed(6)) + ' ' + label;
}
