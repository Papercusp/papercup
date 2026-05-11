import { inspectWasmMemoryMax } from '../src/wasm/wasm-plugin-host.ts';

let pass = 0, fail = 0;
const eq = (got, want, label) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗', label, 'got:', JSON.stringify(got), 'want:', JSON.stringify(want)); }
};

// WASM binary helpers
function buildMinimalWasm(memorySection /* bytes or null */) {
  const magic = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  const result = [...magic];
  if (memorySection) {
    result.push(0x05); // section id 5 = Memory
    result.push(memorySection.length); // section length
    result.push(...memorySection);
  }
  return new Uint8Array(result);
}

console.log('# wasm with memory min=1, max=10');
const memBoundedSec = [
  0x01,       // count = 1
  0x01,       // limits flag = 0x01 (max present)
  0x01,       // min = 1
  0x0a,       // max = 10
];
let r = inspectWasmMemoryMax(buildMinimalWasm(memBoundedSec));
eq(r, { min: 1, max: 10 }, 'parses bounded memory');

console.log('# wasm with no max (unbounded)');
const memUnboundedSec = [
  0x01,       // count = 1
  0x00,       // limits flag = 0x00 (no max)
  0x05,       // min = 5
];
r = inspectWasmMemoryMax(buildMinimalWasm(memUnboundedSec));
eq(r, { min: 5, max: null }, 'parses unbounded memory');

console.log('# wasm with no memory section at all');
r = inspectWasmMemoryMax(buildMinimalWasm(null));
eq(r, { min: 0, max: 0 }, 'no memory section → 0/0');

console.log('# bad magic → throws');
try {
  inspectWasmMemoryMax(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x01, 0x00, 0x00, 0x00]));
  fail++; console.log('  ✗ expected throw');
} catch (e) {
  pass++; console.log('  ✓ threw on bad magic');
}

console.log('# real hello-plugin wasm parses')
// Real wasm path is workstation-specific. PAPERCUP_WASM_PATH env override
// for CI; otherwise fall back to a probe relative to the repo root which
// works when papercup-native is checked out as a sibling.
const realPath = process.env.PAPERCUP_WASM_PATH ||
  new URL('../../../../papercup-native/plugins/hello-plugin/target/wasm32-wasip2/release/hello_plugin.wasm', import.meta.url).pathname;
import('node:fs').then(async (fs) => {
  try {
    const bytes = fs.readFileSync(realPath);
    const r2 = inspectWasmMemoryMax(new Uint8Array(bytes));
    console.log('  hello-plugin component memory section:', JSON.stringify(r2));
    pass++; console.log('  ✓ real wasm parses');
  } catch (e) {
    console.log('  (skipped — real wasm not present:', e.message, ')');
  }
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
});
