/**
 * Regression suite for GET /api/admin/spawn-signing/failures.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-027.
 * Migrated from apps/operator/__tests__/integration/admin-failures.mjs.
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

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const OP_PORT = process.env.OP_PORT ?? null;
const BASE = OP_PORT
  ? `http://localhost:${OP_PORT}`
  : (process.env.OPERATOR_BASE_URL ?? 'http://localhost:3070');

let TOKEN = '';
let baseUrl = '';

try {
  TOKEN = readFileSync(join(homedir(), '.papercusp', 'superuser-token'), 'utf8').trim();
  const r = await fetch(`${BASE}/api/admin/spawn-signing/failures?limit=1`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (r.ok || r.status === 400) baseUrl = BASE;
} catch { /* operator not running */ }

const itLive = baseUrl ? it : it.skip;

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

async function get(qs = '', headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` }) {
  const r = await fetch(`${baseUrl}/api/admin/spawn-signing/failures${qs}`, { headers });
  const body = await r.text();
  let json: any = null;
  try { json = JSON.parse(body); } catch { /* */ }
  return { status: r.status, body, json };
}

describe('GET /api/admin/spawn-signing/failures', () => {
  afterAll(() => cleanup('s_audit_%'));

  // These requests originate on loopback, so requirePrincipal resolves the
  // loopback principal (trust 'unverified-loopback'); the route requires
  // trust:['trusted'], so the trust check fails → 403 (per the documented
  // contract in lib/auth/require-principal.ts: no-principal→401, wrong-trust→403).
  // 401 only happens for a non-loopback request with no/invalid bearer.
  itLive('no auth (loopback principal, wrong trust) → 403', async () => {
    const res = await get('', {});
    expect(res.status).toBe(403);
  });

  itLive('wrong bearer (falls back to loopback, wrong trust) → 403', async () => {
    const res = await get('', { Authorization: 'Bearer fake' });
    expect(res.status).toBe(403);
  });

  itLive('bad since → 400', async () => {
    const res = await get('?since=not-a-date');
    expect(res.status).toBe(400);
  });

  itLive('200 with correct bearer', async () => {
    const res = await get('?limit=5');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json.rows)).toBe(true);
    expect(typeof res.json.summary?.byReason).toBe('object');
    expect(typeof res.json.summary?.window).toBe('string');
  });

  itLive('tamper row appears and is ordered DESC', async () => {
    const before = await get('?limit=1000&reason=invalid_signature');
    const beforeCount = before.json.rows.length;

    await fetch(
      `${baseUrl}/api/mcp?harness=h&workspace=w&role=worker&run=r&spawn=s_audit_${Date.now()}&exp=9999999999&sig=BADSIG`,
      {
        method: 'POST',
        headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'autoloop:status', arguments: {} } }),
      },
    );
    await new Promise((r) => setTimeout(r, 200));

    const after = await get('?limit=1000&reason=invalid_signature');
    expect(after.json.rows.length).toBeGreaterThan(beforeCount);
    expect(after.json.rows[0]?.reason).toBe('invalid_signature');
    expect(typeof after.json.rows[0]?.id).toBe('number');
    const ordered = after.json.rows.every((r: any, i: number, a: any[]) =>
      i === 0 || new Date(a[i - 1].ts).getTime() >= new Date(r.ts).getTime(),
    );
    expect(ordered).toBe(true);
  });

  itLive('summary.byReason includes invalid_signature', async () => {
    const res = await get('');
    expect(typeof res.json.summary.byReason.invalid_signature).toBe('number');
    expect(res.json.summary.byReason.invalid_signature).toBeGreaterThan(0);
  });

  itLive('limit honored', async () => {
    const res = await get('?limit=2');
    expect(res.json.rows.length).toBeLessThanOrEqual(2);
  });
});
