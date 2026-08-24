// Condition plays: shape round-trip, id hygiene, name-replace semantics.
import { test } from "node:test";
import assert from "node:assert/strict";
import { playFromCondition, conditionFromPlay, upsertPlay } from "../src/lib/plays.js";

const mint = (p: string) => { let n = 0; return () => `${p}-${++n}`; };

test("playFromCondition keeps recipe fields, drops ids/geometry", () => {
  const play: any = playFromCondition("LVT std", {
    id: "cnd-real", finish_tag: "LVT-1", color: "#123456", hatch: "plank",
    waste_pct: 8, multiplier: 4, shapes_do_not_exist_here: true,
    materials: [{ id: "m-real", name: "Adhesive", per: 200, basis: "area", unit: "gal", note: "PSA" }, { name: "" }],
  }, mint("play"));
  assert.equal(play.name, "LVT std");
  assert.equal(play.waste_pct, 8);
  assert.equal((play as any).multiplier, undefined);   // project-specific — never saved
  assert.equal((play as any).id, "play-1");
  assert.equal(play.materials.length, 1);
  assert.equal((play.materials[0] as any).id, undefined);
});

test("conditionFromPlay mints fresh ids and defaults", () => {
  const play = { id: "p1", name: "CT", finish_tag: "CT-1", color: "#111", hatch: "grid",
    waste_pct: 10, materials: [{ name: "Thinset", per: 50, basis: "area", unit: "bag" }] };
  const c: any = conditionFromPlay(play as any, "CT-9", mint("cnd"), mint("mat"));
  assert.equal(c.id, "cnd-1");
  assert.equal(c.finish_tag, "CT-9");
  assert.equal(c.multiplier, 1);
  assert.equal(c.waste_pct, 10);
  assert.equal(c.materials[0].id, "mat-1");
  assert.equal(c.materials[0].name, "Thinset");
});

test("upsertPlay replaces by name", () => {
  const a = { id: "1", name: "X", color: "#1" };
  const b = { id: "2", name: "X", color: "#2" };
  const out = upsertPlay([a, { id: "3", name: "Y" }] as any, b as any);
  assert.equal(out.length, 2);
  assert.equal((out.find((p) => p.name === "X") as any).color, "#2");
});

test("playFromCondition preserves preset_id through MAT_KEEP", () => {
  const play: any = playFromCondition("Adhesive std", {
    id: "cnd-1", finish_tag: "ADH-1", color: "#123456", hatch: "solid",
    materials: [{
      id: "m-1", name: "Adhesive", per: 150, basis: "area", unit: "gal",
      note: "1/16″×1/16″×1/16″ sq", preset_id: "adhesive_1_16_sq",
      kind: "adhesive",
    }],
  }, mint("play"));
  assert.equal(play.materials.length, 1);
  assert.equal(play.materials[0].preset_id, "adhesive_1_16_sq");
  assert.equal(play.materials[0].kind, "adhesive");
});

test("conditionFromPlay round-trips preset_id", () => {
  const play = {
    id: "p1", name: "Adh", finish_tag: "ADH-1", color: "#111", hatch: "solid",
    materials: [{
      name: "Adhesive", per: 150, basis: "area", unit: "gal",
      preset_id: "adhesive_1_16_sq", kind: "adhesive",
    }],
  };
  const c: any = conditionFromPlay(play as any, "ADH-2", mint("cnd"), mint("mat"));
  assert.equal(c.materials[0].preset_id, "adhesive_1_16_sq");
  assert.equal(c.materials[0].kind, "adhesive");
});
