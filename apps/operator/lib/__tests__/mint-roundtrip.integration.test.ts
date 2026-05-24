/**
 * End-to-end mint+verify roundtrip:
 *   1. writeSignedSpawnMcp writes a .mcp.json
 *   2. Extract URL, hit operator, confirm it verifies (tools/list → 200)
 *   3. Worker role cannot invoke operator-only tool (role gate)
 *   4. Tampered URL (role rewritten) → invalid_signature
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-027.
 * Migrated from apps/operator/__tests__/integration/mint-roundtrip.mjs.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const OP_PORT = process.env.OP_PORT ?? '3070';
const BASE = `http://localhost:${OP_PORT}`;

let baseUrl = '';
try {
  const probe = await fetch(`${BASE}/api/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } }),
    signal: AbortSignal.timeout(3000),
  });
  if (probe.status < 500) baseUrl = BASE;
} catch { /* operator not running */ }

const itLive = baseUrl ? it : it.skip;

process.env.DATABASE_URL ||= 'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp';

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

describe('spawn-signing mint+verify roundtrip', () => {
  let tmpDir: string;
  afterAll(() => {
    if (tmpDir) try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    cleanup('s_mint_%');
  });

  itLive('.mcp.json minted with correct mode and URL', async () => {
    // Dynamic cross-package import; path resolved by Vitest/tsx at runtime
    const mod = await import('../../../../libs/papercusp/packages/orchestrator/src/spawn-mcp.ts' as string);
    const writeSignedSpawnMcp: (dir: string, opts: Record<string, unknown>) => Promise<{ path: string }> = mod.writeSignedSpawnMcp;

    tmpDir = mkdtempSync(join(tmpdir(), 'spawn-mint-'));
    const handle = await writeSignedSpawnMcp(tmpDir, {
      harnessSlug: 'sheets',
      workspaceId: 'default',
      role: 'worker',
      runId: 'r_mint_test_' + Date.now(),
      spawnId: 's_mint_' + Math.random().toString(36).slice(2),
      featureId: null,
      chunkId: null,
      parentSpawnId: null,
    });

    const st = statSync(handle.path);
    expect((st.mode & 0o777).toString(8)).toBe('600');

    const cfg = JSON.parse(readFileSync(handle.path, 'utf8'));
    const url = cfg.mcpServers?.papercusp?.url;
    expect(url).toBeTruthy();

    const u = new URL(url);
    expect(u.searchParams.has('sig')).toBe(true);
    expect(u.searchParams.has('exp')).toBe(true);

    // Hit operator — minted URL must get tools/list 200
    const targetUrl = `${baseUrl}/api/mcp?${u.searchParams.toString()}`;
    const r = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      signal: AbortSignal.timeout(15000),
    });
    const text = await r.text();
    expect(r.status).toBe(200);
    expect(text).toContain('"tools"');

    // Worker role must NOT invoke operator-only tool
    const r2 = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'autoloop:control', arguments: { op: 'resume' } } }),
      signal: AbortSignal.timeout(10000),
    });
    const text2 = await r2.text();
    expect(
      text2.includes('role_not_allowed') || text2.includes('not_allowed') || text2.includes('unknown_tool'),
    ).toBe(true);

    // Tamper: rewrite role=worker → role=operator — must get invalid_signature
    u.searchParams.set('role', 'operator');
    const tampUrl = `${baseUrl}/api/mcp?${u.searchParams.toString()}`;
    const r3 = await fetch(tampUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'autoloop:control', arguments: { op: 'resume' } } }),
      signal: AbortSignal.timeout(10000),
    });
    const text3 = await r3.text();
    expect(text3).toContain('request_rejected');
    expect(text3).toContain('invalid_signature');
  });
});
