// #483 PR A: every marquee twin's live read against the change the fixtures
// module says the current slice (CURRENT_SLICE) makes. For a twin
// with an expectedChanges entry, the live readScheduleSpans read is the
// complete expected read at CURRENT_SLICE; for every other twin it is its
// golden. Each change is then checked by kind through readScheduleDebug: a
// re-key names the key pass 1 read, an unglue names the row its tokens left,
// a dropped group label is gone, an added row was keyed by a new rule. The
// comparison is made after a JSON round-trip, and again on the live objects
// for every optional field — a round-trip hides a field present as undefined.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readScheduleSpans, readScheduleDebug, type ScheduleRead } from "../src/lib/scheduleRead.ts";
import type { ScheduleRow } from "../src/lib/scheduleRows.ts";
import {
  CURRENT_SLICE, TWINS, GOLDEN_DIR_URL, expectedChanges, expectedReadAt, goldenFile, hasMarquee, roundTrip, type ExpectedRead,
} from "./fixtures/reader483Fixtures.ts";

const dir = fileURLToPath(GOLDEN_DIR_URL);
const golden = (file: string): any => JSON.parse(readFileSync(dir + file, "utf8"));
const has = (o: object, f: string) => Object.prototype.hasOwnProperty.call(o, f);
const ROW_OPTIONAL = ["key_rule", "unticked_reason", "not_used_text"];
const READ_OPTIONAL = ["skipped", "refused", "title"];

/** the expected read at the current slice: the entry's, else the golden */
function wantOf(name: string): ExpectedRead {
  const e = expectedChanges[name];
  return (e && expectedReadAt(e, CURRENT_SLICE)) ?? golden(goldenFile(name)).marquee.readScheduleSpans;
}

/** every optional field is on the live object exactly when the expected read has it, never as undefined */
function assertLiveFields(live: ScheduleRead, want: ExpectedRead, where: string) {
  for (const f of READ_OPTIONAL) {
    assert.equal(has(live, f), has(want, f), `${where}: read ${f} present iff expected`);
    if (has(live, f)) assert.notEqual((live as Record<string, unknown>)[f], undefined, `${where}: read ${f} is not undefined`);
  }
  live.rows.forEach((r: ScheduleRow, k) => {
    const w = want.rows[k] as Record<string, unknown>;
    for (const f of ROW_OPTIONAL) {
      assert.equal(has(r, f), has(w, f), `${where}: ${r.finish_tag}#${k} ${f} present iff expected`);
      if (has(r, f)) assert.notEqual((r as Record<string, unknown>)[f], undefined, `${where}: ${r.finish_tag}#${k} ${f} is not undefined`);
    }
    for (const f of Object.keys(r)) assert.ok(!f.startsWith("_"), `${where}: ${r.finish_tag} carries no internal ${f}`);
  });
}

test("slice gate: the fixtures module is at slice 3 or later", () => {
  assert.ok(CURRENT_SLICE >= 3);
});

for (const t of TWINS.filter(hasMarquee)) {
  const e = expectedChanges[t.name];
  test(`marquee twin ${t.name}: the live read is ${e && expectedReadAt(e, CURRENT_SLICE) ? `its slice-${CURRENT_SLICE} expectation` : "its golden"}; every change at or below slice ${CURRENT_SLICE} is visible in the debug trace`, () => {
    const want = wantOf(t.name);
    const live = readScheduleSpans(t.spans);
    assert.deepStrictEqual(roundTrip(live), roundTrip(want), `${t.name}: readScheduleSpans`);
    assertLiveFields(live, want, t.name);
    const dbg = readScheduleDebug(t.spans);
    assert.deepStrictEqual(dbg.read, live, `${t.name}: readScheduleDebug's read is readScheduleSpans's`);
    if (!e) return;
    // count and key order (the entry restates them per slice)
    assert.equal(live.rows.length, e.counts[CURRENT_SLICE], `${t.name}: count at slice ${CURRENT_SLICE}`);
    assert.deepEqual(live.rows.map((r) => r.finish_tag), e.keys[CURRENT_SLICE], `${t.name}: keys at slice ${CURRENT_SLICE}`);
    // rows no change names read as their golden rows
    const named = new Set(e.changes.filter((c) => c.slice <= CURRENT_SLICE).flatMap((c) => c.rows ?? []));
    const g = golden(goldenFile(t.name)).marquee.readScheduleSpans as ScheduleRead;
    for (const r of live.rows) {
      if (named.has(r.finish_tag)) continue;
      const before = g.rows.find((x) => x.finish_tag === r.finish_tag);
      assert.ok(before, `${t.name}: ${r.finish_tag} not named in a change is in the golden`);
      assert.deepStrictEqual(roundTrip(r), roundTrip(before), `${t.name}: ${r.finish_tag} not named in a change reads as its golden`);
    }
    const byKey = (k: string) => dbg.rows.filter((r) => r.key === k);
    const unglued = dbg.rows.flatMap((r) => (r._ungluedFrom ?? []).map((u) => ({ ...u, to: r.key })));
    for (const c of e.changes.filter((x) => x.slice <= CURRENT_SLICE)) {
      const where = `${t.name}: slice-${c.slice} ${c.kind}`;
      switch (c.kind) {
        case "re-key":
          for (const k of c.rows!) {
            const r = byKey(k).find((x) => x._pass1Key === c.fields!.from);
            assert.ok(r && r._pass1 && !r._newRule, `${where}: ${k} is a pass-1 row re-keyed from ${String(c.fields!.from)}`);
            assert.ok(!r.keyRule, `${where}: a re-keyed pass-1 row has no keyRule`);
            for (const tok of c.tokens ?? []) assert.ok(Object.values(r.cells).some((cell) => cell.text.includes(tok)), `${where}: ${k}'s cells keep ${tok}`);
          }
          break;
        case "unglue":
          for (const src of c.rows!) {
            for (const tok of c.tokens!) assert.ok(unglued.some((u) => u.from === src && u.text === tok), `${where}: "${tok}" left ${src} (${JSON.stringify(unglued)})`);
            for (const r of byKey(src).filter((x) => x._pass1)) {
              for (const tok of c.tokens!) assert.ok(!Object.values(r.cells).some((cell) => cell.text.includes(tok)), `${where}: ${src} no longer holds "${tok}"`);
            }
          }
          break;
        case "group-drop":
          for (const k of c.rows!) {
            assert.equal(byKey(k).length, 0, `${where}: ${k} is dropped`);
            assert.ok(unglued.some((u) => u.from === k), `${where}: ${k} was emptied by unglue`);
          }
          break;
        case "added-row":
          for (const k of c.rows!) {
            const r = byKey(k).find((x) => x._newRule);
            assert.ok(r && !r._pass1 && r.keyRule === "extended", `${where}: ${k} is a new-rule row`);
            assert.ok(dbg.diag.some((d) => d.kind === "new" && d.y === r._y), `${where}: ${k} has a diag entry`);
          }
          break;
        case "skipped":
          assert.deepEqual("skipped" in live ? live.skipped : undefined, c.fields!.skipped, where);
          for (const w of c.fields!.skipped as string[]) assert.ok(dbg.consumed.some((x) => x.reason === "skipped" && x.text.split(/\s+/)[0].replace(/[^A-Z]/g, "") === w), `${where}: ${w} consumed as skipped`);
          break;
        case "refusal-flip": {
          const side = (r: ScheduleRead) => ("refused" in r ? r.refused : "rows");
          assert.equal(side(live), c.fields!.to, where);
          break;
        }
        default:
          // unticked / category / description-prefix / section-restore: the
          // fields sit on the named rows of the full expected read compared above
          for (const k of c.rows ?? []) {
            const r = live.rows.find((x) => x.finish_tag === k);
            assert.ok(r, `${where}: ${k}`);
            for (const [f, v] of Object.entries(c.fields ?? {})) assert.deepEqual((r as Record<string, unknown>)[f], v, `${where}: ${k}.${f}`);
          }
      }
    }
  });
}

test("readScheduleDebug: pass-1 rows carry _pass1 and their y; nothing internal reaches readScheduleSpans", () => {
  for (const t of TWINS.filter(hasMarquee)) {
    const dbg = readScheduleDebug(t.spans);
    for (const r of dbg.rows) {
      assert.equal(typeof r._y, "number", `${t.name}: ${r.key}._y`);
      assert.equal(r._pass1, !r._newRule, `${t.name}: ${r.key} is a pass-1 row or a new-rule row`);
    }
  }
});
