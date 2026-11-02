// Display adapters only: saved quantities, coverage and purchase rounding stay
// in their source units. A US liquid gallon is exactly 3.785411784 litres.
import { getLanguage, subscribeLanguage } from './i18n/core.js';
export const LITRES_PER_US_GALLON = 3.785411784;
const KEY = 'opentakeoff.liquid-unit.';
const listeners = new Set();
export function getMaterialUnit() {
  const lang = getLanguage();
  try { const v = localStorage.getItem(KEY + lang); if (v === 'l' || v === 'gal') return v; } catch { /* session default */ }
  return lang === 'ru' ? 'l' : 'gal';
}
export function setMaterialUnit(unit) {
  if (unit !== 'l' && unit !== 'gal') return;
  try { localStorage.setItem(KEY + getLanguage(), unit); } catch { /* no storage */ }
  listeners.forEach(f => f());
}
export function subscribeMaterialUnit(fn) {
  listeners.add(fn); const off = subscribeLanguage(fn);
  return () => { listeners.delete(fn); off(); };
}
if (typeof window !== 'undefined') window.addEventListener('storage', e => { if (!e.key || e.key.startsWith(KEY)) listeners.forEach(f => f()); });
export function liquidFactor(sourceUnit, targetUnit) {
  const u = String(sourceUnit || '').trim().toLowerCase();
  const gal = ['gal', 'gallon', 'gallons', 'us gal'].includes(u);
  const litre = ['l', 'л', 'litre', 'litres', 'liter', 'liters'].includes(u);
  if (!gal && !litre) return null; // never guess UK gallons, pails, mass, or unknown units
  return targetUnit === 'l' ? (gal ? LITRES_PER_US_GALLON : 1) : (litre ? 1 / LITRES_PER_US_GALLON : 1);
}
export function materialForDisplay(m, targetUnit) {
  const factor = liquidFactor(m.unit, targetUnit);
  if (factor === null) return m;
  return { ...m, unit: targetUnit, ...(typeof m.qty === 'number' ? { qty: m.qty * factor } : {}),
    ...(typeof m.per === 'number' ? { per: m.per / factor } : {}),
    ...(typeof m.price === 'number' ? { price: m.price / factor } : {}) };
}
export const materialRowsForDisplay = (rows, unit) => rows.map(r => ({ ...r, materials: (r.materials || []).map(m => materialForDisplay(m, unit)) }));
