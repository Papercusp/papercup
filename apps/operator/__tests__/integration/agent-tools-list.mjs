#!/usr/bin/env node
/**
 * Regression suite for agent_tools:list — discovery + permission shape.
 *
 * Verifies:
 *   1. callerRole and isSuperuser reflect the spawn ctx
 *   2. superuser sees every MCP-projected tool as allowed (cap-gate
 *      mirrors dispatcher's `!ctx.isSuperuser` skip)
 *   3. asRole=<X> overrides role + drops superuser bypass + drops
 *      principal — so the result matches what a real role=X spawn
 *      would actually be able to call
 *   4. role_not_allowed and missing_capability reasons surface
 *      correctly with onlyAllowed=false
 *   5. filter regex narrows results
 *   6. limit is honored
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// OP_PORT takes priority over OPERATOR_BASE_URL so a single env var
// (`OP_PORT=3055`) flips the whole test battery between dev/prod.
const OP_PORT = process.env.OP_PORT ?? null;
const BASE = OP_PORT
  ? `http://localhost:${OP_PORT}`
  : (process.env.OPERATOR_BASE_URL ?? 'http://localhost:3070');
const TOKEN = readFileSync(join(homedir(), '.papercusp', 'superuser-token'), 'utf8').trim();

let pass = 0, fail = 0;

async function call(name, args = {}, urlSuffix = '?superuser=1&workspace=default') {
  const r = await fetch(`${BASE}/api/mcp${urlSuffix}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Accept': 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await r.text();
  // The /api/mcp transport is SSE; parse the single data: frame.
  const dataLine = body.split('\n').find((l) => l.startsWith('data:'));
  if (!dataLine) throw new Error(`no data frame: ${body.slice(0, 300)}`);
  const env = JSON.parse(dataLine.slice('data:'.length).trim());
  const text = env.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : env;
}

function check(name, cond) {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}`); fail++; }
}

console.log('--- 1. callerRole + isSuperuser reflect ctx ---');
const su = await call('agent_tools:list');
check('callerRole is operator', su.callerRole === 'operator');
check('isSuperuser is true', su.isSuperuser === true);

console.log('--- 2. superuser sees every tool allowed ---');
check('count > 100', su.count > 100);
check('all tools have allowed=true', su.tools.every((t) => t.allowed === true));
check('every tool has shape fields', su.tools.every((t) =>
  typeof t.name === 'string' &&
  typeof t.description === 'string' &&
  (t.roles === null || Array.isArray(t.roles)) &&
  typeof t.allowed === 'boolean'));

console.log('--- 3. asRole=worker reduces surface + drops bypass ---');
const worker = await call('agent_tools:list', { asRole: 'worker' });
check('callerRole is worker', worker.callerRole === 'worker');
check('isSuperuser is false', worker.isSuperuser === false);
check('worker count < superuser count', worker.count < su.count);
check('worker count > 50 (sanity)', worker.count > 50);

console.log('--- 4. asRole=worker, onlyAllowed=false, filter=autoloop ---');
const w2 = await call('agent_tools:list', { asRole: 'worker', onlyAllowed: false, filter: 'autoloop' });
check('returns autoloop:status', w2.tools.some((t) => t.name === 'autoloop:status'));
check('returns autoloop:control', w2.tools.some((t) => t.name === 'autoloop:control'));
const status = w2.tools.find((t) => t.name === 'autoloop:status');
const control = w2.tools.find((t) => t.name === 'autoloop:control');
check('autoloop:status allowed for worker (no principal, role ok)', status.allowed === true);
check('autoloop:control NOT allowed for worker', control.allowed === false);
check('control reason is role_not_allowed', control.reason?.startsWith('role_not_allowed'));

console.log('--- 5. filter narrows ---');
const har = await call('agent_tools:list', { filter: 'harness:' });
check('all returned tools match filter', har.tools.every((t) => /harness:/i.test(t.name)));
check('harness filter returns >5 tools', har.count > 5);

console.log('--- 6. limit honored ---');
const lim = await call('agent_tools:list', { limit: 7 });
check('count == limit', lim.count === 7);
check('tools.length == limit', lim.tools.length === 7);

console.log('--- 7. invalid asRole still works (just returns 0 if no role-tools match) ---');
const fake = await call('agent_tools:list', { asRole: 'nonexistent-role-xyz', onlyAllowed: false, limit: 5 });
check('returns shape even with unknown role', typeof fake.count === 'number');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
