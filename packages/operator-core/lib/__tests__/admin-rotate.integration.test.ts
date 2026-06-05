/**
 * Tests for POST /api/admin/spawn-signing/rotate.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-027.
 * Migrated from apps/operator/__tests__/integration/admin-rotate.mjs.
 *
 *   - 401 without bearer / wrong bearer
 *   - 200 with correct bearer
 *   - Old signed URL fails after rotation (invalid_signature)
 *   - New signed URL (signed AFTER rotation) succeeds
 */

import { describe, it, expect, afterAll } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const OP_PORT = process.env.OP_PORT ?? '3070';
const BASE = `http://localhost:${OP_PORT}`;
const TOKEN_PATH = process.env.PAPERCUSP_SUPERUSER_TOKEN_FILE
  ?? `${process.env.HOME}/.papercusp/superuser-token`;

let bearer = '';
let baseUrl = '';

try {
  bearer = readFileSync(TOKEN_PATH, 'utf8').trim();
  const probe = await fetch(`${BASE}/api/admin/spawn-signing/failures?limit=1`, {
    headers: { Authorization: `Bearer ${bearer}` },
  });
  if (probe.ok || probe.status === 400) baseUrl = BASE;
} catch { /* operator not running */ }

const itLive = baseUrl ? it : it.skip;

// ── Signing helpers (inlined; mirror admin-rotate.mjs) ──────────────
const SIGNED = new Set(['harness','workspace','role','run','spawn','feature','chunk','parent_spawn','exp']);
function canonical(params: URLSearchParams): string {
  const pairs: [string, string][] = [];
  for (const [k, v] of params.entries()) {
    if (k === 'sig' || !SIGNED.has(k)) continue;
    pairs.push([k, v]);
  }
  pairs.sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0);
  return pairs.map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}
function sign(params: URLSearchParams, key: Buffer, ttlSec = 3600): void {
  params.delete('sig');
  params.set('exp', String(Math.floor(Date.now()/1000) + ttlSec));
  const sig = createHmac('sha256', key).update(canonical(params)).digest('base64url');
  params.set('sig', sig);
}
function freshParams(role = 'operator'): URLSearchParams {
  const p = new URLSearchParams();
  p.set('harness', 'sheets');
  p.set('workspace', 'default');
  p.set('role', role);
  p.set('run', 'r_admin_' + Date.now());
  p.set('spawn', 's_admin_' + randomBytes(4).toString('hex'));
  return p;
}
async function callMcp(params: URLSearchParams, payload: unknown) {
  const r = await fetch(`${BASE}/api/mcp?${params.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  return { status: r.status, text: await r.text() };
}
function readKey(): Buffer {
  return Buffer.from(
    execSync(
      `PGPASSWORD=harness_admin_pwd psql -h localhost -p 5432 -U harness_admin -d papercusp -tAc "SELECT value_b64 FROM harness_shared.operator_secrets WHERE name='spawn-signing-key';"`,
      { encoding: 'utf8' },
    ).trim(),
    'base64',
  );
}

function cleanup(pattern: string) {
  try {
    execSync(
      `PGPASSWORD=harness_admin_pwd psql -h localhost -p 5432 -U harness_admin -d papercusp -c "DELETE FROM harness_shared.spawn_sig_verification_failures WHERE claimed_spawn LIKE '${pattern}'" -q`,
      { stdio: 'pipe' },
    );
  } catch (e) {
    console.warn(`[test cleanup] ${e instanceof Error ? e.message : e}`);
  }
}

describe('POST /api/admin/spawn-signing/rotate', () => {
  afterAll(() => cleanup('s_admin_%'));

  // Loopback requests resolve the loopback principal (trust 'unverified-loopback');
  // the route requires trust:['trusted'] → 403 per require-principal.ts's
  // documented contract (no-principal→401, wrong-trust→403). 401 is only for a
  // non-loopback request with no/invalid bearer.
  itLive('no auth (loopback principal, wrong trust) → 403', async () => {
    const r = await fetch(`${baseUrl}/api/admin/spawn-signing/rotate`, { method: 'POST' });
    expect(r.status).toBe(403);
  });

  itLive('wrong bearer (falls back to loopback, wrong trust) → 403', async () => {
    const r = await fetch(`${baseUrl}/api/admin/spawn-signing/rotate`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong_token_xxxxxxx' },
    });
    expect(r.status).toBe(403);
  });

  itLive('pre-rotate sig accepted, then rotate, then old sig rejected, new sig accepted', async () => {
    const initialKey = readKey();

    // Pre-rotate: sign + verify it works
    const preParams = freshParams('operator');
    sign(preParams, initialKey);
    const pre = await callMcp(preParams, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'autoloop:control', arguments: { op: 'resume' } } });
    expect(pre.text).toContain('"result"');

    // Rotate
    const rotateRes = await fetch(`${baseUrl}/api/admin/spawn-signing/rotate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}` },
    });
    expect(rotateRes.status).toBe(200);
    const rotateBody = await rotateRes.json();
    expect(typeof (rotateBody as any).rotatedAt).toBe('string');

    // Old URL now fails
    const postOld = await callMcp(preParams, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'autoloop:control', arguments: { op: 'resume' } } });
    expect(postOld.text).toContain('invalid_signature');

    // New key from PG works
    const newKey = readKey();
    expect(newKey.equals(initialKey)).toBe(false);

    const newParams = freshParams('operator');
    sign(newParams, newKey);
    const postNew = await callMcp(newParams, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'autoloop:control', arguments: { op: 'resume' } } });
    expect(postNew.text).toContain('"result"');
  });
});
