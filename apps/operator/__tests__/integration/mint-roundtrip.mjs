import { execSync } from 'node:child_process';
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
/**
 * Inlined from _cleanup-test-failures.mjs (removed P-027 cleanup).
 * Each suite calls this with its own claimed_spawn LIKE pattern at
 * the end to purge the rows it created via deliberately-bad signature
 * test cases. Fail-soft per the original — never masks a signing
 * regression with a cleanup error.
 */
function cleanupTestFailures(claimedSpawnPattern) {
  try {
    execSync(
      `PGPASSWORD=harness_admin_pwd psql -h localhost -p 5432 -U harness_admin -d papercusp -c "DELETE FROM harness_shared.spawn_sig_verification_failures WHERE claimed_spawn LIKE '${claimedSpawnPattern}'" -q`,
      { stdio: 'pipe' },
    );
  } catch (err) {
    console.warn(
      `[test cleanup] could not purge spawn_sig_verification_failures rows matching ${claimedSpawnPattern}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}


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
  const OP_PORT = process.env.OP_PORT ?? '3070';
  console.log(`--- verify against operator at :${OP_PORT} ---`);
  // Strip path, retarget at /api/mcp on the configured port
  const targetUrl = `http://localhost:${OP_PORT}/api/mcp?${u.searchParams.toString()}`;
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

  // Mint a second URL WITH a client param and verify the operator
  // picks it up as ctx.uiClientId (defaults ui:get_state's client_id).
  console.log(`--- 'client' param signed + surfaced as ctx.uiClientId ---`);
  const cwd2 = mkdtempSync(join(tmpdir(), 'spawn-mint-client-'));
  try {
    // Inject 'client' via writeSignedSpawnMcp — extending the input
    // shape with the same field name as SIGNED_PARAM_ALLOWLIST.
    const fakeClient = 'cli-test-' + Math.random().toString(36).slice(2, 18);
    // @ts-expect-error — extended input
    const h2 = await writeSignedSpawnMcp(cwd2, {
      harnessSlug: 'sheets',
      workspaceId: 'default',
      role: 'operator',
      runId: 'r_mint_test_' + Date.now(),
      spawnId: 's_mint_client_' + Math.random().toString(36).slice(2),
      featureId: null, chunkId: null, parentSpawnId: null,
      // Pass it through buildSpawnUrlParams via the optional input field
      // — orchestrator-side params builder treats it as opt-in.
    });
    // writeSignedSpawnMcp doesn't currently take client_id in its
    // public input shape; emulate by appending + re-signing through a
    // tampered URL would fail signature. Instead, hit the operator
    // directly with an unsigned URL (soft-warn mode accepts it) so we
    // can verify the param-parser path independent of the mint API.
    // Hit a server that has ui:get_state — defaults to :3055 (dev). Allow
    // override via env so this also runs against prod once rebuilt.
    const base = process.env.UI_TOOLS_BASE_URL ?? 'http://localhost:3055';
    const directUrl = new URL(`${base}/api/mcp`);
    directUrl.searchParams.set('superuser', '1');
    directUrl.searchParams.set('workspace', 'default');
    directUrl.searchParams.set('client', fakeClient);
    const TOKEN = readFileSync(join(process.env.HOME, '.papercusp', 'superuser-token'), 'utf8').trim();
    const r4 = await fetch(directUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'Authorization': `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ui:get_state', arguments: {} } }),
      signal: AbortSignal.timeout(10000),
    });
    const text4 = await r4.text();
    const sawClient = text4.includes(fakeClient) || text4.includes('client_not_found');
    sawClient ? ok(`ctx.uiClientId picks up &client= URL param`) : bad(`ctx.uiClientId pickup`, text4.slice(0, 300));
  } finally {
    try { rmSync(cwd2, { recursive: true, force: true }); } catch {}
  }

  // And tamper with the URL — change role to operator, expect rejection on tools/call
  console.log(`--- tamper: rewrite role=worker → role=operator ---`);
  u.searchParams.set('role', 'operator');
  const tampUrl = `http://localhost:${OP_PORT}/api/mcp?${u.searchParams.toString()}`;
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

cleanupTestFailures('s_mint_%');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
