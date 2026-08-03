// Throwaway: measure the exact char delta of the queued dev:pg_query description trim
// (WI-7451). Deliberately does NOT load the tool catalog — that times out (EI-19418721410168539).
import { readFileSync } from 'node:fs';

const path = 'packages/operator-core/lib/agent-tools/dev/pg_query.ts';
const src = readFileSync(path, 'utf8');

// Grab the single-quoted description literal and let the JS engine unescape it,
// so the length we measure is the RUNTIME string the budget formula sees.
const m = src.match(/ {2}description:\n {4}('(?:\\.|[^'\\])*'),/);
if (!m) {
  console.log('NO MATCH — the description literal shape changed');
  process.exit(1);
}
const current = new Function(`return ${m[1]}`)();

const OLD_A = '(the canonical store behind plans,';
const NEW_A = '(canonical store: plans,';
const OLD_B =
  '(connect + acquire + execute) — a hung acquire (pool exhaustion, or a mid-call operator restart) fails fast with reason "call_timeout" rather than hanging.';
const NEW_B =
  '(connect + acquire + execute), so a hung acquire (pool exhaustion, mid-call operator restart) fails fast with reason "call_timeout".';

const hitA = current.includes(OLD_A);
const hitB = current.includes(OLD_B);
const proposed = current.replace(OLD_A, NEW_A).replace(OLD_B, NEW_B);

const GATE_MEASURED_WEIGHT = 1510; // from the failing assertion at HEAD
const BUDGET = 1500;
const saved = current.length - proposed.length;
const projected = GATE_MEASURED_WEIGHT - saved;

console.log('replacement A matches   :', hitA);
console.log('replacement B matches   :', hitB);
console.log('current description len :', current.length);
console.log('proposed description len:', proposed.length);
console.log('chars saved             :', saved);
console.log('gate-measured weight    :', GATE_MEASURED_WEIGHT);
console.log('projected new weight    :', projected, `(budget ${BUDGET})`);
console.log('headroom under budget   :', BUDGET - projected);
console.log('VERDICT                 :', projected <= BUDGET ? 'CLEARS' : 'STILL OVER');
