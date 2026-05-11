#!/usr/bin/env node
/**
 * Per-role projected-catalog probe.
 *
 * For every spawnable role, mint a signed spawn URL, hit tools/list,
 * and assert the new agent_tools:list + ui:* tools are present. This
 * verifies that the projected dispatcher (`/api/mcp`) exposes the
 * full surface to orchestrator-spawned workers — distinct from the
 * chat-surface allowedTools test which only covers claude-code's
 * curated whitelist.
 */
import { execSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';

const PORT = process.env.OP_PORT ?? '3055';
const BASE = `http://localhost:${PORT}`;

function pgKey() {
  return Buffer.from(execSync(
    `PGPASSWORD=harness_admin_pwd psql -h localhost -p 5432 -U harness_admin -d papercusp -tAc "SELECT value_b64 FROM harness_shared.operator_secrets WHERE name='spawn-signing-key';"`,
    { encoding: 'utf8' }).trim(), 'base64');
}

const SIGNED = new Set(['harness','workspace','role','run','spawn','feature','chunk','parent_spawn','client','exp']);
function canonical(p) {
  const a = [], s = new Set();
  for (const [k, v] of p.entries()) {
    if (k === 'sig') continue;
    if (!SIGNED.has(k)) continue;
    if (s.has(k)) throw new Error(`dup:${k}`);
    s.add(k); a.push([k, v]);
  }
  a.sort(([x], [y]) => x < y ? -1 : 1);
  return a.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}
function sign(p, k) {
  p.delete('sig');
  p.set('exp', String(Math.floor(Date.now() / 1000) + 3600));
  p.set('sig', createHmac('sha256', k).update(canonical(p)).digest('base64url'));
}

const REQUIRED = ['agent_tools:list', 'ui:list_clients', 'ui:get_state', 'ui:dispatch'];
const ROLES = ['worker', 'scoper', 'architect', 'validator', 'reviewer', 'debugger', 'documenter', 'curator', 'operator'];

let pass = 0, fail = 0;
const check = (n, c) => (c ? (console.log(`  ✓ ${n}`), pass++) : (console.log(`  ✗ ${n}`), fail++));

const key = pgKey();

for (const role of ROLES) {
  console.log(`--- role=${role} ---`);
  const p = new URLSearchParams();
  p.set('harness', 'sheets');
  p.set('workspace', 'default');
  p.set('role', role);
  p.set('run', 'r_probe_' + Date.now());
  p.set('spawn', 's_probe_' + randomBytes(4).toString('hex'));
  sign(p, key);
  const r = await fetch(`${BASE}/api/mcp?${p}`, {
    method: 'POST',
    headers: { 'Accept': 'application/json, text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const text = await r.text();
  const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
  if (!dataLine) { console.log(`  ✗ NO RESPONSE`); fail++; continue; }
  const env = JSON.parse(dataLine.slice(5).trim());
  const names = (env.result?.tools ?? []).map((t) => t.name);
  for (const t of REQUIRED) check(`${t}`, names.includes(t));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
