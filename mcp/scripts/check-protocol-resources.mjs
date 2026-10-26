// Generate the self-contained protocol resource registry. Keep this allowlist
// explicit: the published MCP bundle must never discover files at runtime.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROTOCOL_SOURCES = Object.freeze([
  'protocol/legacy/takeoff-canvas.v1.schema.json',
  'protocol/v1/calibration.schema.json',
  'protocol/v1/common.schema.json',
  'protocol/v1/condition.schema.json',
  'protocol/v1/document-fields.schema.json',
  'protocol/v1/evidence.schema.json',
  'protocol/v1/measurement.schema.json',
  'protocol/v1/provenance.schema.json',
  'protocol/v1/review.schema.json',
  'protocol/v1/stitch.schema.json',
  'protocol/v1/takeoff-document.schema.json',
]);

const PROTOCOL_BASE = 'https://opentakeoff.kentucky-ai.com/protocol/';
const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const normalizeJson = (text) => `${JSON.stringify(JSON.parse(text), null, 2)}\n`;
const digest = (text) => createHash('sha256').update(text).digest('hex');
const schemaUri = (source) => `takeoff://protocol/${source.replace(/^protocol\//, '')}`;

function expectedFiles(root) {
  const actual = PROTOCOL_SOURCES.map((source) => resolve(root, source));
  if (new Set(PROTOCOL_SOURCES).size !== PROTOCOL_SOURCES.length) throw new Error('Protocol resource allowlist contains duplicates.');
  const discovered = [
    ...readdirSync(resolve(root, 'protocol/legacy')).filter((file) => file.endsWith('.schema.json')).map((file) => `protocol/legacy/${file}`),
    ...readdirSync(resolve(root, 'protocol/v1')).filter((file) => file.endsWith('.schema.json')).map((file) => `protocol/v1/${file}`),
  ].sort();
  const listed = [...PROTOCOL_SOURCES].sort();
  if (JSON.stringify(discovered) !== JSON.stringify(listed)) throw new Error(`Protocol schema files and explicit allowlist differ. Listed: ${listed.join(', ')}; found: ${discovered.join(', ')}.`);
  for (const source of PROTOCOL_SOURCES) {
    try { readFileSync(resolve(root, source)); } catch { throw new Error(`Protocol schema is missing: ${source}`); }
  }
  return actual;
}

function resolvePointer(document, fragment, source) {
  if (!fragment) return;
  let decodedFragment;
  try { decodedFragment = decodeURIComponent(fragment); } catch { throw new Error(`${source}: invalid URI encoding in $ref fragment #${fragment}`); }
  if (!decodedFragment.startsWith('/')) throw new Error(`${source}: unsupported non-pointer $ref fragment #${fragment}`);
  let current = document;
  for (const raw of decodedFragment.slice(1).split('/')) {
    if (/~(?![01])/.test(raw)) throw new Error(`${source}: invalid JSON pointer escape in #${fragment}`);
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, key)) throw new Error(`${source}: $ref fragment #${fragment} does not exist`);
    current = current[key];
  }
}

function referencedUris(schema, id, knownSchemas, source) {
  const refs = [];
  const walk = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const unsupported of ['$anchor', '$dynamicAnchor', '$dynamicRef']) {
      if (Object.prototype.hasOwnProperty.call(value, unsupported)) throw new Error(`${source}: unsupported ${unsupported}; bounded offline closure only resolves ordinary $ref pointers.`);
    }
    if (typeof value.$ref === 'string') {
      let target;
      try { target = new URL(value.$ref, id).href; } catch { throw new Error(`${source}: invalid $ref ${value.$ref}`); }
      const [documentUri, fragment = ''] = target.split('#', 2);
      const targetSchema = documentUri ? knownSchemas.get(documentUri) : schema;
      if (documentUri && !targetSchema) throw new Error(`${source}: unknown schema $ref ${value.$ref} (resolved ${documentUri})`);
      resolvePointer(targetSchema, fragment, source);
      refs.push(target);
    }
    for (const child of Object.values(value)) walk(child);
  };
  walk(schema);
  return refs;
}

export function protocolBundle(root = defaultRoot) {
  expectedFiles(root);
  const entries = PROTOCOL_SOURCES.map((source) => {
    const text = normalizeJson(readFileSync(resolve(root, source), 'utf8'));
    const schema = JSON.parse(text);
    if (typeof schema.$id !== 'string' || !schema.$id.startsWith(PROTOCOL_BASE)) throw new Error(`${source}: schema must keep its canonical $id under ${PROTOCOL_BASE}`);
    return { source, uri: schemaUri(source), id: schema.$id, title: schema.title ?? source, sha256: digest(text), text, schema };
  });
  const ids = new Set(entries.map((entry) => entry.id));
  if (ids.size !== entries.length) throw new Error('Protocol schemas must have unique $id values.');
  const schemasById = new Map(entries.map((entry) => [entry.id, entry.schema]));
  for (const entry of entries) {
    referencedUris(entry.schema, entry.id, schemasById, entry.source);
    const nestedIds = [];
    const findIds = (value, root = false) => {
      if (!value || typeof value !== 'object') return;
      if (!root && Object.prototype.hasOwnProperty.call(value, '$id')) nestedIds.push(value.$id);
      for (const child of Object.values(value)) findIds(child);
    };
    findIds(entry.schema, true);
    if (nestedIds.length) throw new Error(`${entry.source}: nested $id values are outside this bounded registry.`);
  }
  const measurement = entries.find((entry) => entry.source === 'protocol/v1/measurement.schema.json').schema;
  const roles = measurement.properties?.measure_role?.enum;
  if (!Array.isArray(roles) || roles.some((role) => typeof role !== 'string')) throw new Error('measurement.schema.json must define measure_role enum roles.');
  const draft = entries.find((entry) => entry.source === 'protocol/v1/takeoff-document.schema.json').schema.properties?.schema?.const;
  const canvas = entries.find((entry) => entry.source === 'protocol/legacy/takeoff-canvas.v1.schema.json').schema.properties?.schema?.const;
  if (typeof draft !== 'string' || typeof canvas !== 'string') throw new Error('Protocol document schemas must define their schema const identifiers.');

  const index = {
    protocol: entries.find((entry) => entry.id.endsWith('/v1/takeoff-document.schema.json')).title,
    legacy: entries.find((entry) => entry.id.endsWith('/legacy/takeoff-canvas.v1.schema.json')).title,
    scope: 'Machine-readable discovery and contract resources; writers and runtime validation are unchanged.',
    coordinate_contract: 'Tool coordinates are full-sheet image pixels at render scale 2.0, top-left origin, y-down; persisted verts_norm are normalized to the sheet/composite frame.',
    roles,
    identifiers: { draft, canvas },
    calibration: 'Calibration is feet per logical image pixel; metric display does not rewrite stored geometry.',
    records: 'Evidence/provenance and review fields are records and claims, not authentication. Unknown extension fields remain opaque.',
    limits: [
      'Schemas do not prove polygon topology, geometry accuracy, quantity recomputation, source/PDF availability, complete history, active reference integrity, MCP transport preservation, or approval authenticity.',
      'Secondary families such as markups, RFIs, rules, and layout/workspace data are not fully semantically validated.',
      'MCP exportPayload() is a projection: it omits rules and browser stitches, strips RFI tombstones, and does not represent the complete browser workspace/project document.',
      'The $id URLs are stable identifiers for offline resolution, not a promise that the files are deployed at those URLs.',
      'Both the draft TakeoffDocument v1 and existing canvas identifier are described; neither writer is changed by this increment.',
      'MCP cannot create human approval; schema-valid records do not authenticate their author or grant review authority.',
    ],
    wiki: 'takeoff://wiki/protocol',
    resources: entries.map(({ uri, id, title, source, sha256 }) => ({ uri, id, title, source, sha256 })),
  };
  return { index, entries };
}

export function renderProtocol(root = defaultRoot) {
  const { index, entries } = protocolBundle(root);
  const generated = entries.map(({ uri, id, title, source, sha256, text }) => ({ uri, id, title, source, sha256, schema_json: text }));
  return '// Generated by scripts/check-protocol-resources.mjs. Do not edit.\n'
    + '// The runtime serves these embedded values; it never reads protocol/ paths.\n'
    + `export const PROTOCOL_INDEX = ${JSON.stringify(index, null, 2)} as const;\n`
    + `export const PROTOCOL_INDEX_JSON = ${JSON.stringify(`${JSON.stringify(index, null, 2)}\n`)};\n`
    + `export const PROTOCOL_SCHEMAS = ${JSON.stringify(generated, null, 2)} as const;\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = resolve(defaultRoot, 'mcp/src/protocol.generated.ts');
  const generated = renderProtocol();
  let old = '';
  try { old = readFileSync(target, 'utf8').replace(/\r\n/g, '\n'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (old !== generated) {
    if (process.argv.includes('--write')) writeFileSync(target, generated);
    else { console.error(`${relative(defaultRoot, target)} is stale — run npm run check:protocol-resources -- --write`); process.exitCode = 1; }
  }
  const bundle = protocolBundle();
  console.log(`Protocol resources: ${bundle.entries.length} schemas; canonical ids, digests, and offline $ref closure checked.`);
}
