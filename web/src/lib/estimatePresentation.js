// Reversible presentation units. Costs and the arithmetic engine stay unchanged.
import { materialForDisplay } from './materialUnits.js';
export function pricingDisplay(unit, metric) {
  if (!metric) return { unit, factor: 1 };
  return ({ SF: {unit:'m²',factor:0.09290304}, SY:{unit:'m²',factor:0.83612736}, LF:{unit:'m',factor:0.3048}, EA:{unit:'EA',factor:1} })[unit] || {unit,factor:1};
}
export function estimateForDisplay(est, metric, liquidUnit) {
  return {...est, lines: est.lines.map(l => {
    const {unit,factor} = pricingDisplay(l.unit,metric);
    return {...l, unit, source_unit:l.unit, quantity_factor:factor,
      material_qty:l.material_qty*factor, labor_qty:l.labor_qty*factor,
      material_rate:l.material_rate === null ? null : l.material_rate/factor,
      labor_rate:l.labor_rate === null ? null : l.labor_rate/factor,
      materials:l.materials.map(m => materialForDisplay(m,liquidUnit))};
  })};
}
