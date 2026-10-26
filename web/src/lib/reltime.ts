// Relative-age + explicit-UTC-timestamp formatting for the Captures panel row.
// A UI helper (unlike markupImage.ts, whose header forbids Date) — it MAY use
// Date/Intl. Both functions take their instant as an argument (relativeAge
// also takes "now") so callers are deterministic and node-testable: no
// internal `Date.now()`, no live tick (see the plan's "no live-tick" note —
// the panel re-renders on interaction and the hover title gives the exact
// time, so staleness between renders is accepted by design).
//
// Total functions: an unparseable/non-string `iso` never throws — it degrades
// to "" so a bad/legacy record renders no age chip rather than crashing the row.

// Bucket thresholds, in ms, checked against the RAW elapsed time (not the
// rounded display value) — so e.g. "23h ago" and "yesterday" split cleanly at
// the 24h wall-clock boundary even though rounding alone could blur it.
const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

// Parse an ISO-8601 instant → epoch ms, or NaN for anything that isn't a
// parseable string (guards both a wrong runtime type and a malformed string
// in one place, since Date.parse only accepts a string argument usefully).
function parseIsoMs(iso: string): number {
  return typeof iso === "string" ? Date.parse(iso) : NaN;
}

// "Aug 25, 2026" — UTC, independent of the reader's local zone (a plan shared
// across time zones must show the same day for the same instant).
function formatUtcDate(ms: number): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(ms));
}

// Compact natural-language age of `iso` relative to `nowMs`:
//  <45s → "just now" | <60m → "<n>m ago" | <24h → "<n>h ago" | <48h →
//  "yesterday" | <7d → "<n>d ago" | else → a plain UTC date. `nowMs` is a
// caller-supplied argument (not `Date.now()`) so a fixed epoch pins every
// bucket boundary in tests.
export function relativeAge(iso: string, nowMs: number): string {
  const t = parseIsoMs(iso);
  if (!Number.isFinite(t) || !Number.isFinite(nowMs)) return "";
  const diffMs = nowMs - t;
  if (diffMs / 1000 < 45) return "just now";
  // Rounds to the nearest unit; the "min 1" floor for minutes falls out for
  // free — every diffMs in this bucket is >= 45_000ms (0.75min), which
  // already rounds up to 1.
  if (diffMs < 60 * MIN_MS) return `${Math.round(diffMs / MIN_MS)}m ago`;
  if (diffMs < DAY_MS) return `${Math.round(diffMs / HOUR_MS)}h ago`;
  if (diffMs < 2 * DAY_MS) return "yesterday";
  if (diffMs < 7 * DAY_MS) return `${Math.round(diffMs / DAY_MS)}d ago`;
  return formatUtcDate(t);
}

// Explicit human timestamp with the zone spelled out — the hover `title` that
// backs up `relativeAge`'s compact (and eventually stale) chip with the exact
// instant. e.g. "Aug 25, 2026, 7:58 PM (UTC)". Formatted in UTC so it reads
// the same on every machine regardless of the reader's local zone.
export function absoluteUtc(iso: string): string {
  const t = parseIsoMs(iso);
  if (!Number.isFinite(t)) return "";
  const s = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
  }).format(new Date(t));
  return `${s} (UTC)`;
}
