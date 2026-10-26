import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markupTier, paintOrderedMarkups, markupsForSheet } from '../src/lib/markupPaint.ts';

test('the three draw tiers are image behind highlight behind everything else', () => {
  assert.equal(markupTier({ type: 'image' }), 0);
  assert.equal(markupTier({ type: 'highlight' }), 1);
  assert.equal(markupTier({ type: 'cloud' }), 2);
  assert.equal(markupTier({}), 2); // an unknown type still paints on top, never behind
});

test('paint order ranks tiers and keeps same-tier order, without mutating the input', () => {
  const list = [{ id: 'c1', type: 'cloud' }, { id: 'h1', type: 'highlight' }, { id: 'i1', type: 'image' }, { id: 'c2', type: 'text' }];
  const ordered = paintOrderedMarkups(list);
  assert.deepEqual(ordered.map((m) => m.id), ['i1', 'h1', 'c1', 'c2']);
  assert.deepEqual(list.map((m) => m.id), ['c1', 'h1', 'i1', 'c2']);
});

test('the mirror is scoped to its sheet, drops reference-only pins, and is paint-ordered', () => {
  const markups = [
    { id: 'a', type: 'cloud', sheet_id: 'A101#1' },
    { id: 'b', type: 'image', sheet_id: 'A101#1' },
    { id: 'c', type: 'cloud', sheet_id: 'A102#1' },                    // other sheet
    { id: 'd', type: 'cloud', sheet_id: 'A101#1', reference_only: true }, // pin, not ink
  ];
  assert.deepEqual(markupsForSheet(markups, 'A101#1').map((m) => m.id), ['b', 'a']);
});

test('a missing refKey mirrors nothing instead of every markup', () => {
  const markups = [{ id: 'a', type: 'cloud', sheet_id: 'A101#1' }];
  assert.deepEqual(markupsForSheet(markups, null), []);
  assert.deepEqual(markupsForSheet(markups, ''), []);
  assert.deepEqual(markupsForSheet([], 'A101#1'), []);
});
