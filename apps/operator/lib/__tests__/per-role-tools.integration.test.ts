/**
 * Per-role projected-catalog probe — Vitest integration version.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-027.
 * Migrated from apps/operator/__tests__/integration/per-role-tools.mjs.
 *
 * For every spawnable role, mint a signed spawn URL, hit tools/list
 * via /api/mcp, and assert the new agent_tools:list + ui:* tools are
 * present. Verifies that the projected dispatcher exposes the full
 * surface to orchestrator-spawned workers — distinct from the chat-
 * surface allowedTools test (claude-code curated whitelist).
 *
 * Skipped when no live Hono server is reachable so the test doesn't
 * fail in cold contributor checkouts or CI without the embedded DB.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';

const PORT = process.env.OP_PORT ?? '3070';
const BASE = `http://localhost:${PORT}`;

function pgKey(): Buffer {
  return Buffer.from(
    execSync(
      `PGPASSWORD=harness_admin_pwd psql -h localhost -p 5432 -U harness_admin -d papercusp -tAc "SELECT value_b64 FROM harness_shared.operator_secrets WHERE name='spawn-signing-key';"`,
      { encoding: 'utf8' },
    ).trim(),
    'base64',
  );
}

const SIGNED = new Set([
  'harness', 'workspace', 'role', 'run', 'spawn',
  'feature', 'chunk', 'parent_spawn', 'client', 'exp',
]);

function canonical(p: URLSearchParams): string {
  const a: Array<[string, string]> = [];
  const s = new Set<string>();
  for (const [k, v] of p.entries()) {
    if (k === 'sig') continue;
    if (!SIGNED.has(k)) continue;
    if (s.has(k)) throw new Error(`dup:${k}`);
    s.add(k);
    a.push([k, v]);
  }
  a.sort(([x], [y]) => (x < y ? -1 : 1));
  return a.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

function sign(p: URLSearchParams, k: Buffer): void {
  p.delete('sig');
  p.set('exp', String(Math.floor(Date.now() / 1000) + 3600));
  p.set('sig', createHmac('sha256', k).update(canonical(p)).digest('base64url'));
}

const REQUIRED = ['agent_tools:list', 'ui:list_clients', 'ui:get_state', 'ui:dispatch'];
const ROLES = ['worker', 'scoper', 'architect', 'validator', 'reviewer', 'debugger', 'documenter', 'curator', 'operator'];

async function isLive(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

describe('per-role projected tools', async () => {
  const live = await isLive();
  let key: Buffer | null = null;
  beforeAll(() => {
    if (live) {
      try { key = pgKey(); } catch { key = null; }
    }
  });

  it.skipIf(!live || !key)('every role sees agent_tools:list + ui:* in tools/list', async () => {
    for (const role of ROLES) {
      const p = new URLSearchParams();
      p.set('harness', 'sheets');
      p.set('workspace', 'default');
      p.set('role', role);
      p.set('run', 'r_probe_' + Date.now());
      p.set('spawn', 's_probe_' + randomBytes(4).toString('hex'));
      sign(p, key!);
      const r = await fetch(`${BASE}/api/mcp?${p}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      const text = await r.text();
      const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
      expect(dataLine, `role=${role} got no SSE data line`).toBeDefined();
      const env = JSON.parse(dataLine!.slice(5).trim()) as {
        result?: { tools?: Array<{ name: string }> };
      };
      const names = (env.result?.tools ?? []).map((t) => t.name);
      for (const t of REQUIRED) {
        expect(names, `role=${role} missing ${t}`).toContain(t);
      }
    }
  });

  it('skipped diagnostic when server is down', () => {
    // Always passes — exists so the file has at least one runnable
    // case in cold checkouts (where the live test is skipped).
    expect(live ? 'live' : 'offline').toMatch(/^(live|offline)$/);
  });
});
