import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LAYOUT, moveDock, normalizeLayout, readWorkspacePreferences } from '../src/lib/workspaceLayout.js';

test('a locked layout rejects a pending drag, unlocking allows a valid dock only', () => {
  assert.deepEqual(moveDock(DEFAULT_LAYOUT, 'tools', 'right'), DEFAULT_LAYOUT);
  const unlocked = { ...DEFAULT_LAYOUT, locked: false };
  assert.equal(moveDock(unlocked, 'tools', 'right').tools, 'right');
  assert.deepEqual(moveDock(unlocked, 'tools', 'offscreen'), unlocked);
  assert.deepEqual(moveDock(unlocked, 'unknown-panel', 'right'), unlocked);
  assert.equal(unlocked.tools, 'left');
});
test('corrupt, obsolete and out-of-bounds personal layouts recover to usable defaults', () => {
  for (const raw of ['oops', 'null', '{}', '{"version":2,"enabled":true}']) {
    const result = readWorkspacePreferences(raw);
    assert.equal(result.enabled, false);
    assert.deepEqual(result.layout, DEFAULT_LAYOUT);
  }
  assert.deepEqual(normalizeLayout({ tools: 'floating', workWidth: Infinity, sheetWidth: -500, locked: 'false', injected: 9 }), { ...DEFAULT_LAYOUT, sheetWidth: 220 });
});
test('layout round-trip retains named arrangements without importing project fields', () => {
  const value = { version: 1, enabled: true, layout: { ...DEFAULT_LAYOUT, work: 'left', workWidth: 440, shapes: ['private'] }, saved: [{ name: 'My desk', layout: { ...DEFAULT_LAYOUT, tools: 'right' } }], project: 'private' };
  const pref = readWorkspacePreferences(JSON.stringify(value));
  assert.equal(pref.layout.work, 'left');
  assert.equal(pref.layout.workWidth, 440);
  assert.equal(pref.saved[0].layout.tools, 'right');
  assert.equal('shapes' in pref.layout, false);
  assert.equal('project' in pref, false);
  assert.deepEqual(readWorkspacePreferences(JSON.stringify(pref)), pref);
});
test('saved arrangement names and count are bounded and malformed entries ignored', () => {
  const pref = readWorkspacePreferences(JSON.stringify({ version: 1, saved: [null, {}, { name: ' ' }, ...Array.from({ length: 20 }, () => ({ name: 'x'.repeat(80), layout: {} }))] }));
  assert.equal(pref.saved.length, 8);
  assert.equal(pref.saved[0].name.length, 40);
});
