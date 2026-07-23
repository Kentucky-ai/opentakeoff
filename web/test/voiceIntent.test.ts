// Voice transcript → intent parser (RFC #59, slice 1). Invariants:
//   - one transcript → one intent or a typed rejection; NEVER a guess —
//     "carpet one seven" rejects (CPT-1+waste-7 vs mis-heard CPT-17 are both
//     plausible), leftover tokens after any production reject;
//   - number words compose tens+units only ("twenty five"), never digit-by-
//     digit ("one seven" ≠ 17); decimals accept "seven point five", "7.5",
//     and locale "7,5"; waste is range-checked 0–100;
//   - homophone map is exactly waist→waste (keyword, true homophone, no
//     literal mid-command use); no letter-name mappings;
//   - ctx tag matching is case-insensitive EXACT after canonicalization
//     (cpt 1 / cpt1 / cpt-1 → CPT-1), no fuzzy ever; live matches return the
//     ctx LITERAL (directly actionable as finish_tag), while unknown Div-9
//     patterns (CPT/LVT/VCT/CT/RB/TR + 1-99) come back canonical + known:false
//     for a create-offer;
//   - note/label free text is taken verbatim from the RAW transcript, so
//     normalization never corrupts user prose.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseVoiceIntent,
  parseSpokenNumber,
  type Intent,
  type RejectReason,
  type VoiceContext,
  type VoiceParse,
} from "../src/lib/voiceIntent.js";

const CTX: VoiceContext = {
  conditionTags: ["CPT-1", "VCT-1", "RB-1", "P-2", "C"],
  shapeLabels: ["Phase 1", "Alternate"],
};

type Case = { name: string; input: string; ctx?: Partial<VoiceContext>; expect: VoiceParse };

const ok = (intent: Intent): VoiceParse => ({ ok: true, intent });
const no = (reason: RejectReason): VoiceParse => ({ ok: false, reason });

const CASES: Case[] = [
  // 1. activate, literal tag
  { name: "literal tag words: cpt one", input: "cpt one", expect: ok({ kind: "activate_condition", tag: "CPT-1", known: true }) },
  { name: "literal tag joined: CPT-1", input: "CPT-1", expect: ok({ kind: "activate_condition", tag: "CPT-1", known: true }) },
  { name: "literal tag joined no hyphen: cpt1", input: "cpt1", expect: ok({ kind: "activate_condition", tag: "CPT-1", known: true }) },
  { name: "spelled letters collapse: c p t 1", input: "c p t 1", expect: ok({ kind: "activate_condition", tag: "CPT-1", known: true }) },
  { name: "arbitrary live tag: p two", input: "p two", expect: ok({ kind: "activate_condition", tag: "P-2", known: true }) },
  { name: "lone-letter live tag: c", input: "c", expect: ok({ kind: "activate_condition", tag: "C", known: true }) },
  { name: "spelled letters: v c t one", input: "v c t one", expect: ok({ kind: "activate_condition", tag: "VCT-1", known: true }) },

  // 2. activate via synonym
  { name: "synonym: carpet one", input: "carpet one", expect: ok({ kind: "activate_condition", tag: "CPT-1", known: true }) },
  { name: "synonym phrase: rubber base one", input: "rubber base one", expect: ok({ kind: "activate_condition", tag: "RB-1", known: true }) },
  { name: "synonym: base one", input: "base one", expect: ok({ kind: "activate_condition", tag: "RB-1", known: true }) },
  { name: "synonym long phrase, not live: luxury vinyl tile two", input: "luxury vinyl tile two", expect: ok({ kind: "activate_condition", tag: "LVT-2", known: false }) },

  // 3. activate unknown Div-9 pattern → known:false (create offer)
  { name: "unknown pattern: tile three", input: "tile three", expect: ok({ kind: "activate_condition", tag: "CT-3", known: false }) },
  { name: "unknown pattern: transition one", input: "transition one", expect: ok({ kind: "activate_condition", tag: "TR-1", known: false }) },
  { name: "unknown pattern digits: lvt 4", input: "lvt 4", expect: ok({ kind: "activate_condition", tag: "LVT-4", known: false }) },

  // 3b. live tags with non-canonical finish_tags come back as the ctx LITERAL
  //     (maintainer note on #79: the wiring slice looks conditions up by exact
  //     finish_tag, so the parser must hand back the tag as the project spells it)
  { name: "non-canonical live tag, spoken: cpt one", input: "cpt one", ctx: { conditionTags: ["cpt 1"] }, expect: ok({ kind: "activate_condition", tag: "cpt 1", known: true }) },
  { name: "non-canonical live tag, joined: cpt-1", input: "cpt-1", ctx: { conditionTags: ["cpt 1"] }, expect: ok({ kind: "activate_condition", tag: "cpt 1", known: true }) },
  { name: "non-canonical live tag via synonym: carpet one", input: "carpet one", ctx: { conditionTags: ["cpt 1"] }, expect: ok({ kind: "activate_condition", tag: "cpt 1", known: true }) },
  { name: "mixed-case live tag: lvt two", input: "lvt two", ctx: { conditionTags: ["Lvt-2"] }, expect: ok({ kind: "activate_condition", tag: "Lvt-2", known: true }) },
  { name: "non-canonical live tag + waste combo", input: "cpt one waste seven", ctx: { conditionTags: ["cpt 1"] }, expect: ok({ kind: "activate_condition", tag: "cpt 1", known: true, waste: 7 }) },

  // 4. activate + waste combo
  { name: "combo: carpet one waste seven", input: "carpet one waste seven", expect: ok({ kind: "activate_condition", tag: "CPT-1", known: true, waste: 7 }) },
  { name: "combo with comma + decimal: carpet one, waste 7.5", input: "carpet one, waste 7.5", expect: ok({ kind: "activate_condition", tag: "CPT-1", known: true, waste: 7.5 }) },
  { name: "combo homophone + percent: cpt one waist ten percent", input: "cpt one waist ten percent", expect: ok({ kind: "activate_condition", tag: "CPT-1", known: true, waste: 10 }) },
  { name: "combo on unknown pattern: tile two waste five", input: "tile two waste five", expect: ok({ kind: "activate_condition", tag: "CT-2", known: false, waste: 5 }) },

  // 5. waste alone
  { name: "waste word: waste seven", input: "waste seven", expect: ok({ kind: "set_waste", waste: 7 }) },
  { name: "waste digits: waste 25", input: "waste 25", expect: ok({ kind: "set_waste", waste: 25 }) },
  { name: "waste compound words: waste twenty five", input: "waste twenty five", expect: ok({ kind: "set_waste", waste: 25 }) },
  { name: "STT-hyphenated compound: waste twenty-five", input: "waste twenty-five", expect: ok({ kind: "set_waste", waste: 25 }) },
  { name: "waste one hundred", input: "waste one hundred", expect: ok({ kind: "set_waste", waste: 100 }) },
  { name: "waste zero", input: "waste zero", expect: ok({ kind: "set_waste", waste: 0 }) },
  { name: "waste with percent sign: waste 12%", input: "waste 12%", expect: ok({ kind: "set_waste", waste: 12 }) },
  { name: "bare waste rejects", input: "waste", expect: no("bad_number") },
  { name: "waste out of range: waste 101", input: "waste 101", expect: no("bad_number") },
  { name: "waste non-number: waste banana", input: "waste banana", expect: no("bad_number") },

  // 6. label
  { name: "label known, canonical casing: label phase 1", input: "label phase 1", expect: ok({ kind: "set_label", label: "Phase 1", known: true }) },
  { name: "label known exact: label Alternate", input: "label Alternate", expect: ok({ kind: "set_label", label: "Alternate", known: true }) },
  { name: "label unknown preserves casing: label East Mezzanine", input: "label East Mezzanine", expect: ok({ kind: "set_label", label: "East Mezzanine", known: false }) },
  { name: "bare label rejects", input: "label", expect: no("unrecognized") },

  // 7. clear label
  { name: "clear label", input: "clear label", expect: ok({ kind: "clear_label" }) },
  { name: "bare clear rejects", input: "clear", expect: no("unrecognized") },
  { name: "clear label with trailing words rejects", input: "clear label now", expect: no("trailing_words") },

  // 8. note — verbatim raw text, keyword-first dispatch shields prose
  { name: "note verbatim", input: "note verify scale on A101", expect: ok({ kind: "add_note", text: "verify scale on A101" }) },
  { name: "note with colon and casing", input: "Note: verify sheet vinyl in Soiled Utility with GC", expect: ok({ kind: "add_note", text: "verify sheet vinyl in Soiled Utility with GC" }) },
  { name: "note containing grammar keywords stays prose", input: "note 7,5 waste on cpt", expect: ok({ kind: "add_note", text: "7,5 waste on cpt" }) },
  { name: "bare note rejects", input: "note", expect: no("unrecognized") },

  // 9. ambiguity (RFC-mandated): reject, never guess
  { name: "carpet one seven rejects (tag+waste vs CPT-17 both plausible)", input: "carpet one seven", expect: no("trailing_words") },
  { name: "carpet one waste (no number) rejects", input: "carpet one waste", expect: no("bad_number") },
  { name: "bare carpet rejects as unknown tag", input: "carpet", expect: no("unknown_tag") },
  { name: "tag then garbage rejects: cpt one please", input: "cpt one please", expect: no("trailing_words") },

  // 10. homophones (RFC-mandated)
  { name: "waist seven → set_waste", input: "waist seven", expect: ok({ kind: "set_waste", waste: 7 }) },
  { name: "corpus-earned homophone: rubber bass one", input: "rubber bass one", expect: ok({ kind: "activate_condition", tag: "RB-1", known: true }) },

  // 10b. NUMBER-SLOT homophones (corpus-earned: real STT writes "to" for "two"
  //      in number positions). Slot-restricted — prose keeps its words.
  { name: "number-slot to: transition to → TR-2", input: "transition to", expect: ok({ kind: "activate_condition", tag: "TR-2", known: false }) },
  { name: "number-slot too: waste too", input: "waste too", expect: ok({ kind: "set_waste", waste: 2 }) },
  { name: "number-slot won: tile won", input: "tile won", expect: ok({ kind: "activate_condition", tag: "CT-1", known: false }) },
  { name: "note prose keeps literal 'to' (slot restriction)", input: "note go to room two", expect: ok({ kind: "add_note", text: "go to room two" }) },

  // 11. numbers as words vs digits (RFC-mandated)
  { name: "waste seventeen (teen word)", input: "waste seventeen", expect: ok({ kind: "set_waste", waste: 17 }) },
  { name: "waste 17 (digits)", input: "waste 17", expect: ok({ kind: "set_waste", waste: 17 }) },
  { name: "no digit-by-digit composition: waste one seven rejects", input: "waste one seven", expect: no("trailing_words") },

  // 12. locale number formats (RFC-mandated)
  { name: "locale comma decimal: waste 7,5", input: "waste 7,5", expect: ok({ kind: "set_waste", waste: 7.5 }) },
  { name: "dot decimal: waste 7.5", input: "waste 7.5", expect: ok({ kind: "set_waste", waste: 7.5 }) },
  { name: "spoken decimal: waste seven point five", input: "waste seven point five", expect: ok({ kind: "set_waste", waste: 7.5 }) },
  { name: "thousands separator out of range: waste 1,000", input: "waste 1,000", expect: no("bad_number") },

  // 13. garbage (RFC-mandated): no action, never a guess
  { name: "empty string", input: "", expect: no("empty") },
  { name: "whitespace only", input: "   ", expect: no("empty") },
  { name: "hello world", input: "hello world", expect: no("unrecognized") },
  { name: "lone number word", input: "seven", expect: no("unrecognized") },
  { name: "prose sentence", input: "the quick brown fox", expect: no("unrecognized") },

  // 14. no-fuzzy discipline
  { name: "plural synonym rejects: carpets one", input: "carpets one", expect: no("unrecognized") },
  { name: "near-prefix rejects: cptx one", input: "cptx one", expect: no("unrecognized") },
  { name: "unmapped material rejects: granite one", input: "granite one", expect: no("unrecognized") },
  { name: "ambiguous bare vinyl rejects: vinyl one", input: "vinyl one", expect: no("unknown_tag") },

  // 16. deixis (RFC #59 deixis slice) — utterance-terminal riders. Matrix:
  // every token × (tag | bare | +waste | +label). Bare/tagless forms need
  // ctx.hasActiveCondition; the parser marks THAT the speaker aimed, never where.
  // tag × every token
  { name: "deixis tag: cpt one this room", input: "cpt one this room", expect: ok({ kind: "trace_at_cursor", tag: "CPT-1", known: true }) },
  { name: "deixis tag: carpet one here", input: "carpet one here", expect: ok({ kind: "trace_at_cursor", tag: "CPT-1", known: true }) },
  { name: "deixis tag with comma: CPT-1, this one", input: "CPT-1, this one", expect: ok({ kind: "trace_at_cursor", tag: "CPT-1", known: true }) },
  { name: "deixis tag create-offer: tile three right here", input: "tile three right here", expect: ok({ kind: "trace_at_cursor", tag: "CT-3", known: false }) },
  // bare × every token (active condition present)
  { name: "bare deixis: this room", input: "this room", ctx: { hasActiveCondition: true }, expect: ok({ kind: "trace_at_cursor" }) },
  { name: "bare deixis: here", input: "here", ctx: { hasActiveCondition: true }, expect: ok({ kind: "trace_at_cursor" }) },
  { name: "bare deixis: this one", input: "this one", ctx: { hasActiveCondition: true }, expect: ok({ kind: "trace_at_cursor" }) },
  { name: "bare deixis: right here", input: "right here", ctx: { hasActiveCondition: true }, expect: ok({ kind: "trace_at_cursor" }) },
  // +waste × every token
  { name: "deixis+waste: carpet one waste seven this room", input: "carpet one waste seven this room", expect: ok({ kind: "trace_at_cursor", tag: "CPT-1", known: true, waste: 7 }) },
  { name: "deixis+waste decimal: cpt one waste 7.5 here", input: "cpt one waste 7.5 here", expect: ok({ kind: "trace_at_cursor", tag: "CPT-1", known: true, waste: 7.5 }) },
  { name: "deixis+waste rider, tagless: waste ten this one", input: "waste ten this one", ctx: { hasActiveCondition: true }, expect: ok({ kind: "trace_at_cursor", waste: 10 }) },
  { name: "deixis+waste homophone+percent: cpt one waist twelve percent right here", input: "cpt one waist twelve percent right here", expect: ok({ kind: "trace_at_cursor", tag: "CPT-1", known: true, waste: 12 }) },
  // +label × every token (known labels come back in vocabulary casing; unknown verbatim)
  { name: "deixis+label known: carpet one label phase 1 this room", input: "carpet one label phase 1 this room", expect: ok({ kind: "trace_at_cursor", tag: "CPT-1", known: true, label: "Phase 1" }) },
  { name: "deixis+label unknown: cpt one label East Mezzanine here", input: "cpt one label East Mezzanine here", expect: ok({ kind: "trace_at_cursor", tag: "CPT-1", known: true, label: "East Mezzanine" }) },
  { name: "deixis+label rider, tagless: label Alternate this one", input: "label Alternate this one", ctx: { hasActiveCondition: true }, expect: ok({ kind: "trace_at_cursor", label: "Alternate" }) },
  { name: "deixis full combo: carpet one waste seven label phase 1 right here", input: "carpet one waste seven label phase 1 right here", expect: ok({ kind: "trace_at_cursor", tag: "CPT-1", known: true, waste: 7, label: "Phase 1" }) },

  // 17. deixis rejects — never a guess
  { name: "bare deixis, no active condition: this room", input: "this room", expect: no("deixis_no_condition") },
  { name: "bare deixis, no active condition: here", input: "here", expect: no("deixis_no_condition") },
  { name: "tagless waste rider, no active condition: waste seven here", input: "waste seven here", expect: no("deixis_no_condition") },
  { name: "deixis on note rejects: note check this one", input: "note check this one", expect: no("deixis_target") },
  { name: "deixis on note rejects: note verify base here", input: "note verify base here", expect: no("deixis_target") },
  { name: "deixis on clear label rejects: clear label here", input: "clear label here", expect: no("deixis_target") },
  { name: "deixis on clear label rejects: clear label this room", input: "clear label this room", expect: no("deixis_target") },
  { name: "deixis with numberless tag rejects: carpet this room", input: "carpet this room", expect: no("unknown_tag") },
  { name: "deixis with prose head rejects: hello this room", input: "hello this room", expect: no("unrecognized") },
  { name: "deixis keeps the ambiguity bar: carpet one seven this room", input: "carpet one seven this room", expect: no("trailing_words") },
  { name: "deixis with numberless waste rejects: cpt one waste here", input: "cpt one waste here", expect: no("bad_number") },
  { name: "deixis with empty label rejects: label here", input: "label here", expect: no("unrecognized") },
];

for (const c of CASES)
  test(c.name, () =>
    assert.deepEqual(parseVoiceIntent(c.input, { ...CTX, ...c.ctx }), c.expect));

// 15. parseSpokenNumber direct table
const NUM_CASES: [string, number | null][] = [
  ["zero", 0],
  ["seven", 7],
  ["ten", 10],
  ["nineteen", 19],
  ["twenty", 20],
  ["twenty five", 25],
  ["twenty-five", 25],
  ["ninety nine", 99],
  ["hundred", 100],
  ["one hundred", 100],
  ["7", 7],
  ["7.5", 7.5],
  ["7,5", 7.5],
  ["seven point five", 7.5],
  ["one seven", null], // no digit-by-digit composition
  ["seven and a half", null],
  ["twenty ten", null], // tens+teen is not a number
  ["banana", null],
  ["", null],
];

for (const [input, expected] of NUM_CASES)
  test(`parseSpokenNumber(${JSON.stringify(input)}) = ${expected}`, () =>
    assert.equal(parseSpokenNumber(input), expected));
