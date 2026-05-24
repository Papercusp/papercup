/**
 * Regression suite for agent_tools:list — Vitest integration version.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-027.
 * Migrated from apps/operator/__tests__/integration/agent-tools-list.mjs.
 *
 * Verifies:
 *   1. callerRole and isSuperuser reflect the spawn ctx
 *   2. superuser sees every MCP-projected tool as allowed
 *   3. asRole=<X> overrides role + drops superuser bypass + drops principal
 *   4. role_not_allowed and missing_capability reasons surface correctly
 *   5. filter regex narrows results
 *   6. limit is honored
 *
 * Skipped when no live Hono server is reachable.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const OP_PORT = process.env.OP_PORT ?? null;
const BASE = OP_PORT
  ? `http://localhost:${OP_PORT}`
  : (process.env.OPERATOR_BASE_URL ?? 'http://localhost:3070');

interface ToolListEntry {
  name: string;
  description: string;
  roles: string[] | null;
  allowed: boolean;
  reason?: string;
}
interface ToolListResult {
  callerRole?: string;
  isSuperuser?: boolean;
  count?: number;
  tools?: ToolListEntry[];
}

async function isLive(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

function readToken(): string | null {
  try {
    return readFileSync(join(homedir(), '.papercusp', 'superuser-token'), 'utf8').trim();
  } catch {
    return null;
  }
}

async function call(token: string, name: string, args: Record<string, unknown> = {},
                    urlSuffix = '?superuser=1&workspace=default'): Promise<ToolListResult> {
  const r = await fetch(`${BASE}/api/mcp${urlSuffix}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await r.text();
  const dataLine = body.split('\n').find((l) => l.startsWith('data:'));
  if (!dataLine) throw new Error(`no data frame: ${body.slice(0, 300)}`);
  const env = JSON.parse(dataLine.slice('data:'.length).trim()) as {
    result?: { content?: Array<{ text?: string }> };
  };
  const text = env.result?.content?.[0]?.text;
  return text ? JSON.parse(text) as ToolListResult : env as ToolListResult;
}

describe('agent_tools:list discovery + permission shape', async () => {
  const live = await isLive();
  let token: string | null = null;
  beforeAll(() => {
    if (live) token = readToken();
  });

  it.skipIf(!live || !token)('callerRole + isSuperuser reflect ctx', async () => {
    const su = await call(token!, 'agent_tools:list');
    expect(su.callerRole).toBe('operator');
    expect(su.isSuperuser).toBe(true);
  });

  it.skipIf(!live || !token)('superuser sees every tool allowed', async () => {
    const su = await call(token!, 'agent_tools:list');
    expect(su.count!).toBeGreaterThan(100);
    expect(su.tools!.every((t) => t.allowed === true)).toBe(true);
    expect(su.tools!.every((t) =>
      typeof t.name === 'string' &&
      typeof t.description === 'string' &&
      (t.roles === null || Array.isArray(t.roles)) &&
      typeof t.allowed === 'boolean',
    )).toBe(true);
  });

  it.skipIf(!live || !token)('asRole=worker reduces surface + drops bypass', async () => {
    const su = await call(token!, 'agent_tools:list');
    const worker = await call(token!, 'agent_tools:list', { asRole: 'worker' });
    expect(worker.callerRole).toBe('worker');
    expect(worker.isSuperuser).toBe(false);
    expect(worker.count!).toBeLessThan(su.count!);
    expect(worker.count!).toBeGreaterThan(50);
  });

  it.skipIf(!live || !token)('role/cap gating reason surfaces with onlyAllowed=false', async () => {
    const w2 = await call(token!, 'agent_tools:list', {
      asRole: 'worker', onlyAllowed: false, filter: 'autoloop',
    });
    expect(w2.tools!.some((t) => t.name === 'autoloop:status')).toBe(true);
    expect(w2.tools!.some((t) => t.name === 'autoloop:control')).toBe(true);
    const status = w2.tools!.find((t) => t.name === 'autoloop:status')!;
    const control = w2.tools!.find((t) => t.name === 'autoloop:control')!;
    expect(status.allowed).toBe(true);
    expect(control.allowed).toBe(false);
    expect(control.reason?.startsWith('role_not_allowed')).toBe(true);
  });

  it.skipIf(!live || !token)('filter narrows', async () => {
    const har = await call(token!, 'agent_tools:list', { filter: 'harness:' });
    expect(har.tools!.every((t) => /harness:/i.test(t.name))).toBe(true);
    expect(har.count!).toBeGreaterThan(5);
  });

  it.skipIf(!live || !token)('limit honored', async () => {
    const lim = await call(token!, 'agent_tools:list', { limit: 7 });
    expect(lim.count).toBe(7);
    expect(lim.tools!.length).toBe(7);
  });

  it.skipIf(!live || !token)('unknown asRole still returns a shape', async () => {
    const fake = await call(token!, 'agent_tools:list', {
      asRole: 'nonexistent-role-xyz', onlyAllowed: false, limit: 5,
    });
    expect(typeof fake.count).toBe('number');
  });

  it('skipped diagnostic when server is down', () => {
    expect(live ? 'live' : 'offline').toMatch(/^(live|offline)$/);
  });
});
