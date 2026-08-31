// Live counter — the floating running-totals widget's pure half. The widget
// (components/LiveCounter.jsx) is a movable readout the estimator parks
// wherever they like; everything that can be node-tested lives here:
// row shaping over conditionTotals() output, quantity formatting, and the
// viewport clamp for the persisted position.
//
// Quantities shown are MEASURED (total_sf / lf / ea — multiplier applied,
// no waste): the number that moves as you trace, matching the panel chips,
// not the order quantity. Waste belongs on the Report.

export const COUNTER_POS_KEY = "ot.liveCounterPos.v1";
export const COUNTER_MIN_KEY = "ot.liveCounterMin.v1";

// conditionTotals rows → display rows. A condition can carry more than one
// unit (a tile floor with a border: SF and LF); every nonzero quantity gets a
// segment, ordered SF → LF → EA, so the row reads like the panel chip.
export function counterRows(totals, activeCondId) {
  return totals
    .filter((t) => t.shape_count > 0)
    .map((t) => {
      const qtys = [];
      if (t.total_sf) qtys.push({ qty: t.total_sf, unit: "SF" });
      if (t.lf) qtys.push({ qty: t.lf, unit: "LF" });
      if (t.ea) qtys.push({ qty: t.ea, unit: "EA" });
      return { id: t.id, tag: t.finish_tag, color: t.color, qtys, shapes: t.shape_count, active: t.id === activeCondId };
    })
    .filter((r) => r.qtys.length);
}

// 1234.5 → "1,234.5" — thousands separators, up to 2 decimals, trailing
// zeros trimmed. EA counts arrive integral and print integral.
export function fmtQty(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

// Keep the widget reachable: at least a grab-strip of it stays inside the
// viewport on load and after a window resize.
export function clampPos(pos, size, vw, vh, margin = 8) {
  const w = Math.max(1, size?.w || 1), h = Math.max(1, size?.h || 1);
  return {
    x: Math.min(Math.max(Number(pos?.x) || 0, margin - w + 40), vw - 40),
    y: Math.min(Math.max(Number(pos?.y) || 0, margin), Math.max(margin, vh - h)),
  };
}

// localStorage round-trip, always guarded — private windows and previews
// throw on access, and the widget must render fine with no stored value.
export function loadStored(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
export function saveStored(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* per-viewer convenience only */ }
}
