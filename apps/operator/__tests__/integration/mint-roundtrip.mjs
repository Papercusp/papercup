#!/usr/bin/env node
/**
 * End-to-end mint+verify roundtrip:
 *   1. Use libs/papercusp's writeSignedSpawnMcp to write a .mcp.json
 *   2. Read the .mcp.json from disk
 *   3. Extract the URL, hit the operator, confirm it verifies
 *
 * This proves the minting side (libs/papercusp) and the verification
 * side (apps/operator) speak the same HMAC dialect through the same
 * PG-stored key.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Use bun's TS import — libs/papercusp is in the workspace
const { writeSignedSpawnMcp } = await import(
  '/home/marsh-office/papercupai-workspace/papercup/libs/papercusp/packages/orchestrator/src/spawn-mcp.ts'
);

process.env.DATABASE_URL ||= 'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp';

const cwd = mkdtempSync(join(tmpdir(), 'spawn-mint-'));
let pass = 0, fail = 0;
const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };
const bad = (n, d='') => { console.log(`  ✗ ${n}  ${d}`); fail++; };

try {
  console.log(`--- mint .mcp.json in ${cwd} ---`);
  const handle = await writeSignedSpawnMcp(cwd, {
    harnessSlug: 'sheets',
    workspaceId: 'default',
    role: 'worker',
    runId: 'r_mint_test_' + Date.now(),
    spawnId: 's_mint_' + Math.random().toString(36).slice(2),
    featureId: null,
    chunkId: null,
    parentSpawnId: null,
  });
  ok(`writeSignedSpawnMcp returned (path=${handle.path})`);

  const st = statSync(handle.path);
  const mode = (st.mode & 0o777).toString(8);
  (mode === '600') ? ok(`.mcp.json mode 0600`) : bad(`.mcp.json mode`, `got ${mode}`);

  const cfg = JSON.parse(readFileSync(handle.path, 'utf8'));
  const url = cfg.mcpServers?.papercusp?.url;
  ok(`url present: ${url ? url.slice(0, 80) + '...' : '(missing)'}`);

  const u = new URL(url);
  const hasSig = u.searchParams.has('sig');
  const hasExp = u.searchParams.has('exp');
  (hasSig && hasExp) ? ok(`url has sig+exp`) : bad(`url has sig+exp`, `sig=${hasSig} exp=${hasExp}`);

  // Now hit the operator using this URL with tools/list (most permissive)
  console.log(`--- verify against operator at :3070 ---`);
  // Strip path, retarget at /api/mcp on 3070
  const targetUrl = `http://localhost:3070/api/mcp?${u.searchParams.toString()}`;
  const r = await fetch(targetUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  const hasTools = text.includes('"tools"') && r.status === 200;
  hasTools ? ok(`minted URL → tools/list 200`) : bad(`minted URL → tools/list`, `status=${r.status} body=${text.slice(0, 200)}`);

  // And invoke an operator-only tool (should be DENIED — worker role)
  console.log(`--- worker role baked in: autoloop:control should be denied ---`);
  const r2 = await fetch(targetUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'autoloop:control', arguments: { op: 'resume' } } }),
    signal: AbortSignal.timeout(10000),
  });
  const text2 = await r2.text();
  const denied = text2.includes('role_not_allowed') || text2.includes('not_allowed') || text2.includes('unknown_tool');
  denied ? ok(`minted worker URL cannot invoke autoloop:control`) : bad(`role gate`, text2.slice(0, 300));

  // And tamper with the URL — change role to operator, expect rejection on tools/call
  console.log(`--- tamper: rewrite role=worker → role=operator ---`);
  u.searchParams.set('role', 'operator');
  const tampUrl = `http://localhost:3070/api/mcp?${u.searchParams.toString()}`;
  const r3 = await fetch(tampUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'autoloop:control', arguments: { op: 'resume' } } }),
    signal: AbortSignal.timeout(10000),
  });
  const text3 = await r3.text();
  const rejected = text3.includes('request_rejected') && text3.includes('invalid_signature');
  rejected ? ok(`tampered minted URL rejected with invalid_signature`) : bad(`tamper rejection`, text3.slice(0, 300));

} finally {
  try { rmSync(cwd, { recursive: true, force: true }); } catch {}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
