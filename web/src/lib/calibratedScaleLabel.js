// Scales are real feet per baseline image pixel, independent of screen zoom.
// A PDF paper inch is 72 points times the baseline rendering scale.
export function calibratedScaleLabel(feetPerPixel, renderScale, units = 'metric') {
  if (!(feetPerPixel > 0) || !Number.isFinite(feetPerPixel) || !(renderScale > 0) || !Number.isFinite(renderScale)) return '';
  const feetPerPaperInch = feetPerPixel * 72 * renderScale;
  if (units === 'metric') return '1:' + Number((feetPerPaperInch * 12).toFixed(2));
  return '1" = ' + Number(feetPerPaperInch.toFixed(3)) + "'";
}
