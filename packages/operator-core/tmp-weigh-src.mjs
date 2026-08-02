// Extract + evaluate the description/guidance string EXPRESSIONS from a
// leader-brief-shaped defineTool source, and report promptWeight() exactly as
// tool-guidance-budget.ts computes it (description + when + notWhen + chaining).
import fs from 'node:fs';

const src = fs.readFileSync(process.argv[2], 'utf8');
const start = src.indexOf('export default defineTool');
if (start < 0) throw new Error('no defineTool');
const seg = src.slice(start);

function grab(key, stopKeys) {
  const re = new RegExp(`\\n\\s{2,6}${key}:\\s*`, '');
  const m = re.exec(seg);
  if (!m) return null;
  const from = m.index + m[0].length;
  let end = seg.length;
  for (const k of stopKeys) {
    const r = new RegExp(`\\n\\s{2,6}${k}:\\s*`, '');
    const mm = r.exec(seg.slice(from));
    if (mm && from + mm.index < end) end = from + mm.index;
  }
  // also stop at a closing "  }," of the guidance object
  const closeIdx = seg.slice(from).search(/\n\s{2,4}\},?\n/);
  if (closeIdx >= 0 && from + closeIdx < end) end = from + closeIdx;
  let expr = seg.slice(from, end).trim();
  expr = expr.replace(/,\s*$/, '');
  return eval(`(${expr})`);
}

const description = grab('description', ['guidance', 'capability', 'args']);
const when = grab('when', ['notWhen', 'chaining', 'byRole']);
const notWhen = grab('notWhen', ['chaining', 'byRole', 'when']);
const chaining = grab('chaining', ['byRole', 'when', 'notWhen']);

const parts = { description, when, notWhen, chaining };
let total = 0;
for (const [k, v] of Object.entries(parts)) {
  const n = typeof v === 'string' ? v.length : 0;
  total += n;
  console.log(k.padEnd(12), String(n).padStart(5));
}
console.log('-'.repeat(20));
console.log('TOTAL'.padEnd(12), String(total).padStart(5), ' (BUDGET 1500 / HARD_CAP 1600)');
console.log(
  total > 1600
    ? `OVER HARD CAP by ${total - 1600}`
    : total > 1500
      ? `over budget by ${total - 1500} (under hard cap)`
      : `UNDER BUDGET by ${1500 - total}`,
);
