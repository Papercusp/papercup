/**
 * End-to-end HMAC spawn-signing tests against the live operator.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-027.
 * Migrated from apps/operator/__tests__/integration/spawn-signing-e2e.mjs.
 *
 * Reads signing key from PG, builds signed URLs, exercises every
 * failure mode through the actual HTTP boundary.
 * Skipped when operator is not reachable.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';

const OP_HOST = process.env.OP_HOST ?? 'localhost';
const OP_PORT = process.env.OP_PORT ?? '3070';
const BASE = `http://${OP_HOST}:${OP_PORT}`;

let baseUrl = '';
try {
  const probe = await fetch(BASE, { signal: AbortSignal.timeout(3000) });
  if (probe.status < 500) baseUrl = BASE;
} catch { /* operator not running */ }

const itLive = baseUrl ? it : it.skip;

// ── Signing helpers ──────────────────────────────────────────────────
const SIGNED = new Set(['harness','workspace','role','run','spawn','feature','chunk','parent_spawn','exp']);

function canonical(params: URLSearchParams): string {
  const seen = new Set<string>();
  const pairs: [string, string][] = [];
  for (const [k, v] of params.entries()) {
    if (k === 'sig') continue;
    if (!SIGNED.has(k)) continue;
    if (seen.has(k)) throw new Error(`dup:${k}`);
    seen.add(k);
    pairs.push([k, v]);
  }
  pairs.sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0);
  return pairs.map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

function sign(params: URLSearchParams, key: Buffer, ttlSec = 24*3600): void {
  params.delete('sig');
  params.set('exp', String(Math.floor(Date.now()/1000) + ttlSec));
  const sig = createHmac('sha256', key).update(canonical(params)).digest('base64url');
  params.set('sig', sig);
}

function freshParams(overrides: Record<string, string> = {}): URLSearchParams {
  const p = new URLSearchParams();
  p.set('harness', overrides.harness ?? 'sheets');
  p.set('workspace', overrides.workspace ?? 'default');
  p.set('role', overrides.role ?? 'worker');
  p.set('run', 'r_test_' + Date.now());
  p.set('spawn', 's_test_' + randomBytes(4).toString('hex'));
  return p;
}

async function mcp(params: URLSearchParams, payload: unknown) {
  const r = await fetch(`${baseUrl}/api/mcp?${params.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  return { status: r.status, text: await r.text() };
}

function pgKey(): Buffer {
  const out = execSync(
    `PGPASSWORD=harness_admin_pwd psql -h localhost -p 5432 -U harness_admin -d papercusp -tAc "SELECT value_b64 FROM harness_shared.operator_secrets WHERE name='spawn-signing-key';"`,
    { encoding: 'utf8' },
  ).trim();
  return Buffer.from(out, 'base64');
}

function pgCount(sql: string): number {
  return Number(execSync(
    `PGPASSWORD=harness_admin_pwd psql -h localhost -p 5432 -U harness_admin -d papercusp -tAc "${sql}"`,
    { encoding: 'utf8' },
  ).trim());
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

const LIST_TOOLS = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

describe('spawn-signing e2e', () => {
  afterAll(() => cleanup('s_test_%'));

  itLive('signed worker URL → 200 + role-filtered tool list', async () => {
    const key = pgKey();
    const p = freshParams();
    sign(p, key);
    const r = await mcp(p, LIST_TOOLS);
    expect(r.status).toBe(200);
    expect(r.text).toContain('"tools"');
    expect(r.text).not.toContain('"autoloop:control"');
  });

  itLive('tampered role → invalid_signature on tools/call', async () => {
    const key = pgKey();
    const p = freshParams({ role: 'worker' });
    sign(p, key);
    p.set('role', 'operator');
    const r = await mcp(p, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'autoloop:control', arguments: { op: 'resume' } } });
    expect(r.text).toContain('request_rejected');
    expect(r.text).toContain('invalid_signature');
  });

  itLive('unsigned + claimed context → loud auth-fail, NO tools (strict mode, WI-574)', async () => {
    const p = freshParams();
    const r = await mcp(p, LIST_TOOLS);
    expect(r.status).toBe(200);
    // WI-574 (loud auth-fail): an unsigned request that CLAIMS a spawn context now FAILS LOUDLY
    // rather than silently advertising an empty tool list — "tools": [] is indistinguishable from
    // a healthy zero-tool server, which masked broken/expired credentials. The session exposes NO
    // tools, surfaced as an mcp_auth_failed JSON-RPC error (not an empty list).
    expect(r.text).toContain('mcp_auth_failed');
    expect(r.text).toContain('spawn_sig_missing_sig_required_mode');
    // …and it must never leak an actual (populated) tool list.
    expect(/"tools":\s*\[\s*\{/.test(r.text)).toBe(false);
  });

  itLive('bare /api/mcp (no claim) → full tool catalog', async () => {
    const r = await fetch(`${baseUrl}/api/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify(LIST_TOOLS),
    });
    const text = await r.text();
    expect(r.status).toBe(200);
    expect(/"tools":\s*\[\s*\{/.test(text)).toBe(true);
  });

  itLive('expired sig → rejected on tools/call', async () => {
    const key = pgKey();
    const p = freshParams({ role: 'operator' });
    sign(p, key, -10);
    const r = await mcp(p, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'autoloop:control', arguments: { op: 'resume' } } });
    expect(r.text).toContain('request_rejected');
    expect(r.text).toContain('expired');
  });

  itLive('signed worker cannot call operator-only autoloop:control', async () => {
    const key = pgKey();
    const p = freshParams({ role: 'worker' });
    sign(p, key);
    const r = await mcp(p, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'autoloop:control', arguments: { op: 'resume' } } });
    expect(
      r.text.includes('role_not_allowed') || r.text.includes('not_allowed') || r.text.includes('unknown_tool'),
    ).toBe(true);
  });

  itLive('signed operator role can call autoloop:control', async () => {
    const key = pgKey();
    const p = freshParams({ role: 'operator' });
    sign(p, key);
    const r = await mcp(p, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'autoloop:control', arguments: { op: 'resume' } } });
    expect(r.status).toBe(200);
    expect(r.text.includes('"result"') || r.text.includes('"ok":true')).toBe(true);
  });

  itLive('agent_tools:list reports worker role, non-superuser', async () => {
    const key = pgKey();
    const p = freshParams({ role: 'worker' });
    sign(p, key);
    const r = await mcp(p, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'agent_tools:list', arguments: {} } });
    expect(r.text).toContain('\\"callerRole\\":\\"worker\\"');
    expect(r.text).toContain('\\"isSuperuser\\":false');
  });

  itLive('worker sees autoloop:control with allowed:false in full list', async () => {
    const key = pgKey();
    const p = freshParams({ role: 'worker' });
    sign(p, key);
    const r = await mcp(p, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'agent_tools:list', arguments: { onlyAllowed: false, filter: 'autoloop:control' } } });
    const match = r.text.match(/\\"name\\":\\"autoloop:control\\"[\s\S]*?\\"allowed\\":(true|false)/);
    expect(match?.[1]).toBe('false');
  });

  itLive('audit row written for tampered sig', async () => {
    const key = pgKey();
    const before = pgCount("SELECT count(*) FROM harness_shared.spawn_sig_verification_failures WHERE reason='invalid_signature'");
    const p = freshParams();
    sign(p, key);
    p.set('role', 'operator');
    await mcp(p, LIST_TOOLS);
    await new Promise((r) => setTimeout(r, 500));
    const after = pgCount("SELECT count(*) FROM harness_shared.spawn_sig_verification_failures WHERE reason='invalid_signature'");
    expect(after).toBe(before + 1);
  });
});
