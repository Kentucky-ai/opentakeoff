// Reproduce the saved-record comparison and prepare the bundled real-plan UI fixture.
// Run from any directory: node scripts/count-marker-review.mjs [--build-sample <directory>]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildProjectArchive, parseProjectArchive } from '../web/src/lib/projectArchive.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demo = path.join(root, 'demo/count-marker-review');
const evidence = path.join(root, 'docs/evidence/count-marker-locator');
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const base = await readJson(path.join(demo, 'Landscape-Review-Demo.takeoff.json'));
const fixture = await readJson(path.join(demo, 'Landscape-Review-Demo.fixture.json'));
const pdf = await fs.readFile(path.join(demo, fixture.pdf));
assert.equal(createHash('sha256').update(pdf).digest('hex'), fixture.sha256);
assert.deepEqual((await parseProjectArchive(new Uint8Array(await fs.readFile(path.join(demo, 'Landscape-Review-Demo.otk'))))).takeoff, base);
const byId = items => [...items].sort((a, b) => a.id.localeCompare(b.id));
const conditionsWithoutEditTime = items => byId(items).map(({ updated_at, ...condition }) => condition);
const quantity = (payload, id) => payload.shapes.filter(s => s.condition_id === id).reduce((sum, s) => sum + (s.computed?.count ?? 0), 0);
assert.equal(base.shapes.length, 18);
assert(base.shapes.every(s => s.origin.reviewed === false));
const comparisons = [];
for (const build of ['hosted', 'local']) {
  const saved = await readJson(path.join(evidence, `${build}-browser-export.json`));
  assert.deepEqual(byId(saved.shapes), byId(base.shapes), `${build}: every measurement field must remain unchanged`);
  assert.deepEqual(saved.sheets, base.sheets, `${build}: scale and source sheets must remain unchanged`);
  assert.deepEqual(conditionsWithoutEditTime(saved.conditions), conditionsWithoutEditTime(base.conditions));
  const changedTimestamps = saved.conditions.filter(c => c.updated_at !== base.conditions.find(b => b.id === c.id).updated_at).map(c => c.finish_tag);
  assert.deepEqual(changedTimestamps, build === 'local' ? ['TA'] : []);
  const quantities = Object.fromEntries(base.conditions.map(c => [c.finish_tag, quantity(saved, c.id)]));
  assert.deepEqual(quantities, { TA: 6, TB: 2, sa: 10 });
  comparisons.push({ build, measurements: saved.shapes.length, unchanged_measurements: saved.shapes.length, quantities_ea: quantities, pending: saved.shapes.filter(s => s.origin.reviewed === false).length, changed_condition_timestamps: changedTimestamps });
}
const sample = await readJson(path.join(demo, 'Bundled-Sample-Marker-QA.takeoff.json'));
assert.equal(sample.shapes.length, 3);
assert(sample.shapes.every(s => s.origin.reviewed === false));
if (process.argv[2] === '--build-sample') {
  assert(process.argv[3], 'Supply an output directory');
  const output = path.resolve(process.argv[3]);
  await fs.mkdir(output, { recursive: true });
  const samplePdf = new Uint8Array(await fs.readFile(path.join(root, 'demo/sample-finish-plan.pdf')));
  const bytes = await buildProjectArchive({ takeoff: sample, sheets: [{ name: 'sample-finish-plan.pdf' }], loadPdfData: async () => samplePdf, projectName: sample.project_name });
  assert.deepEqual((await parseProjectArchive(bytes)).takeoff, sample);
  await fs.writeFile(path.join(output, 'Bundled-Sample-Marker-QA.otk'), bytes);
}
console.log(JSON.stringify({ result: 'pass', archive_round_trip: 'exact', comparisons, bundled_sample_fixture: '3 CG callout anchors; limited UI QA, not a complete takeoff' }, null, 2));
