#!/usr/bin/env node
/**
 * End-to-end regression suite for the workspace-power-user auth tier
 * and the @papercusp/omp bundle surface (P-001 / P-002 / P-004 of
 * docs/plans/omp-power-user-bundle-2026-05-20.md).
 *
 * Verifies, against a running operator:
 *   1. POST /api/agent-tokens/power-user issues an access + refresh
 *      token pair with the expected claims.
 *   2. POST .../refresh mints a fresh access token from the refresh
 *      token; an access token presented as a refresh token is
 *      rejected 401 (type confusion).
 *   3. GET /api/agent-bundle returns the playbook + origin-derived
 *      mcp_url with a valid token; 401 without one.
 *   4. POST /api/mcp?power_user=1 tools/list returns the operator-tier
 *      catalog with a valid token, and an empty list with a bad token.
 *   5. POST /api/agent-mcp/console/launch {mode:'omp'} returns a
 *      structured result (ok, or omp_not_installed with an install
 *      command).
 *
 * Run against a dev operator that has this code compiled:
 *   OP_PORT=3167 node __tests__/integration/power-user-e2e.mjs
 */

// OP_PORT takes priority over OPERATOR_BASE_URL so a single env var
// flips the battery between dev/prod — same convention as the sibling
// integration tests.
const OP_PORT = process.env.OP_PORT ?? null;
const BASE = OP_PORT
  ? `http://localhost:${OP_PORT}`
  : (process.env.OPERATOR_BASE_URL ?? 'http://localhost:3070');

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
    pass++;
  } else {
    console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`);
    fail++;
  }
}

async function jsonPost(path, body, headers = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* leave json null */
  }
  return { status: r.status, json, text };
}

/** POST a JSON-RPC frame to the MCP transport; parse the SSE data line. */
async function mcpCall(urlSuffix, bearer, method, params = {}) {
  const r = await fetch(`${BASE}/api/mcp${urlSuffix}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearer}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await r.text();
  const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
  if (!dataLine) throw new Error(`no SSE data frame: ${text.slice(0, 200)}`);
  return JSON.parse(dataLine.slice('data:'.length).trim());
}

async function main() {
  console.log(`--- power-user e2e against ${BASE} ---`);

  // 1. Issue tokens.
  console.log('--- 1. POST /api/agent-tokens/power-user ---');
  const issue = await jsonPost('/api/agent-tokens/power-user', {});
  check('issue returns 200', issue.status === 200, `status ${issue.status}`);
  const access = issue.json?.access_token;
  const refresh = issue.json?.refresh_token;
  check('access_token present', typeof access === 'string' && access.length > 0);
  check('refresh_token present', typeof refresh === 'string' && refresh.length > 0);
  check('workspace_id present', typeof issue.json?.workspace_id === 'string');
  check('auth_session_id is pus-prefixed', /^pus-/.test(issue.json?.auth_session_id ?? ''));
  check(
    'access expiry before refresh expiry',
    Date.parse(issue.json?.access_expires_at) < Date.parse(issue.json?.refresh_expires_at),
  );
  if (!access || !refresh) {
    console.log(`\n${pass} passed, ${fail} failed (aborting — no tokens)`);
    process.exit(1);
  }

  // 2. Refresh.
  console.log('--- 2. POST .../refresh ---');
  const refreshed = await jsonPost(
    '/api/agent-tokens/power-user/refresh',
    undefined,
    { Authorization: `Bearer ${refresh}` },
  );
  check('refresh returns 200', refreshed.status === 200, `status ${refreshed.status}`);
  check('refresh yields a new access token', typeof refreshed.json?.access_token === 'string');

  const wrongType = await jsonPost(
    '/api/agent-tokens/power-user/refresh',
    undefined,
    { Authorization: `Bearer ${access}` },
  );
  check('access token rejected as refresh token (401)', wrongType.status === 401);

  // 3. Bundle.
  console.log('--- 3. GET /api/agent-bundle ---');
  const bundleRes = await fetch(`${BASE}/api/agent-bundle`, {
    headers: { Authorization: `Bearer ${access}` },
  });
  const bundle = await bundleRes.json().catch(() => null);
  check('bundle returns 200', bundleRes.status === 200, `status ${bundleRes.status}`);
  check('bundle.toolsmd is non-empty', (bundle?.toolsmd?.length ?? 0) > 100);
  check('bundle.mcp_url carries ?power_user=1', /[?&]power_user=1/.test(bundle?.mcp_url ?? ''));
  check('bundle.mcp_url carries no token', !/token=/.test(bundle?.mcp_url ?? ''));
  check('bundle.skills is an array', Array.isArray(bundle?.skills));
  check('bundle.hooks is an array', Array.isArray(bundle?.hooks));

  const noTok = await fetch(`${BASE}/api/agent-bundle`);
  check('bundle without token is 401', noTok.status === 401);

  // 4. MCP ?power_user=1.
  console.log('--- 4. POST /api/mcp?power_user=1 tools/list ---');
  const good = await mcpCall('?power_user=1', access, 'tools/list');
  const goodTools = good?.result?.tools ?? [];
  check('valid token returns a non-empty tool catalog', goodTools.length > 0, `${goodTools.length} tools`);

  const bad = await mcpCall('?power_user=1', 'garbage.token', 'tools/list');
  const badTools = bad?.result?.tools ?? [];
  check('garbage token returns an empty tool list', badTools.length === 0);

  // 5. console/launch omp mode.
  console.log('--- 5. POST /api/agent-mcp/console/launch {mode:omp} ---');
  const launch = await fetch(`${BASE}/api/agent-mcp/console/launch`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ mode: 'omp' }),
  });
  const launchJson = await launch.json().catch(() => null);
  const okOrNotInstalled =
    launchJson?.status === 'ok' || launchJson?.code === 'omp_not_installed';
  check(
    'omp launch returns a structured result (ok | omp_not_installed)',
    okOrNotInstalled,
    JSON.stringify(launchJson)?.slice(0, 120),
  );
  if (launchJson?.code === 'omp_not_installed') {
    check('omp_not_installed carries an install command', typeof launchJson.installCmd === 'string');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`fatal: ${err?.stack ?? err}`);
  process.exit(1);
});
