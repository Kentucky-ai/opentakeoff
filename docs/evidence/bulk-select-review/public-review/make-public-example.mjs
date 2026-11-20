// Build the public review fixture without adding another source PDF to the repo.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildProjectArchive, parseProjectArchive } from '../../../../web/src/lib/projectArchive.js';
const here=path.dirname(fileURLToPath(import.meta.url));
const [landscapePdf,output]=process.argv.slice(2);
if(!landscapePdf||!output)throw new Error('Usage: node make-public-example.mjs path/to/Illini-Union-Public-Sheets-133-135-136.pdf output.otk');
const takeoff=JSON.parse(await fs.readFile(path.join(here,'public-sample.takeoff.json'),'utf8'));
const manifest=JSON.parse(await fs.readFile(path.join(here,'source-manifest.json'),'utf8'));
const pdfs=new Map();
for(const [i,source] of manifest.sources.entries()){
 const sourcePath=i===0?path.resolve(here,'../../../../demo/public-sheets',source.file):landscapePdf;
 const bytes=new Uint8Array(await fs.readFile(sourcePath));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),source.sha256,`Source hash: ${source.file}`);
 pdfs.set(source.file,bytes);
}
const bytes=await buildProjectArchive({takeoff,sheets:manifest.sources.map(s=>({name:s.file})),loadPdfData:async name=>pdfs.get(name),projectName:takeoff.project_name});
const parsed=await parseProjectArchive(bytes);
assert.deepEqual(parsed.takeoff,takeoff);
assert.equal(parsed.pdfs.length,2);
await fs.writeFile(output,bytes);
console.log('Created public review archive: 89 records, 86 pending and three explicitly synthetic review-state seeds.');
