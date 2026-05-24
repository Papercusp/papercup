#!/usr/bin/env node
/**
 * End-to-end HMAC test against the live operator at :3070 / :3055.
 * Reads the signing key from PG, builds signed URLs, exercises every
 * failure mode through the actual HTTP boundary.
 *
 * No tsx, no operator imports — only crypto + http + psql shell-out.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { execSync } from 'node:child_process';
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


const OP_HOST = process.env.OP_HOST || 'localhost';
const OP_PORT = process.env.OP_PORT || '3070';
const BASE = `http://${OP_HOST}:${OP_PORT}`;

let pass = 0, fail = 0;
const log = (s) => console.log(s);
function ok(name) { log(`  ✓ ${name}`); pass++; }
function bad(name, detail = '') { log(`  ✗ ${name}  ${detail}`); fail++; }
function check(name, cond, detail = '') { cond ? ok(name) : bad(name, detail); }

function pgKey() {
  const out = execSync(
    `PGPASSWORD=harness_admin_pwd psql -h localhost -p 5432 -U harness_admin -d papercusp -tAc "SELECT value_b64 FROM harness_shared.operator_secrets WHERE name='spawn-signing-key';"`,
    { encoding: 'utf8' }
  ).trim();
  return Buffer.from(out, 'base64');
}

const SIGNED = new Set(['harness','workspace','role','run','spawn','feature','chunk','parent_spawn','exp']);
function canonical(params) {
  const seen = new Set();
  const pairs = [];
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
function sign(params, key, ttlSec = 24*3600, nowMs = Date.now()) {
  params.delete('sig');
  params.set('exp', String(Math.floor(nowMs/1000) + ttlSec));
  const sig = createHmac('sha256', key).update(canonical(params)).digest('base64url');
  params.set('sig', sig);
  return sig;
}

function freshParams(overrides = {}) {
  const p = new URLSearchParams();
  p.set('harness', overrides.harness || 'sheets');
  p.set('workspace', overrides.workspace || 'default');
  p.set('role', overrides.role || 'worker');
  p.set('run', 'r_test_' + Date.now());
  p.set('spawn', 's_test_' + randomBytes(4).toString('hex'));
  return p;
}

async function mcp(params, payload) {
  const url = `${BASE}/api/mcp?${params.toString()}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  const text = await r.text();
  return { status: r.status, text };
}

const listToolsPayload = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
const probePayload = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'agent_tools:list', arguments: {} } };

// ============ tests ============
async function main() {
  const key = pgKey();
  log(`Key loaded from PG (${key.length} bytes), targeting ${BASE}`);

  // Sanity: operator alive?
  try {
    const ping = await fetch(BASE, { signal: AbortSignal.timeout(5000) });
    check('operator reachable', ping.status < 500, `status=${ping.status}`);
  } catch (e) {
    bad('operator reachable', String(e));
    process.exit(1);
  }

  // 1. happy path: signed worker URL → tools/list returns role-filtered set
  log('\n--- 1. happy path: signed worker URL ---');
  const p1 = freshParams();
  sign(p1, key);
  const r1 = await mcp(p1, listToolsPayload);
  check('signed worker URL → 200', r1.status === 200, `status=${r1.status}`);
  check('tools/list returns array', r1.text.includes('"tools"'), r1.text.slice(0, 200));
  // Worker should NOT see operator-only tool autoloop:control
  const hasOperatorOnly1 = r1.text.includes('"autoloop:control"');
  check('worker excludes autoloop:control', !hasOperatorOnly1, hasOperatorOnly1 ? 'unexpectedly included' : '');

  // 2. tampered role rejected via tools/call (tools/list is lenient by design)
  log('\n--- 2. tampered role on tools/call ---');
  const p2 = freshParams({ role: 'worker' });
  sign(p2, key);
  p2.set('role', 'operator'); // forge upward
  const r2 = await mcp(p2, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'autoloop:control', arguments: { op: 'resume' } } });
  const tamperedRejected = r2.text.includes('request_rejected') && r2.text.includes('invalid_signature');
  check('tampered URL rejected on tools/call', tamperedRejected, r2.text.slice(0, 300));

  // 3. unsigned URL: soft-warn passes (today)
  log('\n--- 3. unsigned URL with claimed context: tools/list returns empty in strict mode ---');
  const p3 = freshParams();
  const r3 = await mcp(p3, listToolsPayload);
  // freshParams() sets role/workspace/spawn (claims a spawn context).
  // In strict mode tools/list returns 200 with an empty tools array
  // so the bridge stays valid for the agent, but doesn't leak the
  // claimed-role catalog. See route.ts ListToolsRequestSchema handler.
  const r3body = r3.text.match(/"tools":\s*(\[[^\]]*\])/);
  check(
    'unsigned + claimed context → empty tool list (strict)',
    r3.status === 200 && r3body && r3body[1] === '[]',
    `status=${r3.status} body=${r3.text.slice(0,200)}`,
  );

  log('\n--- 3b. bare /api/mcp (no claim) still returns full catalog ---');
  const r3b = await fetch(`${BASE}/api/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify(listToolsPayload),
  });
  const r3btext = await r3b.text();
  check(
    'bare /api/mcp → tools present (no claim = no escalation attempt)',
    r3b.status === 200 && /"tools":\s*\[\s*\{/.test(r3btext),
    `status=${r3b.status} body=${r3btext.slice(0,200)}`,
  );

  // 4. expired sig rejected on tools/call
  log('\n--- 4. expired sig on tools/call ---');
  const p4 = freshParams({ role: 'operator' });
  sign(p4, key, -10);
  const r4 = await mcp(p4, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'autoloop:control', arguments: { op: 'resume' } } });
  const expRejected = r4.text.includes('request_rejected') && r4.text.includes('expired');
  check('expired sig rejected on tools/call', expRejected, r4.text.slice(0, 300));

  // 5. role bake-in: signed role=worker can NOT call operator-only tool
  log('\n--- 5. worker calling operator-only autoloop:control ---');
  const p5 = freshParams({ role: 'worker' });
  sign(p5, key);
  const r5 = await mcp(p5, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'autoloop:control', arguments: { op: 'resume' } } });
  const denied5 = r5.text.includes('role_not_allowed') || r5.text.includes('not_allowed') || r5.text.includes('unknown_tool');
  check('worker → autoloop:control denied', denied5, r5.text.slice(0, 300));

  // 6. operator role signed URL → operator-only tool OK
  log('\n--- 6. operator role signed URL → autoloop:control ---');
  const p6 = freshParams({ role: 'operator' });
  sign(p6, key);
  const r6 = await mcp(p6, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'autoloop:control', arguments: { op: 'resume' } } });
  check('operator → autoloop:control OK', r6.status === 200 && (r6.text.includes('"result"') || r6.text.includes('"ok":true')), r6.text.slice(0, 300));

  // 7. agent_tools:list reflects role — JSON is escaped inside MCP content envelope
  log('\n--- 7. agent_tools:list role-filtered allowed flags ---');
  const p7 = freshParams({ role: 'worker' });
  sign(p7, key);
  const r7 = await mcp(p7, probePayload);
  const okJson = r7.text.includes('\\"callerRole\\":\\"worker\\"') && r7.text.includes('\\"isSuperuser\\":false');
  check('agent_tools:list reports worker, non-superuser', okJson, r7.text.slice(0, 350));
  // With onlyAllowed:false, autoloop:control should appear with allowed:false
  const p7b = freshParams({ role: 'worker' });
  sign(p7b, key);
  const r7b = await mcp(p7b, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'agent_tools:list', arguments: { onlyAllowed: false, filter: 'autoloop:control' } } });
  // rolesQuota is an inline object with braces — use a non-greedy any-char match
  const acRowMatch = r7b.text.match(/\\"name\\":\\"autoloop:control\\"[\s\S]*?\\"allowed\\":(true|false)/);
  check('worker sees autoloop:control as allowed:false', acRowMatch && acRowMatch[1] === 'false', acRowMatch ? `allowed=${acRowMatch[1]}` : r7b.text.slice(0, 600));

  // 8. audit table receives invalid_signature entry (read before/after)
  log('\n--- 8. audit row written on tampered sig ---');
  const before = Number(execSync(`PGPASSWORD=harness_admin_pwd psql -h localhost -p 5432 -U harness_admin -d papercusp -tAc "SELECT count(*) FROM harness_shared.spawn_sig_verification_failures WHERE reason='invalid_signature';"`, { encoding: 'utf8' }).trim());
  const p8 = freshParams();
  sign(p8, key);
  p8.set('role', 'operator');
  await mcp(p8, listToolsPayload);
  // Allow a moment for the async audit insert.
  await new Promise(r => setTimeout(r, 500));
  const after = Number(execSync(`PGPASSWORD=harness_admin_pwd psql -h localhost -p 5432 -U harness_admin -d papercusp -tAc "SELECT count(*) FROM harness_shared.spawn_sig_verification_failures WHERE reason='invalid_signature';"`, { encoding: 'utf8' }).trim());
  check('audit row written for tampered sig', after === before + 1, `before=${before} after=${after}`);

  cleanupTestFailures('s_test_%');

  log(`\nResult: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
