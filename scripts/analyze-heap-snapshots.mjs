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

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

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
    const label = !type.includes('string') && typeof raw === 'string' && raw.length <= 80 &&
      (/^[A-Za-z_$][A-Za-z0-9_.$]*$/.test(raw) || /^\(object (?:elements|properties)\)$/.test(raw))
      ? raw : '(' + type + ')';
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

function main() {

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
  let snap;
  try {
    snap = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    console.error(`  skip (unparseable): ${file}`);
    continue;
  }

  const meta = snap.snapshot?.meta;
  if (!meta) {
    console.error(`  skip (no snapshot.meta): ${file}`);
    continue;
  }

  const nodeFields = meta.node_fields;
  const nodeTypeNames = meta.node_types?.[0]; // e.g. ["hidden","array","string","object","code",…]
  const nf = nodeFields?.length;
  if (!nf || !Array.isArray(nodeTypeNames)) {
    console.error(`  skip (missing node_fields or node_types): ${file}`);
    continue;
  }

  const typeIdx = nodeFields.indexOf('type');
  const nameIdx = nodeFields.indexOf('name');
  const selfSizeIdx = nodeFields.indexOf('self_size');
  if (typeIdx < 0 || nameIdx < 0 || selfSizeIdx < 0) {
    console.error(
      `  skip (node_fields missing type/name/self_size — got: ${nodeFields.join(',')}): ${file}`,
    );
    continue;
  }

  const nodes = snap.nodes;
  const strings = snap.strings;
  const nodeCount = snap.snapshot.node_count ?? 0;
  if (!Array.isArray(nodes) || !Array.isArray(strings)) {
    console.error(`  skip (nodes or strings not arrays): ${file}`);
    continue;
  }

  parsedSnapshots++;

  for (let i = 0; i < nodeCount; i++) {
    const base = i * nf;
    const typeId = nodes[base + typeIdx];
    const nameId = nodes[base + nameIdx];
    const selfSize = nodes[base + selfSizeIdx] ?? 0;

    // Classify into a retainer CLASS. For object/closure/code/regexp nodes the
    // `name` field is a class / function / source name — useful to keep. But for
    // STRING-family nodes (V8 types "string" / "concatenated string" /
    // "sliced string") the `name` is the string's own *content*: unbounded and
    // NOT a class. Keying by it would make every distinct string its own "class"
    // (and dump multi-line bodies into the table). Collapse all string nodes
    // under one `(string)` bucket — go to DevTools for the actual strings.
    // Empty names fall back to the V8 node type.
    const typeStr = nodeTypeNames[typeId] ?? 'unknown';
    const isStringNode = typeStr.includes('string');
    const nameStr = isStringNode ? '' : strings[nameId] ?? '';
    const key = nameStr || `(${typeStr})`;

    const prev = byClass.get(key);
    if (prev) {
      prev.selfSize += selfSize;
      prev.count += 1;
    } else {
      byClass.set(key, { selfSize, count: 1 });
    }
    totalSizeBytes += selfSize;
  }
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
