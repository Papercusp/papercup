/** Hermetic composition smoke for the gateway service (P-013) — injected account + resolver. */
import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGatewayService, resolvePriorityTiers, type RunningGatewayService } from './launch';
import { INITIAL_PROVIDER_ADMISSION_WINDOW } from './provider-admission-lifecycle';
import type { GatewayPayloadSpool } from './payload-spool';

/** The per-account multiplier P-010 deleted along with `accountScaledCodexConcurrency`.
 *  Spelled here only so the falsifier below can name the number that must not return. */
const RETIRED_CODEX_SLOTS_PER_ACCOUNT = 4;

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
    makeResolver: () => ({ kind: 'token', authMode: 'oauth', current: async () => 'bound-token', invalidate: () => {} }),
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

test('payload-spool lifecycle sweep is injectable, bounded, and stopped with the gateway', async () => {
  const up = await startUpstream();
  const limits: number[] = [];
  const payloadSpool: GatewayPayloadSpool = {
    spool: async () => ({ payloadRef: null, bytes: 0, deduped: false }),
    read: async () => null,
    retain: async () => {},
    release: async () => {},
    sweep: async (options) => {
      limits.push(options?.limit ?? -1);
      return 0;
    },
  };

  svc = await startGatewayService({
    port: 0,
    upstreamBase: up.base,
    log: () => {},
    resolveAccount: async () => ({ accountId: 'test-acct', credentialRef: 'token:/dev/null', source: 'env' }),
    makeResolver: () => ({ kind: 'token', authMode: 'oauth', current: async () => 'bound-token', invalidate: () => {} }),
    observePool: () => () => {},
    poolReloadIntervalMs: 0,
    localBackendReloadIntervalMs: 0,
    payloadSpool,
    payloadSpoolSweepIntervalMs: 10,
    payloadSpoolSweepLimit: 7,
  });

  await new Promise((resolve) => setTimeout(resolve, 35));
  const callsBeforeStop = limits.length;
  assert.ok(callsBeforeStop >= 2, 'startup sweep plus at least one lifecycle tick ran');
  assert.ok(limits.every((limit) => limit === 7), 'every lifecycle sweep uses the configured bound');

  await svc.stop();
  svc = undefined;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(limits.length, callsBeforeStop, 'stop clears the payload-spool lifecycle timer');
});

test('startGatewayService sizes both provider priority-tier layers from the ONE shared admission seed', async () => {
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
      makeResolver: (_ref, id) => ({ kind: 'token', authMode: 'oauth', current: async () => `${id}-tok`, invalidate: () => {} }),
      // P-010: ONE seed feeds both lanes. There is no Codex-only size to pass, so the
      // observable property flips from "each lane sized from its own pool" to "both
      // lanes derive the same reserve from the same seed".
      //
      // The reserve is derived TWICE, by two different rules, and this test pins both
      // (EI-21833234632961797):
      //   1. CONSTRUCTION — resolvePriorityTiers → defaultTierCaps rounds UP:
      //      max(1, ceil(8 * 0.15)) = 2. This is what the launch log reports, because
      //      the log is emitted from the resolved TierAdmissionConfig.
      //   2. SERVING — provider-admission-lifecycle publishes the starting window at
      //      lane registration ("a lane never serves traffic at whatever its queue was
      //      constructed with"), so setMaxConcurrent(8) immediately rescales the reserve
      //      from the CONFIGURED fraction: round(8 * 0.15) = 1. This is what /stats reports.
      // Before the EI-21833234632961797 fix the queue INFERRED its fraction from the
      // construction absolute (2/8 = 0.25), so the rescale was a no-op at the seed and
      // /stats also read 2 — while every later cap held 25%. Asserting 1 here is the
      // falsifier for that regression: a queue that ignores `reserveFrac` reads 2.
      concurrency: 8,
      observePool: () => () => {},
      poolReloadIntervalMs: 0,
    });

    const stats = (await (await fetch(`http://127.0.0.1:${svc.port}/stats`)).json()) as {
      concurrencyCap: number;
      codexAdmission: { maxConcurrent: number; tier1Reserve?: number };
      codexAimd: { cap: number; floor: number };
    };
    assert.equal(stats.concurrencyCap, 8, 'the compat readback reports the lane high-water mark, which starts at the seed');
    assert.equal(stats.codexAdmission.maxConcurrent, 8, 'Codex starts at the shared seed, not a Codex-specific size');
    assert.equal(
      stats.codexAdmission.tier1Reserve,
      1,
      'the SERVED Codex reserve is round(8 * 0.15) — the configured fraction rescaled onto the published window, not the ceil() construction absolute',
    );
    assert.equal(stats.codexAimd.cap, 8, 'the compat AIMD readback reports the lane high-water mark');
    assert.equal(stats.codexAimd.floor, 4, 'the AIMD floor survives P-010 — a floor is a minimum, never a ceiling');
    // The launch log reports the CONSTRUCTION reserve (rule 1 above), which is 2 and
    // deliberately differs from the served 1 asserted from /stats. Pinning both here
    // keeps that divergence a documented property instead of a latent surprise for the
    // next reader who compares the boot log against a live readback.
    assert.ok(logs.some((message) => message.includes('Claude priority-tier admission ON — reserve=2')), 'launch resolves Claude tiers from the shared seed (construction reserve, pre-publish)');
    assert.ok(logs.some((message) => message.includes('Codex priority-tier admission ON — reserve=2')), 'launch resolves Codex tiers from the same seed (construction reserve, pre-publish)');
  } finally {
    if (previousFlag === undefined) delete process.env[flagEnv];
    else process.env[flagEnv] = previousFlag;
  }
});

test('one Codex account does NOT multiply into a four-slot admission cap (D-006)', async () => {
  // The falsifier for capless-inference-gateway-2026-08-28 D-006 ("serviceability
  // informs attribution, not an admission formula"). `accountScaledCodexConcurrency`
  // used to return accounts * 4 (1 account ⇒ 4); P-010 deleted the function outright,
  // so the Codex lane now opens at the SAME seed every other lane opens at and grows
  // from its own outcomes. ONE account is the fixture that separates the two rules:
  // the retired product (4) and the shared seed are different numbers here.
  const up = await startUpstream();
  const claudeDb = [{ accountId: 'claude-main', credentialRef: 'token:/claude', source: 'pool' as const }];
  const codexDb = [{ accountId: 'codex-main', credentialRef: 'token:/codex', source: 'pool' as const }];
  svc = await startGatewayService({
    port: 0,
    upstreamBase: up.base,
    log: () => {},
    resolveAccounts: async (_ws, provider) => (provider === 'codex' ? codexDb : claudeDb),
    makeResolver: (_ref, id) => ({ kind: 'token', authMode: 'oauth', current: async () => `${id}-tok`, invalidate: () => {} }),
    observePool: () => () => {},
    poolReloadIntervalMs: 0,
  });
  const stats = (await (await fetch(`http://127.0.0.1:${svc.port}/stats`)).json()) as {
    concurrencyCap: number;
    codexAdmission: { maxConcurrent: number };
    codexAimd: { cap: number };
  };
  assert.equal(
    stats.codexAdmission.maxConcurrent,
    INITIAL_PROVIDER_ADMISSION_WINDOW,
    'account count is attribution evidence, not an admission formula',
  );
  assert.equal(stats.codexAdmission.maxConcurrent, stats.concurrencyCap, 'both lanes open at the one shared seed');
  assert.notEqual(
    stats.codexAdmission.maxConcurrent,
    RETIRED_CODEX_SLOTS_PER_ACCOUNT,
    'the retired slots-per-account product must not come back',
  );
  // CALIBRATION: the assertion above is only a falsifier while the two numbers differ.
  assert.notEqual(INITIAL_PROVIDER_ADMISSION_WINDOW, RETIRED_CODEX_SLOTS_PER_ACCOUNT);
});

test('startGatewayService seeds every provider lane identically, whatever the account count', async () => {
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
    makeResolver: (_ref, id) => ({ kind: 'token', authMode: 'oauth', current: async () => `${id}-tok`, invalidate: () => {} }),
    observePool: () => () => {},
    poolReloadIntervalMs: 0,
  });
  const scaled = (await (await fetch(`http://127.0.0.1:${svc.port}/stats`)).json()) as {
    codexAdmission: { maxConcurrent: number };
    codexAimd: { cap: number; floor: number };
  };
  // D-006: the account COUNT is deliberately not an input — seven accounts open at the
  // same seed one does. (This case cannot detect a reinstated multiplication on its own;
  // the single-account case above is the falsifier for that.)
  assert.equal(
    scaled.codexAdmission.maxConcurrent,
    INITIAL_PROVIDER_ADMISSION_WINDOW,
    'the seed is the shared starting window, whatever the account count',
  );
  assert.equal(scaled.codexAimd.cap, INITIAL_PROVIDER_ADMISSION_WINDOW);
  assert.equal(scaled.codexAimd.floor, 4, 'the AIMD floor is a minimum and survives P-010');

  await svc.stop();
  svc = await startGatewayService({
    port: 0,
    upstreamBase: up.base,
    log: () => {},
    resolveAccounts,
    concurrency: 12,
    makeResolver: (_ref, id) => ({ kind: 'token', authMode: 'oauth', current: async () => `${id}-tok`, invalidate: () => {} }),
    observePool: () => () => {},
    poolReloadIntervalMs: 0,
  });
  const seeded = (await (await fetch(`http://127.0.0.1:${svc.port}/stats`)).json()) as {
    concurrencyCap: number;
    codexAdmission: { maxConcurrent: number };
    codexAimd: { cap: number; floor: number };
  };
  // An explicit bootstrap value still says where a COLD lane starts (D-002) — and it says
  // it for BOTH lanes, because there is no Codex-only input left to say it differently.
  assert.equal(seeded.codexAdmission.maxConcurrent, 12, 'the explicit seed opens the Codex lane');
  assert.equal(seeded.concurrencyCap, 12, 'and opens the Claude lane at exactly the same window');
  assert.equal(seeded.codexAimd.cap, 12);
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
    makeResolver: (_ref, id) => ({ kind: 'token', authMode: 'oauth', current: async () => `${id}-tok`, invalidate: () => {} }),
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
    makeResolver: (_ref, id) => ({ kind: 'token', authMode: 'oauth', current: async () => `${id}-tok`, invalidate: () => {} }),
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
    makeResolver: (_ref, id) => ({ kind: 'token', authMode: 'oauth', current: async () => `${id}-tok`, invalidate: () => {} }),
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
    makeResolver: (_ref, id) => ({ kind: 'token', authMode: 'oauth', current: async () => `${id}-tok`, invalidate: () => {} }),
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
      makeResolver: (_ref, id) => ({ kind: 'token', authMode: 'oauth', current: async () => `${id}-tok`, invalidate: () => {} }),
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
    makeResolver: (_ref, id) => ({ kind: 'token', authMode: 'oauth', current: async () => `${id}-tok`, invalidate: () => {} }),
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
    makeResolver: (_ref, id) => ({ kind: 'token', authMode: 'oauth', current: async () => `${id}-tok`, invalidate: () => {} }),
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
    makeResolver: (_ref, id) => ({ kind: 'token', authMode: 'oauth', current: async () => `${id}-tok`, invalidate: () => {} }),
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
    makeResolver: (_ref, id) => ({ kind: 'token', authMode: 'oauth', current: async () => `${id}-tok`, invalidate: () => {} }),
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
        ? { kind: 'file', authMode: 'oauth', current: async () => 'f-tok', invalidate: () => { fileInvalidates++; } }
        : { kind: 'token', authMode: 'oauth', current: async () => 't-tok', invalidate: () => { tokenInvalidates++; } },
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
