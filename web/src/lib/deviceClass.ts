// Phone-class device detection — the ONE switch the mobile-survival paths key
// off (tilePool pool size + crash recovery, tileCompositor bitmap budget).
// Deliberately conservative: a false NEGATIVE just means desktop behavior,
// which is the well-tested path. Desktop behavior is byte-for-byte unchanged
// when this is false — that's the contract, not an optimization note.
//
// Signals, any one of which marks the device low-memory:
// - navigator.deviceMemory ≤ 4 (Chrome/Android expose it; Safari never does)
// - iPhone/iPad/Android UA
// - iPadOS masquerading as macOS: "Macintosh" UA + real multi-touch
export const LOW_MEMORY_DEVICE: boolean = (() => {
  if (typeof navigator === "undefined") return false;
  const dm = (navigator as { deviceMemory?: number }).deviceMemory;
  if (typeof dm === "number" && dm <= 4) return true;
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod|Android/i.test(ua)) return true;
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return true;
  return false;
})();
