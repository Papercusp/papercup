#!/usr/bin/env node
/**
 * Regression suite for GET /api/admin/spawn-signing/failures.
 *
 *   1. unauthenticated → 401
 *   2. wrong bearer → 401
 *   3. invalid `since` → 400
 *   4. correct bearer + empty params → 200 with rows + summary shape
 *   5. tampering generates a row that appears in next read
 *   6. filter by reason works
 *   7. summary.byReason includes the new row
 *   8. limit honored
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.OPERATOR_BASE_URL ?? 'http://localhost:3070';
const TOKEN = readFileSync(join(homedir(), '.papercusp', 'superuser-token'), 'utf8').trim();

let pass = 0, fail = 0;
const check = (n, c) => (c ? (console.log(`  ✓ ${n}`), pass++) : (console.log(`  ✗ ${n}`), fail++));

async function get(qs = '', headers = { 'Authorization': `Bearer ${TOKEN}` }) {
  const r = await fetch(`${BASE}/api/admin/spawn-signing/failures${qs}`, { headers });
  const body = await r.text();
  let json = null;
  try { json = JSON.parse(body); } catch { /* */ }
  return { status: r.status, body, json };
}

console.log('--- auth ---');
const noauth = await get('', {});
check('no auth → 401', noauth.status === 401);
const bad = await get('', { 'Authorization': 'Bearer fake' });
check('wrong bearer → 401', bad.status === 401);

console.log('--- bad since ---');
const badSince = await get('?since=not-a-date');
check('bad since → 400', badSince.status === 400);

console.log('--- empty/default read ---');
const ok = await get('?limit=5');
check('200', ok.status === 200);
check('rows is array', Array.isArray(ok.json.rows));
check('summary.byReason exists', typeof ok.json.summary?.byReason === 'object');
check('summary.window present', typeof ok.json.summary?.window === 'string');

console.log('--- generate a tamper row, then verify it surfaces ---');
const before = await get('?limit=1000&reason=invalid_signature');
const beforeCount = before.json.rows.length;

// Generate one invalid_signature row via a deliberately tampered call.
await fetch(`${BASE}/api/mcp?harness=h&workspace=w&role=worker&run=r&spawn=s_audit_${Date.now()}&exp=9999999999&sig=BADSIG`, {
  method: 'POST',
  headers: { 'Accept': 'application/json, text/event-stream', 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'autoloop:status', arguments: {} } }),
});

await new Promise((r) => setTimeout(r, 200));
const after = await get('?limit=1000&reason=invalid_signature');
check('invalid_signature row appeared', after.json.rows.length > beforeCount);
check('newest row has reason=invalid_signature', after.json.rows[0]?.reason === 'invalid_signature');
check('row.id is number (BigInt coerced)', typeof after.json.rows[0]?.id === 'number');
check('row.exp_claim is number (BigInt coerced)',
  after.json.rows[0]?.exp_claim === null || typeof after.json.rows[0]?.exp_claim === 'number');
check('rows are ordered ts DESC', after.json.rows.every((r, i, a) =>
  i === 0 || new Date(a[i - 1].ts).getTime() >= new Date(r.ts).getTime()));

console.log('--- summary.byReason includes the new row ---');
const summed = await get('');
check('summary has invalid_signature entry',
  typeof summed.json.summary.byReason.invalid_signature === 'number' &&
  summed.json.summary.byReason.invalid_signature > 0);

console.log('--- limit honored ---');
const lim = await get('?limit=2');
check('rows.length <= 2', lim.json.rows.length <= 2);

console.log('--- clean up the test rows ---');
// best-effort cleanup so subsequent runs start from a known baseline
import('node:child_process').then(({ execSync }) => {
  try {
    execSync(`psql postgresql://postgres@/papercup -c "DELETE FROM harness_shared.spawn_sig_verification_failures WHERE claimed_spawn LIKE 's_audit_%'" -q`, { stdio: 'pipe' });
  } catch { /* */ }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
