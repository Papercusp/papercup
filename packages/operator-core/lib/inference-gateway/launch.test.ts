/** Hermetic composition smoke for the gateway service (P-013) — injected account + resolver. */
import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGatewayService, resolvePriorityTiers, type RunningGatewayService } from './launch';
// The RETIRED per-account multiplier, imported rather than spelled `4`: if the constant
// is ever deleted with the last of the formula, this file stops compiling instead of
// silently asserting against a stale literal.
import { CODEX_ADMISSION_SLOTS_PER_ACCOUNT } from './gateway';

let upstream: http.Server | undefined;
let svc: RunningGatewayService | undefined;
let tempDir: string | undefined;

afterEach(async () => {
  await svc?.stop();
  svc = undefined;
  await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
  upstream = undefined;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
  delete process.env.OPENAI_BASE_URL_UPSTREAM;
});

async function startUpstream(): Promise<{ base: string; lastAuth: () => string | undefined }> {
  let lastAuth: string | undefined;
  upstream = http.createServer((req, res) => {
    lastAuth = req.headers['authorization'] as string | undefined;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => upstream!.listen(0, '127.0.0.1', () => r()));
  const port = (upstream!.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, lastAuth: () => lastAuth };
}

test('startGatewayService composes account → resolver → proxy; /healthz + a proxied request work', async () => {
  const up = await startUpstream();
  svc = await startGatewayService({
    port: 0,
    upstreamBase: up.base,
    log: () => {},
    resolveAccount: async () => ({ accountId: 'test-acct', credentialRef: 'token:/dev/null', source: 'env' }),
    makeResolver: () => ({ kind: 'token', current: async () => 'bound-token', invalidate: () => {} }),
    observePool: () => () => {},
  });

  const health = await fetch(`http://127.0.0.1:${svc.port}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(((await health.json()) as { accountId: string }).accountId, 'test-acct');

  const res = await fetch(`http://127.0.0.1:${svc.port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-4', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 200);
  assert.equal(up.lastAuth(), 'Bearer bound-token', 'gateway injected the bound account token');
});

test('startGatewayService sizes Claude and Codex priority tiers from their own concurrency caps', async () => {
  const flagEnv = 'PAPERCUSP_FLAG_PAPERCUSP_GATEWAY_PRIORITY_TIERS';
  const previousFlag = process.env[flagEnv];
  process.env[flagEnv] = '1';
  try {
    const up = await startUpstream();
    const claudeDb = [{ accountId: 'claude-main', credentialRef: 'token:/claude', source: 'pool' as const }];
    const codexDb = [{ accountId: 'codex-main', credentialRef: 'token:/codex', source: 'pool' as const }];
    const logs: string[] = [];
    svc = await startGatewayService({
      port: 0,
      upstreamBase: up.base,
      log: (_level, message) => logs.push(message),
      resolveAccounts: async (_ws, provider) => (provider === 'codex' ? codexDb : claudeDb),
      makeResolver: (_ref, id) => ({ kind: 'token', current: async () => `${id}-tok`, invalidate: () => {} }),
      // An EXPLICIT operator cap stays authoritative under D-006, and it is what makes
      // "sized from its OWN pool" observable at all: with no override both lanes now
      // resolve to the same 24, so a one-account fixture could no longer tell a
      // Codex-sized reserve apart from Claude's. 8 slots ⇒ ceil(8 * 0.15) = 2 ≠ 4.
      codexConcurrency: 8,
      observePool: () => () => {},
      poolReloadIntervalMs: 0,
    });

    const stats = (await (await fetch(`http://127.0.0.1:${svc.port}/stats`)).json()) as {
      concurrencyCap: number;
      codexAdmission: { maxConcurrent: number; tier1Reserve?: number };
      codexAimd: { cap: number; floor: number };
    };
    assert.equal(stats.concurrencyCap, 24, 'Claude keeps the gateway concurrency cap it was configured with');
    assert.equal(stats.codexAdmission.maxConcurrent, 8, 'the explicit Codex cap sizes its own admission pool');
    assert.equal(stats.codexAdmission.tier1Reserve, 2, 'Codex reserve is ceil(8 * 0.15), not Claude\'s reserve');
    assert.equal(stats.codexAimd.cap, 8, 'Codex AIMD cap follows its own admission cap, not Claude\'s');
    assert.equal(stats.codexAimd.floor, 4, 'the default AIMD floor already sits below an 8-slot cap');
    assert.ok(logs.some((message) => message.includes('Claude priority-tier admission ON — reserve=4')), 'launch resolves Claude tiers for 24 slots');
    assert.ok(logs.some((message) => message.includes('Codex priority-tier admission ON — reserve=2')), 'launch resolves Codex tiers for 8 slots');
  } finally {
    if (previousFlag === undefined) delete process.env[flagEnv];
    else process.env[flagEnv] = previousFlag;
  }
});

test('one Codex account does NOT multiply into a four-slot admission cap (D-006)', async () => {
  // The falsifier for capless-inference-gateway-2026-08-28 D-006 ("serviceability
  // informs attribution, not an admission formula"). `accountScaledCodexConcurrency`
  // used to return accounts * CODEX_ADMISSION_SLOTS_PER_ACCOUNT (1 * 4 = 4); it now
  // returns the configured Claude cap and the controller learns the real window from
  // outcomes. ONE account is the only fixture that separates the two — seven accounts
  // read 24 under both rules (28 clamped, vs. the cap itself), which is why the
  // sibling multi-account case below cannot catch a reinstated multiplication.
  const up = await startUpstream();
  const claudeDb = [{ accountId: 'claude-main', credentialRef: 'token:/claude', source: 'pool' as const }];
  const codexDb = [{ accountId: 'codex-main', credentialRef: 'token:/codex', source: 'pool' as const }];
  svc = await startGatewayService({
    port: 0,
    upstreamBase: up.base,
    log: () => {},
    resolveAccounts: async (_ws, provider) => (provider === 'codex' ? codexDb : claudeDb),
    makeResolver: (_ref, id) => ({ kind: 'token', current: async () => `${id}-tok`, invalidate: () => {} }),
    observePool: () => () => {},
    poolReloadIntervalMs: 0,
  });
  const stats = (await (await fetch(`http://127.0.0.1:${svc.port}/stats`)).json()) as {
    concurrencyCap: number;
    codexAdmission: { maxConcurrent: number };
    codexAimd: { cap: number };
  };
  assert.equal(stats.codexAdmission.maxConcurrent, 24, 'account count is attribution evidence, not an admission formula');
  assert.equal(stats.codexAdmission.maxConcurrent, stats.concurrencyCap, 'the unoverridden Codex seed is the configured cap itself');
  assert.equal(stats.codexAimd.cap, 24, 'the Codex AIMD ceiling follows that seed');
  assert.notEqual(stats.codexAdmission.maxConcurrent, CODEX_ADMISSION_SLOTS_PER_ACCOUNT, 'the retired slots-per-account product must not come back');
});

test('startGatewayService seeds Codex admission from the configured cap and preserves explicit overrides', async () => {
  const up = await startUpstream();
  const claudeDb = [{ accountId: 'claude-main', credentialRef: 'token:/claude', source: 'pool' as const }];
  const codexDb = Array.from({ length: 7 }, (_, i) => ({
    accountId: `codex-${i}`,
    credentialRef: `token:/codex-${i}`,
    source: 'pool' as const,
  }));
  const resolveAccounts = async (_ws: string | undefined, provider: 'claude' | 'codex' = 'claude') =>
    provider === 'codex' ? codexDb : claudeDb;
  svc = await startGatewayService({
    port: 0,
    upstreamBase: up.base,
    log: () => {},
    resolveAccounts,
    makeResolver: (_ref, id) => ({ kind: 'token', current: async () => `${id}-tok`, invalidate: () => {} }),
    observePool: () => () => {},
    poolReloadIntervalMs: 0,
  });
  const scaled = (await (await fetch(`http://127.0.0.1:${svc.port}/stats`)).json()) as {
    codexAdmission: { maxConcurrent: number };
    codexAimd: { cap: number; floor: number };
  };
  // D-006: the account COUNT is deliberately not an input here — seven accounts seed the
  // same 24 that one does. (This case therefore cannot detect a reinstated multiplication;
  // the single-account case above is the falsifier for that.)
  assert.equal(scaled.codexAdmission.maxConcurrent, 24, 'the seed is the configured cap, whatever the account count');
  assert.equal(scaled.codexAimd.cap, 24);
  assert.equal(scaled.codexAimd.floor, 4, 'the default AIMD floor is already below the 24-slot cap');

  await svc.stop();
  svc = await startGatewayService({
    port: 0,
    upstreamBase: up.base,
    log: () => {},
    resolveAccounts,
    codexConcurrency: 2,
    makeResolver: (_ref, id) => ({ kind: 'token', current: async () => `${id}-tok`, invalidate: () => {} }),
    observePool: () => () => {},
    poolReloadIntervalMs: 0,
  });
  const overridden = (await (await fetch(`http://127.0.0.1:${svc.port}/stats`)).json()) as {
    codexAdmission: { maxConcurrent: number };
    codexAimd: { cap: number; floor: number };
  };
  assert.equal(overridden.codexAdmission.maxConcurrent, 2, 'an explicit Codex cap remains authoritative');
  assert.equal(overridden.codexAimd.cap, 2);
  assert.equal(overridden.codexAimd.floor, 1, 'an explicit cap of two still receives an adaptable floor');
});

test('reloadPool HOT-SWAPS the account pool from the DB source-of-truth, no restart (B-HOT-1)', async () => {
  const up = await startUpstream();
  // The "DB" the gateway re-resolves on reload: starts [a, b], later flips to [a, c, d].
  let dbPool = [
    { accountId: 'a', credentialRef: 'token:/a', source: 'pool' as const },
    { accountId: 'b', credentialRef: 'token:/b', source: 'pool' as const },
  ];
  svc = await startGatewayService({
    port: 0,
    upstreamBase: up.base,
    log: () => {},
    resolveAccounts: async () => dbPool,
    makeResolver: (_ref, id) => ({ kind: 'token', current: async () => `${id}-tok`, invalidate: () => {} }),
    observePool: () => () => {},
    poolReloadIntervalMs: 0, // disable the auto-poll; drive reloadPool() deterministically
  });

  assert.equal(svc.configVersion(), 1);
  // No DB change → reload is a no-op (same signature), version unchanged.
  const noop = await svc.reloadPool();
  assert.equal(noop.changed, false, 'an unchanged pool does not swap');
  assert.equal(svc.configVersion(), 1, 'version unchanged on a no-op reload');

  // The DB pool changes: 'b' removed, 'c' + 'd' added.
  dbPool = [
    { accountId: 'a', credentialRef: 'token:/a', source: 'pool' as const },
    { accountId: 'c', credentialRef: 'token:/c', source: 'pool' as const },
    { accountId: 'd', credentialRef: 'token:/d', source: 'pool' as const },
  ];
  const changed = await svc.reloadPool();
  assert.equal(changed.changed, true, 'a real DB change hot-reloads');
  assert.equal(svc.configVersion(), 2, 'config version bumped on a real swap');
  assert.deepEqual([...changed.accounts].sort(), ['a', 'c', 'd']);

  // PROOF the swap is LIVE with NO restart: pin a request to 'd' — an account that only exists AFTER the
  // reload — and assert its token reaches the upstream. (Impossible unless the live pool was swapped.)
  const res = await fetch(`http://127.0.0.1:${svc.port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-papercusp-account': 'd' },
    body: JSON.stringify({ model: 'claude-opus-4', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 200);
  assert.equal(up.lastAuth(), 'Bearer d-tok', 'a hot-reload-ADDED account serves live — pool swapped without a restart');
});

test('/admin/config + /admin/reload expose the live config + on-demand hot-reload (B-HOT-2)', async () => {
  const up = await startUpstream();
  let dbPool = [
    { accountId: 'a', credentialRef: 'token:/a', source: 'pool' as const },
    { accountId: 'b', credentialRef: 'token:/b', source: 'pool' as const },
  ];
  svc = await startGatewayService({
    port: 0,
    upstreamBase: up.base,
    log: () => {},
    resolveAccounts: async () => dbPool,
    makeResolver: (_ref, id) => ({ kind: 'token', current: async () => `${id}-tok`, invalidate: () => {} }),
    observePool: () => () => {},
    poolReloadIntervalMs: 0,
  });
  const base = `http://127.0.0.1:${svc.port}`;

  // GET /admin/config reflects the live pool.
  const c1 = (await (await fetch(`${base}/admin/config`)).json()) as { version: number; accounts: string[] };
  assert.equal(c1.version, 1);
  assert.deepEqual([...c1.accounts].sort(), ['a', 'b']);

  // Change the DB pool, then trigger an ON-DEMAND reload over HTTP.
  dbPool = [
    { accountId: 'a', credentialRef: 'token:/a', source: 'pool' as const },
    { accountId: 'c', credentialRef: 'token:/c', source: 'pool' as const },
  ];
  const r = await fetch(`${base}/admin/reload`, { method: 'POST' });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { ok: boolean; changed: boolean; version: number; accounts: string[] };
  assert.equal(body.ok, true);
  assert.equal(body.changed, true);
  assert.equal(body.version, 2);
  assert.deepEqual([...body.accounts].sort(), ['a', 'c']);

  // GET /admin/config now reflects the reloaded pool — no restart.
  const c2 = (await (await fetch(`${base}/admin/config`)).json()) as { version: number; accounts: string[] };
  assert.equal(c2.version, 2);
  assert.deepEqual([...c2.accounts].sort(), ['a', 'c']);
});

test('Codex account pool can hot-reload from empty to live without a gateway restart', async () => {
  const up = await startUpstream();
  process.env.OPENAI_BASE_URL_UPSTREAM = up.base;
  tempDir = mkdtempSync(join(tmpdir(), 'codex-gw-token-'));
  const codexTokenPath = join(tempDir, 'codex-main.token');
  writeFileSync(codexTokenPath, 'codex-token\n', { mode: 0o600 });

  const claudeDb = [{ accountId: 'claude-main', credentialRef: 'token:/claude', source: 'pool' as const }];
  let codexDb: typeof claudeDb = [];
  svc = await startGatewayService({
    port: 0,
    upstreamBase: up.base,
    log: () => {},
    resolveAccounts: async (_ws, provider) => (provider === 'codex' ? codexDb : claudeDb),
    makeResolver: (_ref, id) => ({ kind: 'token', current: async () => `${id}-tok`, invalidate: () => {} }),
    observePool: () => () => {},
    poolReloadIntervalMs: 0,
  });
  const base = `http://127.0.0.1:${svc.port}`;

  const before = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4.1', input: 'hi' }),
  });
  assert.equal(before.status, 503);

  codexDb = [{ accountId: 'codex-main', credentialRef: `token:${codexTokenPath}`, source: 'pool' as const }];
  const changed = await svc.reloadPool();
  assert.equal(changed.changed, true);

  const after = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-papercusp-account': 'codex-main' },
    body: JSON.stringify({ model: 'gpt-4.1', input: 'hi' }),
  });
  assert.equal(after.status, 200);
  assert.equal(up.lastAuth(), 'Bearer codex-token');
});

test('two ChatGPT subscription accounts populate a real health pool and hot-reload without a restart', async () => {
  const up = await startUpstream();
  const claudeDb = [{ accountId: 'claude-main', credentialRef: 'token:/claude', source: 'pool' as const }];
  let codexDb = [
    { accountId: 'chatgpt-a', credentialRef: 'codex-cli:/tmp/chatgpt-a', source: 'pool' as const },
    { accountId: 'chatgpt-b', credentialRef: 'codex-cli:/tmp/chatgpt-b', source: 'pool' as const },
  ];
  svc = await startGatewayService({
    port: 0,
    upstreamBase: up.base,
    log: () => {},
    resolveAccounts: async (_ws, provider) => (provider === 'codex' ? codexDb : claudeDb),
    makeResolver: (_ref, id) => ({ kind: 'token', current: async () => `${id}-tok`, invalidate: () => {} }),
    observePool: () => () => {},
    poolReloadIntervalMs: 0,
  });
  const base = `http://127.0.0.1:${svc.port}`;
  const before = (await (await fetch(`${base}/stats`)).json()) as { codexHealthyAccounts: number };
  assert.equal(before.codexHealthyAccounts, 2, 'both ChatGPT accounts are live routing capacity, not an unverified list count');

  codexDb = [
    { accountId: 'chatgpt-b', credentialRef: 'codex-cli:/tmp/chatgpt-b', source: 'pool' as const },
    { accountId: 'chatgpt-c', credentialRef: 'codex-cli:/tmp/chatgpt-c', source: 'pool' as const },
  ];
  const changed = await svc.reloadPool();
  assert.equal(changed.changed, true);
  const after = (await (await fetch(`${base}/stats`)).json()) as { codexHealthyAccounts: number };
  assert.equal(after.codexHealthyAccounts, 2, 'the subscription pool swaps atomically and preserves healthy capacity');
});

// ── Backlog #7: launch.ts hot-reload + composition deeper edges (continuation; su-7f3e0376) ──

test('startGatewayService throws when the initial account pool resolves empty (fail-fast)', async () => {
  await assert.rejects(
    startGatewayService({
      port: 0,
      log: () => {},
      resolveAccounts: async () => [],
      makeResolver: (_ref, id) => ({ kind: 'token', current: async () => `${id}-tok`, invalidate: () => {} }),
      observePool: () => () => {},
    }),
    /no account resolved/,
  );
});

test('reloadPool keeps the live pool when the DB resolves EMPTY (fail-safe, no wipe)', async () => {
  const up = await startUpstream();
  let dbPool = [
    { accountId: 'a', credentialRef: 'token:/a', source: 'pool' as const },
    { accountId: 'b', credentialRef: 'token:/b', source: 'pool' as const },
  ];
  svc = await startGatewayService({
    port: 0,
    upstreamBase: up.base,
    log: () => {},
    resolveAccounts: async () => dbPool,
    makeResolver: (_ref, id) => ({ kind: 'token', current: async () => `${id}-tok`, invalidate: () => {} }),
    observePool: () => () => {},
    poolReloadIntervalMs: 0,
  });
  assert.equal(svc.configVersion(), 1);

  // The DB momentarily resolves an empty pool (e.g. a transient read) — must NOT wipe the live pool.
  dbPool = [];
  const r = await svc.reloadPool();
  assert.equal(r.changed, false, 'an empty resolution does not swap');
  assert.equal(r.version, 1, 'version unchanged on an empty reload');
  assert.deepEqual([...r.accounts].sort(), ['a', 'b'], 'the prior pool is retained');
  assert.equal(svc.configVersion(), 1);

  // PROOF the live pool still serves: a request pinned to 'a' still reaches the upstream with its token.
  const res = await fetch(`http://127.0.0.1:${svc.port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-papercusp-account': 'a' },
    body: JSON.stringify({ model: 'claude-opus-4', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 200);
  assert.equal(up.lastAuth(), 'Bearer a-tok', 'live pool retained after the empty reload — no restart, no wipe');
});

test('reloadPool keeps the live CODEX pool when only codex momentarily resolves EMPTY (WI-3069 fail-safe)', async () => {
  const up = await startUpstream();
  process.env.OPENAI_BASE_URL_UPSTREAM = up.base;
  tempDir = mkdtempSync(join(tmpdir(), 'codex-gw-failsafe-'));
  const codexTokenPath = join(tempDir, 'codex-main.token');
  writeFileSync(codexTokenPath, 'codex-main-tok\n', { mode: 0o600 });
  const claudeDb = [{ accountId: 'claude-main', credentialRef: 'token:/claude', source: 'pool' as const }];
  let codexDb = [{ accountId: 'codex-main', credentialRef: `token:${codexTokenPath}`, source: 'pool' as const }];
  svc = await startGatewayService({
    port: 0,
    upstreamBase: up.base,
    log: () => {},
    resolveAccounts: async (_ws, provider) => (provider === 'codex' ? codexDb : claudeDb),
    makeResolver: (_ref, id) => ({ kind: 'token', current: async () => `${id}-tok`, invalidate: () => {} }),
    observePool: () => () => {},
    poolReloadIntervalMs: 0,
  });
  assert.equal(svc.configVersion(), 1);

  // Claude's resolver still returns its healthy pool; codex's resolver has a transient hiccup and
  // momentarily resolves EMPTY. Before the WI-3069 fix this wiped the live codex pool to null
  // (createOptionalFailoverPool.reload(inner=null)) even though claude was fine — every subsequent
  // codex request then threw "no Codex account pool configured" until the next successful reload.
  codexDb = [];
  const r = await svc.reloadPool();
  assert.equal(r.changed, false, 'codex-only empty resolution does not count as a real change');
  assert.equal(r.version, 1, 'version unchanged');

  // PROOF the live codex pool still serves after the hiccup reload.
  const res = await fetch(`http://127.0.0.1:${svc.port}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-papercusp-account': 'codex-main' },
    body: JSON.stringify({ model: 'gpt-4.1', input: 'hi' }),
  });
  assert.equal(res.status, 200, 'codex pool was NOT wiped by the transient empty resolve');
  assert.equal(up.lastAuth(), 'Bearer codex-main-tok');
});

test('reloadPool follows the back-compat single resolveAccount path (re-resolves + bumps on change)', async () => {
  const up = await startUpstream();
  const acct = { accountId: 'solo', credentialRef: 'token:/s', source: 'env' as const };
  svc = await startGatewayService({
    port: 0,
    upstreamBase: up.base,
    log: () => {},
    resolveAccount: async () => ({ ...acct }),
    makeResolver: (_ref, id) => ({ kind: 'token', current: async () => `${id}-tok`, invalidate: () => {} }),
    observePool: () => () => {},
    poolReloadIntervalMs: 0,
  });
  assert.equal(svc.configVersion(), 1);

  // Same bound account → reload is a no-op.
  const noop = await svc.reloadPool();
  assert.equal(noop.changed, false);
  assert.equal(svc.configVersion(), 1);

  // The bound account's credentialRef rotates → a real change → hot-reload bumps the version.
  acct.credentialRef = 'token:/s2';
  const changed = await svc.reloadPool();
  assert.equal(changed.changed, true, 'a changed single account hot-reloads');
  assert.equal(svc.configVersion(), 2);
  assert.deepEqual(changed.accounts, ['solo']);
});

test('/admin/config exposes the live codexAccounts alongside the claude pool', async () => {
  const up = await startUpstream();
  const claudeDb = [{ accountId: 'claude-main', credentialRef: 'token:/c', source: 'pool' as const }];
  const codexDb = [{ accountId: 'codex-main', credentialRef: 'token:/x', source: 'pool' as const }];
  svc = await startGatewayService({
    port: 0,
    upstreamBase: up.base,
    log: () => {},
    resolveAccounts: async (_ws, provider) => (provider === 'codex' ? codexDb : claudeDb),
    makeResolver: (_ref, id) => ({ kind: 'token', current: async () => `${id}-tok`, invalidate: () => {} }),
    observePool: () => () => {},
    poolReloadIntervalMs: 0,
  });
  const cfg = (await (await fetch(`http://127.0.0.1:${svc.port}/admin/config`)).json()) as {
    version: number;
    accounts: string[];
    codexAccounts: string[];
  };
  assert.deepEqual(cfg.accounts, ['claude-main']);
  assert.deepEqual(cfg.codexAccounts, ['codex-main'], 'codex pool surfaced in the live config');
});

test('proactive refresh timer invalidates only file-kind resolvers, never token-kind', async () => {
  const up = await startUpstream();
  let fileInvalidates = 0;
  let tokenInvalidates = 0;
  svc = await startGatewayService({
    port: 0,
    upstreamBase: up.base,
    log: () => {},
    resolveAccounts: async () => [
      { accountId: 'filey', credentialRef: 'file:/f', source: 'pool' as const },
      { accountId: 'tokey', credentialRef: 'token:/t', source: 'pool' as const },
    ],
    makeResolver: (_ref, id) =>
      id === 'filey'
        ? { kind: 'file', current: async () => 'f-tok', invalidate: () => { fileInvalidates++; } }
        : { kind: 'token', current: async () => 't-tok', invalidate: () => { tokenInvalidates++; } },
    observePool: () => () => {},
    poolReloadIntervalMs: 0,
    refreshIntervalMs: 25, // tiny — drive several proactive refreshes within the test window
  });
  await new Promise<void>((r) => setTimeout(r, 250));
  assert.ok(fileInvalidates >= 1, `file-kind resolver is proactively refreshed (got ${fileInvalidates})`);
  assert.equal(tokenInvalidates, 0, 'token-kind (no-expiry) resolver is never invalidated');
});

// ── resolvePriorityTiers (gateway-priority-tiers-2026-06-22): flag + env → tier config ──

test('resolvePriorityTiers — flag OFF → null (gateway runs the flat queue)', async () => {
  assert.equal(await resolvePriorityTiers(24, { flagOverride: false }), null);
});

test('resolvePriorityTiers — flag ON → restoration lanes stay wide; benchmark/gym gets a bounded frame', async () => {
  const r = await resolvePriorityTiers(24, { flagOverride: true, env: {} });
  assert.ok(r, 'config returned when ON');
  assert.equal(r!.config.tier1Reserve, 4, 'ceil(24*0.15)=4');
  assert.equal(r!.config.caps![1], 24, 'tier 1 may use the whole pool');
  assert.equal(r!.config.caps![3], 20, 'implementation bees may use the shared pool');
  assert.equal(r!.config.caps![4], 10, 'benchmark/gym is bounded below implementation capacity');
  assert.equal(r!.config.caps![5], 7, 'unlabeled/default traffic is bounded below benchmark/gym');
  assert.equal(r!.map.queen, 1);
  assert.equal(r!.map.bee, 3);
  assert.equal(r!.map.gym, 4);
  assert.equal(r!.map.benchmark, 4);
  assert.equal(r!.map.su, 2);
});

test('resolvePriorityTiers — GATEWAY_PRIORITY_MAP + GATEWAY_T1_RESERVE_FRAC env overrides apply', async () => {
  const r = await resolvePriorityTiers(20, {
    flagOverride: true,
    env: { GATEWAY_PRIORITY_MAP: '{"cup":4,"newrole":2}', GATEWAY_T1_RESERVE_FRAC: '0.25' },
  });
  assert.equal(r!.config.tier1Reserve, 5, 'ceil(20*0.25)=5');
  // cup remapped to tier 4; newrole added at 2. The default/gym tiers remain present.
  assert.equal(r!.map.cup, 4, 'cup override applied');
  assert.equal(r!.map.newrole, 2, 'new role added');
  assert.equal(r!.config.caps![2], 15, 'tier 2 may use the shared pool');
  assert.equal(r!.config.caps![4], 8, 'tier 4 remains a bounded benchmark/gym-style frame');
});

test('resolvePriorityTiers — reserve floored at 1 for a tiny pool / zero frac', async () => {
  const r = await resolvePriorityTiers(3, { flagOverride: true, env: { GATEWAY_T1_RESERVE_FRAC: '0' } });
  assert.equal(r!.config.tier1Reserve, 1, 'reserve never below 1');
});
