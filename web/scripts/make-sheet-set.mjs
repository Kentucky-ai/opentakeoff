// Generated plan sets for the Sheets tree's browser checks and session
// measurement: each page carries a title block with a SHEET NUMBER label over
// its number, plus filler text. Nothing here is committed output.
// Run from web/: node scripts/make-sheet-set.mjs <outDir> [--files 6] [--pages 5]
//   [--filler 2000] [--dense-every 0] [--dense 20000] [--rev 0] [--scans 0] [--prefix set]
// --rev N changes every number's suffix (a revision of the same files);
// --scans N makes the last N pages of each file image-only (no text layer).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const args = process.argv.slice(2);
const out = args[0];
if (!out) { console.error('usage: make-sheet-set.mjs <outDir> [options]'); process.exit(2); }
const opt = (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 ? (isNaN(+args[i + 1]) ? args[i + 1] : +args[i + 1]) : d; };
const FILES = opt('files', 6), PAGES = opt('pages', 5), FILLER = opt('filler', 2000);
const DENSE_EVERY = opt('dense-every', 0), DENSE = opt('dense', 20000), REV = opt('rev', 0), SCANS = opt('scans', 0), PREFIX = opt('prefix', 'set');
const LETTERS = 'ACEMPSGLIKTUVW';
/** the number printed on file f, page p (also what the reader should return) */
export const sheetNumber = (f, p, rev = REV) => `${LETTERS[f % LETTERS.length]}${f >= LETTERS.length ? Math.floor(f / LETTERS.length) : ''}-${100 + p}${rev ? String.fromCharCode(64 + rev) : ''}`;
const WORDS = ['WALL', 'TYP', 'NOTE', 'EQ', 'CLR', 'DOOR', 'SIM', 'GYP', 'CONC', 'U.N.O.'];
// the scanned look: a public fixture's image-only page
const scanSrc = SCANS ? await PDFDocument.load(readFileSync(new URL('../../mcp/test/fixtures/scanned-plan.pdf', import.meta.url))) : null;

mkdirSync(out, { recursive: true });
const manifest = [];
for (let f = 0; f < FILES; f++) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 1; p <= PAGES; p++) {
    if (scanSrc && p > PAGES - SCANS) { const [pg] = await doc.copyPages(scanSrc, [0]); doc.addPage(pg); manifest.push({ file: `${PREFIX}-${f + 1}.pdf`, page: p, number: null }); continue; }
    const pg = doc.addPage([2592, 1728]); // 36 × 24 in
    let seed = f * 9973 + p * 31 + 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const n = DENSE_EVERY && p % DENSE_EVERY === 1 ? DENSE : FILLER;
    for (let i = 0; i < n; i++) pg.drawText(WORDS[i % WORDS.length], { x: 40 + rnd() * 2100, y: 200 + rnd() * 1450, size: 7, font });
    pg.drawText('SHEET NUMBER', { x: 2400, y: 110, size: 6, font });
    pg.drawText(sheetNumber(f, p), { x: 2400, y: 80, size: 20, font });
    manifest.push({ file: `${PREFIX}-${f + 1}.pdf`, page: p, number: sheetNumber(f, p) });
  }
  writeFileSync(join(out, `${PREFIX}-${f + 1}.pdf`), await doc.save());
}
writeFileSync(join(out, 'expected.json'), JSON.stringify(manifest, null, 1));
console.log(`${FILES} files × ${PAGES} pages → ${out}`);
