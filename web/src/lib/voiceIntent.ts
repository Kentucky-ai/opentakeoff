// Voice transcript → intent parser (RFC #59, slice 1). PURE and dependency-free
// on purpose: it takes a raw STT transcript string plus a context snapshot
// (live condition tags + label vocabulary) and returns ONE typed intent or a
// typed rejection. It never guesses: ambiguous or partial input rejects —
// "carpet one seven" is a rejection, not CPT-1 + waste 7, because both that
// reading and a mis-heard CPT-17 are plausible. Audio capture / WASM STT /
// canvas wiring live in later slices; the intents here map 1:1 onto existing
// app actions (activateCondition / mintCondition / updateCond / activateLabel).
// Known v1 limit: keyword-first dispatch means a condition literally tagged
// "NOTE-1" or "LABEL-1" can't be voice-activated.

export type VoiceContext = {
  conditionTags: string[]; // live finish_tag values, e.g. ["CPT-1","VCT-1","P-2","C"]
  shapeLabels: string[];   // project label vocabulary (TakeoffCanvas shape_labels)
};

export type Intent =
  | { kind: "activate_condition"; tag: string; known: boolean; waste?: number }
  | { kind: "set_waste"; waste: number }
  | { kind: "set_label"; label: string; known: boolean }
  | { kind: "clear_label" }
  | { kind: "add_note"; text: string };

export type RejectReason =
  | "empty"          // blank/whitespace transcript
  | "unrecognized"   // no production matched at all
  | "unknown_tag"    // tag-shaped lead but not in ctx and not a Div-9 pattern
  | "bad_number"     // waste keyword present but number missing/invalid/out of range
  | "trailing_words"; // a production matched but tokens were left over

export type VoiceParse =
  | { ok: true; intent: Intent }
  | { ok: false; reason: RejectReason };

// ---------------------------------------------------------------------------
// data tables

// Inclusion rule: target is a grammar keyword, true homophone in general
// American English, and the source has no plausible literal use mid-command.
const HOMOPHONES: Record<string, string> = { waist: "waste" };

// Common Div-9 finish-tag prefixes; <prefix>-<1..99> is offerable-to-create
// even when not in the live conditions list.
const DIV9_PREFIXES = new Set(["CPT", "LVT", "VCT", "CT", "RB", "TR"]);

// Spoken synonym phrases → tag prefix, longest match first. Bare "vinyl"
// (LVT vs VCT) and "carpet tile" (CPT vs CT) are deliberately absent: reject
// rather than guess.
const SYNONYM_PHRASES: [string[], string][] = [
  [["luxury", "vinyl", "tile"], "LVT"],
  [["vinyl", "composition", "tile"], "VCT"],
  [["ceramic", "tile"], "CT"],
  [["rubber", "base"], "RB"],
  [["wall", "base"], "RB"],
  [["luxury", "vinyl"], "LVT"],
  [["carpet"], "CPT"],
  [["tile"], "CT"],
  [["ceramic"], "CT"],
  [["base"], "RB"],
  [["transition"], "TR"],
];

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9,
};
const TEENS: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
};

// ---------------------------------------------------------------------------
// tokenizing / normalization

// Lowercase, split, strip punctuation except "." / "," inside digit runs and
// "-" inside alphanumeric tokens, apply the homophone map, then collapse runs
// of 2+ single-letter tokens ("l v t" → "lvt"). Safe because only the command
// path consumes normalized tokens — note/label free text comes from the raw
// transcript.
function normalizeTokens(transcript: string): string[] {
  const rough = transcript
    .toLowerCase()
    .split(/\s+/)
    .flatMap((w) => {
      const kept = w.replace(/[^a-z0-9.,%-]/g, "");
      // trim punctuation that isn't between digits/alphanumerics
      const clean = kept
        .replace(/^[.,%-]+/, "")
        .replace(/[.,-]+$/, "")
        .replace(/,(?!\d)/g, "")
        .replace(/\.(?!\d)/g, "");
      // split a glued unit sign ("12%") into its own token
      const pct = /^(.+)%$/.exec(clean);
      if (pct) return [pct[1], "%"];
      // split STT-hyphenated word compounds ("twenty-five" → "twenty","five");
      // alpha-digit tags like "cpt-1" keep their hyphen
      if (/^[a-z]+(-[a-z]+)+$/.test(clean)) return clean.split("-");
      return [clean];
    })
    .filter(Boolean)
    .map((w) => HOMOPHONES[w] ?? w);

  // collapse letter runs
  const out: string[] = [];
  let i = 0;
  while (i < rough.length) {
    if (/^[a-z]$/.test(rough[i])) {
      let j = i;
      while (j < rough.length && /^[a-z]$/.test(rough[j])) j++;
      if (j - i >= 2) {
        out.push(rough.slice(i, j).join(""));
        i = j;
        continue;
      }
    }
    out.push(rough[i]);
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// numbers

/**
 * Parse a spoken or written number: digits ("7", "7.5", locale "7,5"),
 * number words zero–ninety-nine composed tens+units only ("twenty five"),
 * "hundred"/"one hundred" = 100, and "X point Y". Digit-by-digit speech is
 * NOT composed ("one seven" is null, not 17) — that is what keeps
 * "carpet one seven" deterministic. Returns null when the text is not
 * exactly one number.
 */
export function parseSpokenNumber(text: string): number | null {
  const tokens = normalizeTokens(text);
  if (tokens.length === 0) return null;
  const res = takeNumber(tokens, 0);
  if (!res || res.next !== tokens.length) return null;
  return res.value;
}

function wordValue(tok: string): number | null {
  if (tok in UNITS) return UNITS[tok];
  if (tok in TEENS) return TEENS[tok];
  if (tok in TENS) return TENS[tok];
  return null;
}

// Consume one number starting at tokens[i]; null if none there.
function takeNumber(tokens: string[], i: number): { value: number; next: number } | null {
  const t = tokens[i];
  if (t === undefined) return null;

  // digits: "7", "7.5", "7,5" (comma decimal only before 1-2 digits), "1,000"
  if (/^\d/.test(t)) {
    let s = t;
    if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(",", "."); // locale decimal
    else s = s.replace(/,/g, ""); // thousands separators
    if (!/^\d+(\.\d+)?$/.test(s)) return null;
    return { value: parseFloat(s), next: i + 1 };
  }

  // words: unit / teen / ten / ten+unit / (one) hundred / X point Y
  let value: number;
  let next: number;
  if (t === "hundred") {
    value = 100;
    next = i + 1;
  } else if (t === "one" && tokens[i + 1] === "hundred") {
    value = 100;
    next = i + 2;
  } else if (t in TENS) {
    value = TENS[t];
    next = i + 1;
    const unit = tokens[next];
    if (unit !== undefined && unit in UNITS && UNITS[unit] !== 0) {
      value += UNITS[unit];
      next++;
    }
  } else {
    const v = wordValue(t);
    if (v === null) return null;
    value = v;
    next = i + 1;
  }

  // "seven point five"
  if (tokens[next] === "point") {
    const frac = tokens[next + 1];
    const fv = frac !== undefined ? wordValue(frac) : null;
    if (fv === null || fv > 9) return null;
    value = value + fv / 10;
    next += 2;
  }
  return { value, next };
}

// ---------------------------------------------------------------------------
// tags

/** Canonicalize a tag: uppercase, unify "cpt 1"/"cpt1"/"cpt-1" → "CPT-1". */
function canonTag(s: string): string {
  const m = /^([a-z]+)[\s-]?(\d+)$/i.exec(s.trim());
  if (m) return `${m[1].toUpperCase()}-${m[2]}`;
  return s.trim().toUpperCase().replace(/\s+/g, "-");
}

function ctxTagLookup(ctx: VoiceContext): Map<string, string> {
  const map = new Map<string, string>();
  for (const tag of ctx.conditionTags) map.set(canonTag(tag), tag);
  return map;
}

// Consume one condition tag starting at tokens[i]:
//   • synonym phrase (+ integer 1-99), e.g. "carpet one"
//   • prefix token + integer, e.g. "cpt one", "cpt 1"
//   • pre-joined token, e.g. "cpt-1" / "cpt1"
//   • any ctx tag spoken plainly, e.g. "p two", bare "c"
// Returns the ctx LITERAL for live tags (so callers can look conditions up by
// exact finish_tag) or the canonical tag for create-offers; null if nothing
// tag-shaped starts here.
function takeTag(
  tokens: string[],
  i: number,
  ctx: VoiceContext,
): { tag: string; known: boolean; next: number } | null {
  const live = ctxTagLookup(ctx);

  const finish = (prefix: string, num: number | null, next: number) => {
    const canon = num === null ? prefix.toUpperCase() : canonTag(`${prefix}-${num}`);
    const hit = live.get(canon);
    if (hit !== undefined) return { tag: hit, known: true, next };
    const bare = canon.split("-")[0];
    if (num !== null && Number.isInteger(num) && num >= 1 && num <= 99 && DIV9_PREFIXES.has(bare))
      return { tag: canon, known: false, next };
    return null;
  };

  // synonym phrases, longest first
  for (const [phrase, prefix] of SYNONYM_PHRASES) {
    if (phrase.every((w, k) => tokens[i + k] === w)) {
      const after = i + phrase.length;
      const num = takeNumber(tokens, after);
      if (num) {
        const r = finish(prefix, num.value, num.next);
        if (r) return r;
      }
      // synonym with no number only matches a bare live tag (e.g. ctx "CPT")
      const r = finish(prefix, null, after);
      if (r) return r;
      return null; // synonym consumed but nothing valid — caller rejects as unknown_tag
    }
  }

  const t = tokens[i];
  if (t === undefined) return null;

  // pre-joined "cpt-1" / "cpt1"
  const joined = /^([a-z]+)-?(\d+)$/.exec(t);
  if (joined) return finish(joined[1], parseInt(joined[2], 10), i + 1);

  // alpha token (possibly letter-run-collapsed) + optional number
  if (/^[a-z]+$/.test(t)) {
    const num = takeNumber(tokens, i + 1);
    if (num && Number.isInteger(num.value)) {
      const r = finish(t, num.value, num.next);
      if (r) return r;
    }
    return finish(t, null, i + 1);
  }
  return null;
}

// ---------------------------------------------------------------------------
// free text (note / label): remainder of the RAW transcript, original casing

function rawRemainder(transcript: string, keyword: string): string {
  const re = new RegExp(`^\\s*${keyword}\\b[:,]?\\s*`, "i");
  return transcript.replace(re, "").trim();
}

// ---------------------------------------------------------------------------
// dispatch

/**
 * Parse one push-to-talk transcript into one intent, or a typed rejection.
 * Grammar (keyword-first):
 *   clear label | label <text> | note <text> | waste <n> | <tag> [waste <n>]
 * Anything else — including a matched production with leftover tokens —
 * rejects. Never guesses.
 */
export function parseVoiceIntent(transcript: string, ctx: VoiceContext): VoiceParse {
  if (!transcript || !transcript.trim()) return { ok: false, reason: "empty" };
  const tokens = normalizeTokens(transcript);
  if (tokens.length === 0) return { ok: false, reason: "empty" };

  // clear label
  if (tokens[0] === "clear" && tokens[1] === "label") {
    if (tokens.length > 2) return { ok: false, reason: "trailing_words" };
    return { ok: true, intent: { kind: "clear_label" } };
  }

  // label <text>
  if (tokens[0] === "label") {
    const text = rawRemainder(transcript, "label");
    if (!text) return { ok: false, reason: "unrecognized" };
    const hit = ctx.shapeLabels.find((l) => l.toLowerCase() === text.toLowerCase());
    return hit !== undefined
      ? { ok: true, intent: { kind: "set_label", label: hit, known: true } }
      : { ok: true, intent: { kind: "set_label", label: text, known: false } };
  }

  // note <text>
  if (tokens[0] === "note") {
    const text = rawRemainder(transcript, "note");
    if (!text) return { ok: false, reason: "unrecognized" };
    return { ok: true, intent: { kind: "add_note", text } };
  }

  // waste <n>
  if (tokens[0] === "waste") {
    const waste = takeWasteValue(tokens, 1);
    if (waste === null) return { ok: false, reason: "bad_number" };
    if (waste.next !== tokens.length) return { ok: false, reason: "trailing_words" };
    return { ok: true, intent: { kind: "set_waste", waste: waste.value } };
  }

  // <tag> [waste <n>]
  const tag = takeTag(tokens, 0, ctx);
  if (tag) {
    let i = tag.next;
    let waste: number | undefined;
    if (tokens[i] === "waste") {
      const w = takeWasteValue(tokens, i + 1);
      if (w === null) return { ok: false, reason: "bad_number" };
      waste = w.value;
      i = w.next;
    }
    if (i !== tokens.length) return { ok: false, reason: "trailing_words" };
    return {
      ok: true,
      intent: {
        kind: "activate_condition",
        tag: tag.tag,
        known: tag.known,
        ...(waste !== undefined ? { waste } : {}),
      },
    };
  }

  // something alpha-leading that looked tag-ish but resolved to nothing
  if (/^[a-z]+$/.test(tokens[0]) && couldBeTagLead(tokens, ctx))
    return { ok: false, reason: "unknown_tag" };

  return { ok: false, reason: "unrecognized" };
}

// Waste value: number in [0,100], with an optional trailing "percent"/"%"
// dropped. Null when missing/invalid/out of range.
function takeWasteValue(tokens: string[], i: number): { value: number; next: number } | null {
  const num = takeNumber(tokens, i);
  if (!num) return null;
  let next = num.next;
  if (tokens[next] === "percent" || tokens[next] === "%") next++;
  if (num.value < 0 || num.value > 100) return null;
  return { value: num.value, next };
}

// Did the transcript LEAD with tag vocabulary (a synonym word or a live-tag
// first token)? Distinguishes "carpet" (unknown_tag: tag-shaped but
// unresolvable) from "hello world" (unrecognized).
function couldBeTagLead(tokens: string[], ctx: VoiceContext): boolean {
  const t = tokens[0];
  for (const [phrase] of SYNONYM_PHRASES) if (phrase[0] === t) return true;
  const live = ctxTagLookup(ctx);
  for (const canon of live.keys()) if (canon.split("-")[0].toLowerCase() === t) return true;
  return false;
}
