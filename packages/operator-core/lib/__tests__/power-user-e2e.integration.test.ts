/**
 * End-to-end regression for the workspace-power-user auth tier.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-027.
 * Migrated from apps/operator/__tests__/integration/power-user-e2e.mjs.
 * Skipped when operator is not reachable.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Issuing a power-user token now requires a verified|trusted principal
// (route auth tightened from "any principal incl. loopback" → trust:
// ['verified','trusted'] — you can't mint a power-user token from a bare
// unauthenticated loopback request). The superuser bearer resolves to trust
// 'trusted', so issue with it.
let SU_TOKEN = '';
try { SU_TOKEN = readFileSync(join(homedir(), '.papercusp', 'superuser-token'), 'utf8').trim(); } catch { /* */ }
const suAuth = SU_TOKEN ? { Authorization: `Bearer ${SU_TOKEN}` } : {};

const OP_PORT = process.env.OP_PORT ?? null;
const BASE = OP_PORT
  ? `http://localhost:${OP_PORT}`
  : (process.env.OPERATOR_BASE_URL ?? 'http://localhost:3070');

let baseUrl = '';
try {
  const probe = await fetch(`${BASE}/api/agent-tokens/power-user`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(3000),
  });
  if (probe.status < 500) baseUrl = BASE;
} catch { /* operator not running */ }

const itLive = baseUrl ? it : it.skip;

async function jsonPost(path: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, json, text };
}

async function mcpCall(urlSuffix: string, bearer: string, method: string, params: Record<string, unknown> = {}) {
  const r = await fetch(`${baseUrl}/api/mcp${urlSuffix}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await r.text();
  const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
  if (!dataLine) throw new Error(`no SSE frame: ${text.slice(0, 200)}`);
  return JSON.parse(dataLine.slice('data:'.length).trim());
}

describe('power-user auth tier e2e', () => {
  let access = '';
  let refresh = '';

  itLive('POST /api/agent-tokens/power-user issues token pair', async () => {
    const res = await jsonPost('/api/agent-tokens/power-user', {}, suAuth);
    expect(res.status).toBe(200);
    access = res.json?.access_token ?? '';
    refresh = res.json?.refresh_token ?? '';
    expect(typeof access).toBe('string');
    expect(access.length).toBeGreaterThan(0);
    expect(typeof refresh).toBe('string');
    expect(refresh.length).toBeGreaterThan(0);
    expect(typeof res.json?.workspace_id).toBe('string');
    expect(res.json?.auth_session_id).toMatch(/^pus-/);
    expect(Date.parse(res.json?.access_expires_at)).toBeLessThan(Date.parse(res.json?.refresh_expires_at));
  });

  itLive('POST .../refresh mints new access token; access token rejected as refresh', async () => {
    if (!access || !refresh) return;
    const refreshed = await jsonPost('/api/agent-tokens/power-user/refresh', undefined, { Authorization: `Bearer ${refresh}` });
    expect(refreshed.status).toBe(200);
    expect(typeof refreshed.json?.access_token).toBe('string');

    const wrongType = await jsonPost('/api/agent-tokens/power-user/refresh', undefined, { Authorization: `Bearer ${access}` });
    expect(wrongType.status).toBe(401);
  });

  itLive('GET /api/agent-bundle returns bundle with signed mcp_url', async () => {
    if (!access) return;
    const res = await fetch(`${baseUrl}/api/agent-bundle`, { headers: { Authorization: `Bearer ${access}` } });
    const bundle = await res.json().catch(() => null) as any;
    expect(res.status).toBe(200);
    expect((bundle?.toolsmd?.length ?? 0)).toBeGreaterThan(100);
    expect(bundle?.mcp_url).toMatch(/[?&]power_user=1/);
    expect(bundle?.mcp_url).not.toMatch(/token=/);
    expect(Array.isArray(bundle?.skills)).toBe(true);
    expect(Array.isArray(bundle?.hooks)).toBe(true);

    const noTok = await fetch(`${baseUrl}/api/agent-bundle`);
    expect(noTok.status).toBe(401);
  });

  itLive('POST /api/mcp?power_user=1 tools/list: valid token returns catalog, garbage returns empty', async () => {
    if (!access) return;
    const good = await mcpCall('?power_user=1', access, 'tools/list');
    expect((good?.result?.tools ?? []).length).toBeGreaterThan(0);

    const bad = await mcpCall('?power_user=1', 'garbage.token', 'tools/list');
    expect((bad?.result?.tools ?? []).length).toBe(0);
  });

  itLive('POST /api/agent-mcp/console/launch {mode:omp} returns structured result', async () => {
    const res = await fetch(`${baseUrl}/api/agent-mcp/console/launch`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ mode: 'omp' }),
    });
    const json = await res.json().catch(() => null) as any;
    const valid =
      json?.status === 'ok' ||
      json?.code === 'omp_not_installed' ||
      json?.code === 'omp_not_bootstrapped';
    expect(valid).toBe(true);
    if (json?.code === 'omp_not_installed' || json?.code === 'omp_not_bootstrapped') {
      expect(typeof json.installCmd).toBe('string');
    }
  });
});
