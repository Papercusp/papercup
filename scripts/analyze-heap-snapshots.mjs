#!/usr/bin/env node
// Summarize top retainer classes from V8 .heapsnapshot files captured by the
// event-loop-lag monitor's heap-snapshot-on-high-RSS feature
// (~/.papercusp/heap-snapshots/heap-*.heapsnapshot).
//
// Companion to analyze-loop-profiles.mjs — use both together: the CPU profile
// says "what code is on the loop", the heap snapshot says "what objects are
// leaking". Load the .heapsnapshot file in Chrome DevTools Memory tab for
// the full retainer tree; this script gives you the quick class-level summary.
//
// Usage:
//   node scripts/analyze-heap-snapshots.mjs [dir] [--top N] [--json]
//
// Defaults:
//   dir      ~/.papercusp/heap-snapshots
//   --top    30     how many top retainer classes to print
//   --json   emit machine-readable JSON instead of the table
//
// Output columns (human-readable table):
//   size(MB)  — total self_size of all instances of that class
//   %         — fraction of the total tracked heap in this snapshot set
//   count     — number of node instances of that class
//   class     — the V8 class/constructor name (from the snapshot string table)
//
// V8 heap snapshot format (JSON):
//   snapshot.meta.node_fields  — ordered field names per node entry
//   snapshot.meta.node_types   — node_types[0] is the array of type name strings
//   snapshot.node_count        — number of nodes
//   nodes[]                    — flat array: node_count × node_fields.length
//   strings[]                  — string table indexed by the 'name' field value

import { readdirSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { parser } from 'stream-json';

const classLabel = (type, raw) => !type.includes('string') && typeof raw === 'string' && raw.length <= 80 &&
  (/^[A-Za-z_$][A-Za-z0-9_.$]*$/.test(raw) || /^\(object (?:elements|properties)\)$/.test(raw))
  ? raw : '(' + type + ')';

/** A complete node census, not a dominator graph or exclusive retained bytes.
 * Snapshot string names contain actual payloads. Only fixed V8 types and
 * constructor-shaped labels are eligible for this persisted aggregate.
 */
export function summarizeHeapSnapshot(snap, { top = 30 } = {}) {
  if (!Number.isInteger(top) || top < 1 || top > 100) throw new TypeError('Invalid heap census top limit');
  const meta = snap?.snapshot?.meta;
  const fields = meta?.node_fields, types = meta?.node_types?.[0];
  const count = snap?.snapshot?.node_count;
  if (!Array.isArray(fields) || !Array.isArray(types) || !types.every(type => typeof type === 'string') ||
      !Number.isSafeInteger(count) || count < 0 || !Array.isArray(snap.nodes) || !Array.isArray(snap.strings))
    throw new TypeError('Invalid heap snapshot node metadata');
  const ti = fields.indexOf('type'), ni = fields.indexOf('name'), si = fields.indexOf('self_size');
  if (!fields.length || ti < 0 || ni < 0 || si < 0 || snap.nodes.length !== count * fields.length)
    throw new TypeError('Incomplete heap snapshot nodes');
  const byType = new Map(), byClass = new Map();
  let totalSelfSizeBytes = 0;
  for (let index = 0; index < count; index++) {
    const base = index * fields.length;
    const typeId = snap.nodes[base + ti], nameId = snap.nodes[base + ni], bytes = snap.nodes[base + si];
    if (!Number.isSafeInteger(typeId) || typeId < 0 || typeId >= types.length ||
        !Number.isSafeInteger(nameId) || nameId < 0 || nameId >= snap.strings.length ||
        !Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError('Invalid heap snapshot node values');
    const type = types[typeId];
    const raw = snap.strings[nameId];
    // Never inspect STRING-family names as labels: they are the string content.
    // Native/code names can contain filesystem paths or source text too.
    const label = classLabel(type, raw);
    const key = type + '\0' + label;
    const add = (map, key, initial) => {
      const row = map.get(key) ?? { ...initial, count: 0, selfSizeBytes: 0 };
      row.count++; row.selfSizeBytes += bytes; map.set(key, row);
    };
    add(byType, type, { type }); add(byClass, key, { type, class: label });
    totalSelfSizeBytes += bytes;
  }
  return { nodeCount: count, totalSelfSizeBytes,
    types: [...byType.values()].sort((a, b) => b.selfSizeBytes - a.selfSizeBytes),
    topClasses: [...byClass.values()].sort((a, b) => b.selfSizeBytes - a.selfSizeBytes).slice(0, top),
    definition: 'V8 snapshot node self_size, after snapshot GC; not retained/exclusive bytes or total native memory.' };
}

/** Stream even multi-GB snapshots. Never pack a payload string or node array.
 * @param {import('node:stream').Readable} input
 * @param {{ top?: number }} [options]
 */
export async function summarizeHeapSnapshotStream(input, { top = 30 } = {}) {
  if (!Number.isInteger(top) || top < 1 || top > 100) throw new TypeError('Invalid heap census top limit');
  const hash = createHash('sha256'); let bytes = 0;
  input.on('data', chunk => { hash.update(chunk); bytes += Buffer.byteLength(chunk); });
  const stream = input.pipe(parser.asStream({ packStrings: false, streamStrings: true,
    packNumbers: true, streamNumbers: false, packKeys: true, streamKeys: false }));
  const fields = [], types = [], frames = [], byType = new Map(), byClass = new Map(), names = new Map();
  let nodeCount, values = 0, examined = 0, strings = 0, maxNameId = -1, totalSelfSizeBytes = 0;
  let valueText = '', longString = false, row = [], nodesSeen = false, stringsSeen = false;
  const path = () => {
    const frame = frames[frames.length - 1];
    return frame ? frame.path.concat(frame.array ? frame.index : frame.key) : [];
  };
  const finish = () => { const frame = frames[frames.length - 1]; if (frame?.array) frame.index++; };
  const add = (map, key, initial, count, size) => {
    const entry = map.get(key) ?? { ...initial, count: 0, selfSizeBytes: 0 };
    entry.count += count; entry.selfSizeBytes += size; map.set(key, entry);
  };
  const classify = (typeId, raw, count, size) => {
    const type = types[typeId], label = classLabel(type, raw);
    add(byClass, type + '\0' + label, { type, class: label }, count, size);
  };
  const scalar = value => {
    const p = path();
    if (p.join('.') === 'snapshot.node_count') nodeCount = value;
    else if (p.length === 4 && p.slice(0, 3).join('.') === 'snapshot.meta.node_fields') fields.push(value);
    else if (p.length === 5 && p.slice(0, 4).join('.') === 'snapshot.meta.node_types.0') types.push(value);
    else if (p.length === 2 && p[0] === 'nodes') {
      if (!fields.length || !types.length) throw TypeError('Heap metadata must precede nodes');
      const nf = fields.length;
      row.push(value); values++;
      if (row.length === nf) {
        const typeId = row[fields.indexOf('type')], nameId = row[fields.indexOf('name')], size = row[fields.indexOf('self_size')];
        if (!Number.isSafeInteger(typeId) || typeId < 0 || typeId >= types.length ||
            !Number.isSafeInteger(nameId) || nameId < 0 || !Number.isSafeInteger(size) || size < 0)
          throw TypeError('Invalid heap snapshot node values');
        maxNameId = Math.max(maxNameId, nameId); examined++; totalSelfSizeBytes += size;
        add(byType, types[typeId], { type: types[typeId] }, 1, size);
        if (types[typeId].includes('string')) classify(typeId, '', 1, size);
        else {
          const name = names.get(nameId) ?? new Map();
          add(name, typeId, {}, 1, size); names.set(nameId, name);
        }
        row = [];
      }
    } else if (p.length === 2 && p[0] === 'strings') {
      if (typeof value !== 'string') throw TypeError('Invalid heap string table');
      for (const [typeId, entry] of names.get(strings) ?? []) classify(typeId, value, entry.count, entry.selfSizeBytes);
      names.delete(strings); strings++;
    }
    finish();
  };
  await new Promise((resolve, reject) => {
    input.once('error', reject); stream.once('error', reject); stream.once('end', resolve);
    stream.on('data', token => {
      try {
        if (token.name === 'keyValue') frames[frames.length - 1].key = token.value;
        else if (token.name === 'startObject' || token.name === 'startArray') {
          const p = path();
          if (p.length === 1 && p[0] === 'nodes') nodesSeen = true;
          if (p.length === 1 && p[0] === 'strings') stringsSeen = true;
          frames.push({ path: p, array: token.name === 'startArray', index: 0 });
        } else if (token.name === 'endObject' || token.name === 'endArray') { frames.pop(); finish(); }
        else if (token.name === 'startString') { valueText = ''; longString = false; }
        else if (token.name === 'stringChunk' && !longString) {
          if (valueText.length + token.value.length > 80) { valueText = ''; longString = true; }
          else valueText += token.value;
        } else if (token.name === 'endString') scalar(longString ? '' : valueText);
        else if (token.name === 'numberValue') scalar(Number(token.value));
        else if (['trueValue', 'falseValue', 'nullValue'].includes(token.name)) scalar(token.value);
      } catch (error) { input.destroy(); stream.destroy(error); }
    });
  });
  if (!Number.isSafeInteger(nodeCount) || nodeCount < 0 || !nodesSeen || !stringsSeen ||
      examined !== nodeCount || values !== nodeCount * fields.length || maxNameId >= strings || names.size)
    throw TypeError('Incomplete heap snapshot nodes/string table');
  return { bytes, sha256: hash.digest('hex'), census: { nodeCount, totalSelfSizeBytes,
    types: [...byType.values()].sort((a, b) => b.selfSizeBytes - a.selfSizeBytes),
    topClasses: [...byClass.values()].sort((a, b) => b.selfSizeBytes - a.selfSizeBytes).slice(0, top),
    definition: 'V8 snapshot node self_size, after snapshot GC; not retained/exclusive bytes or total native memory.' } };
}

async function main() {

const args = process.argv.slice(2);
const topIdx = args.indexOf('--top');
const TOP = topIdx >= 0 && args[topIdx + 1] ? Number(args[topIdx + 1]) : 30;
const asJson = args.includes('--json');
// Positional = non-flag args, skipping the value that follows --top.
const skipIdx = topIdx >= 0 ? topIdx + 1 : -1;
const positional = args.filter((a, i) => !a.startsWith('--') && i !== skipIdx);
const dir = positional[0] ?? join(homedir(), '.papercusp', 'heap-snapshots');

let files;
try {
  files = readdirSync(dir)
    .filter((f) => f.endsWith('.heapsnapshot'))
    .sort() // oldest→newest so we process in capture order
    .map((f) => join(dir, f));
} catch (e) {
  console.error(`Cannot read snapshot dir ${dir}: ${e.message}`);
  process.exit(1);
}
if (files.length === 0) {
  console.error(`No *.heapsnapshot in ${dir}`);
  console.error(
    `Tip: enable heap snapshots by setting PAPERCUSP_HEAP_SNAPSHOT=1 in the bg-host env.`,
  );
  process.exit(1);
}

// Aggregate across all snapshots: class name → { selfSize, count }.
// Aggregation by string value is cross-snapshot safe — each snapshot's strings[]
// is resolved to its actual value before accumulation.
const byClass = new Map(); // name → { selfSize: number, count: number }
let totalSizeBytes = 0;
let parsedSnapshots = 0;

for (const file of files) {
  try {
    const { census } = await summarizeHeapSnapshotStream(createReadStream(file), { top: 100 });
    parsedSnapshots++; totalSizeBytes += census.totalSelfSizeBytes;
    for (const row of census.topClasses) {
      const prev = byClass.get(row.class) ?? { selfSize: 0, count: 0 };
      prev.selfSize += row.selfSizeBytes; prev.count += row.count; byClass.set(row.class, prev);
    }
  } catch (error) { console.error(`  skip (unparseable): ${file}: ${error.message}`); }
}

if (parsedSnapshots === 0) {
  console.error('No valid snapshots found — all files skipped.');
  process.exit(1);
}

const sorted = [...byClass.entries()]
  .sort((a, b) => b[1].selfSize - a[1].selfSize)
  .slice(0, TOP);

const mb = (b) => (b / 1_048_576).toFixed(1).padStart(8);
const pct = (b) => (100 * (b / (totalSizeBytes || 1))).toFixed(1).padStart(5);
// Single-line + length-clamp a class label so one long/multi-line name can't
// break the table alignment (string nodes are already collapsed, but regexp /
// long constructor names can still be wide).
const label = (s) => {
  const oneLine = String(s).replace(/\s+/g, ' ').trim();
  return oneLine.length > 80 ? oneLine.slice(0, 77) + '…' : oneLine;
};
const totalMb = (totalSizeBytes / 1_048_576).toFixed(1);
const totalGb = (totalSizeBytes / 1_073_741_824).toFixed(2);

if (asJson) {
  console.log(
    JSON.stringify(
      {
        snapshots: parsedSnapshots,
        totalSizeBytes,
        topRetainers: sorted.map(([cls, { selfSize, count }]) => ({
          class: cls,
          selfSizeBytes: selfSize,
          selfSizeMb: Math.round(selfSize / 1_048_576),
          count,
          pctOfTotal: +(100 * (selfSize / (totalSizeBytes || 1))).toFixed(1),
        })),
      },
      null,
      2,
    ),
  );
} else {
  console.log(
    `\nSnapshots: ${parsedSnapshots}  total tracked heap: ${totalMb} MB (${totalGb} GB)`,
  );
  console.log(`\nTop ${TOP} retainer classes by self_size (aggregated across ${parsedSnapshots} snapshot(s)):`);
  console.log(`  ${'size(MB)'.padStart(8)}  ${'%'.padStart(5)}  ${'count'.padStart(10)}  class`);
  for (const [cls, { selfSize, count }] of sorted) {
    console.log(
      `  ${mb(selfSize)}  ${pct(selfSize)}%  ${String(count).padStart(10)}  ${label(cls)}`,
    );
  }
  console.log(
    `\nTip: load a .heapsnapshot in Chrome DevTools (Memory → Load) for the full retainer tree.`,
  );
  console.log(`     Snapshots are in: ${dir}`);
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
