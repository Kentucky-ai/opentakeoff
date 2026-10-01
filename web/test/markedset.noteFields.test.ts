// Marked Set burns {{qty}} notes (#474) exactly as the canvas shows them: the
// linked note prints the measured count, the unlinked one prints its field
// literally in the danger ink — for both the classic note and the annotation
// toolbar's styled callout. Same harness as markedset.annotations.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName } from 'pdf-lib';
import { inflateSync } from 'node:zlib';
import { buildMarkedSetPdf } from '../src/lib/markedset.js';

const hex = (s: string) => Buffer.from(s).toString('hex').toUpperCase();
// FIELD_WARN_INK #b03a26 as pdf-lib writes an rg operand
const WARN = `${176 / 255} ${58 / 255} ${38 / 255} rg`;

test('marked set: {{qty}} prints the linked count; an unlinked field prints literally in the warning ink', async () => {
  const source = await PDFDocument.create(); source.addPage([300, 200]);
  const sourceBytes = await source.save();
  const conditions = [{ id: 'em', finish_tag: 'EM-1', color: '#2563eb', multiplier: 1 }];
  const shapes = [1, 2].map((i) => ({ id: `s${i}`, sheet_id: 'sample.pdf', condition_id: 'em', measure_role: 'count', computed: { count: 1 }, verts_norm: [[0.1 * i, 0.3]] }));
  const style = { color: '#dc3d43' };
  const marks = [
    { id: 'linked', sheet_id: 'sample.pdf', type: 'text', at: [0.5, 0.2], text: 'x{{qty}} lights', condition_id: 'em' },
    { id: 'styled', sheet_id: 'sample.pdf', type: 'callout', target: [0.2, 0.5], at: [0.5, 0.5], text: 'need {{qty}}', condition_id: 'em', annotation_style: style },
    { id: 'loose', sheet_id: 'sample.pdf', type: 'text', at: [0.5, 0.8], text: 'x{{qty}} spare', condition_id: '' },
  ];
  const { bytes } = await buildMarkedSetPdf({ projectName: 'Field test', dark: false, sheets: [{ key: 'sample.pdf', file: 'sample.pdf', page: 1, label: 'A-101' }], shapes, markups: marks, conditions, company: null, clientInfo: null,
    loadPdfData: async () => sourceBytes, getPage: async () => ({ rotate: 0, getViewport: ({ scale }: { scale: number }) => ({ width: 300 * scale, height: 200 * scale, transform: [scale, 0, 0, -scale, 0, 200 * scale] }) }) });
  const out = await PDFDocument.load(bytes);
  const page: any = out.getPages()[out.getPageCount() - 1];
  let contents = '';
  for (const ref of page.node.Contents().asArray()) {
    const stream: any = out.context.lookup(ref), filter = stream.dict.lookup(PDFName.of('Filter'));
    contents += Buffer.from(String(filter) === '/FlateDecode' ? inflateSync(stream.contents) : stream.contents).toString('latin1');
  }
  assert.ok(contents.includes(hex('x2 EA lights')), 'the linked note prints the measured count');
  assert.ok(contents.includes(hex('need 2 EA')), 'the toolbar callout resolves too');
  assert.ok(contents.includes(hex('x{{qty}} spare')), 'the unlinked field prints literally, never blank or 0');
  assert.ok(!contents.includes(hex('x0 EA')));
  assert.ok(contents.includes(WARN), 'the unresolved note is drawn in the warning ink');
});
