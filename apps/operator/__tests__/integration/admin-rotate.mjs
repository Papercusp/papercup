#!/usr/bin/env node
/**
 * Tests for POST /api/admin/spawn-signing/rotate.
 *
 * Verifies:
 *   - 401 without bearer
 *   - 401 with wrong bearer
 *   - 200 with correct bearer (loopback)
 *   - Old signed URL fails after rotation (invalid_signature)
 *   - New signed URL (signed AFTER rotation) succeeds
 *
 * Run with: node __tests__/integration/admin-rotate.mjs
 */
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const OP_PORT = process.env.OP_PORT || '3070';
const BASE = `http://localhost:${OP_PORT}`;
const TOKEN_PATH = process.env.PAPERCUSP_SUPERUSER_TOKEN_FILE
  ?? `${process.env.HOME}/.papercusp/superuser-token`;

let pass = 0, fail = 0;
const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };
const bad = (n, d='') => { console.log(`  ✗ ${n}  ${d}`); fail++; };

// Inline the canonicalization + sign helpers — keep this self-contained.
const SIGNED = new Set(['harness','workspace','role','run','spawn','feature','chunk','parent_spawn','exp']);
function canonical(params) {
  const pairs = [];
  for (const [k, v] of params.entries()) {
    if (k === 'sig') continue;
    if (!SIGNED.has(k)) continue;
    pairs.push([k, v]);
  }
  pairs.sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0);
  return pairs.map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}
function sign(params, key, ttlSec = 3600) {
  params.delete('sig');
  params.set('exp', String(Math.floor(Date.now()/1000) + ttlSec));
  const sig = createHmac('sha256', key).update(canonical(params)).digest('base64url');
  params.set('sig', sig);
}
function freshParams(role = 'operator') {
  const p = new URLSearchParams();
  p.set('harness', 'sheets');
  p.set('workspace', 'default');
  p.set('role', role);
  p.set('run', 'r_admin_' + Date.now());
  p.set('spawn', 's_admin_' + randomBytes(4).toString('hex'));
  return p;
}
async function callMcp(params, payload) {
  const r = await fetch(`${BASE}/api/mcp?${params.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  return { status: r.status, text: await r.text() };
}

function readKey() {
  return Buffer.from(
    execSync(`PGPASSWORD=harness_admin_pwd psql -h localhost -p 5432 -U harness_admin -d papercusp -tAc "SELECT value_b64 FROM harness_shared.operator_secrets WHERE name='spawn-signing-key';"`, { encoding: 'utf8' }).trim(),
    'base64'
  );
}

async function main() {
  const bearer = readFileSync(TOKEN_PATH, 'utf8').trim();
  const initialKey = readKey();

  console.log(`--- targeting ${BASE} ---`);

  // 1. unauthenticated → 401
  const r1 = await fetch(`${BASE}/api/admin/spawn-signing/rotate`, { method: 'POST' });
  check(r1.status === 401, 'no auth → 401', `status=${r1.status}`);

  // 2. wrong bearer → 401
  const r2 = await fetch(`${BASE}/api/admin/spawn-signing/rotate`, {
    method: 'POST', headers: { Authorization: 'Bearer wrong_token_xxxxxxx' },
  });
  check(r2.status === 401, 'wrong bearer → 401', `status=${r2.status}`);

  // 3. Sign a URL with the CURRENT key, prove it works
  const p3 = freshParams('operator');
  sign(p3, initialKey);
  const c3 = await callMcp(p3, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'autoloop:control', arguments: { op: 'resume' } } });
  check(c3.text.includes('"result"'), 'pre-rotate sig accepted', c3.text.slice(0,200));

  // 4. Rotate via the endpoint
  const r4 = await fetch(`${BASE}/api/admin/spawn-signing/rotate`, {
    method: 'POST', headers: { Authorization: `Bearer ${bearer}` },
  });
  check(r4.status === 200, 'authorized rotate → 200', `status=${r4.status}`);
  const body4 = await r4.json();
  check(typeof body4.rotatedAt === 'string', 'rotate response carries rotatedAt');

  // 5. Old URL (signed with previous key) should now FAIL
  const c5 = await callMcp(p3, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'autoloop:control', arguments: { op: 'resume' } } });
  check(c5.text.includes('invalid_signature'), 'old sig rejected after rotate', c5.text.slice(0,200));

  // 6. New key from PG should work
  const newKey = readKey();
  check(!newKey.equals(initialKey), 'PG key changed', `initial=${initialKey.toString('hex').slice(0,8)} new=${newKey.toString('hex').slice(0,8)}`);

  const p6 = freshParams('operator');
  sign(p6, newKey);
  const c6 = await callMcp(p6, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'autoloop:control', arguments: { op: 'resume' } } });
  check(c6.text.includes('"result"'), 'new sig accepted post-rotate', c6.text.slice(0,200));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

function check(cond, name, detail='') { cond ? ok(name) : bad(name, detail); }

main().catch((e) => { console.error(e); process.exit(2); });
