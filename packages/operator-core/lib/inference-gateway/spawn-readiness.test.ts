/**
 * spawn-readiness.test.ts — the deterministic gateway-readiness spawn-admission core
 * (WI-390 layer 1). Pure decision table; no I/O.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  decideSpawnAdmission,
  isGatewayReadyForSpawn,
  fetchGatewayReadinessSignals,
  logSpawnReadinessShadow,
  DEFAULT_SPAWN_DEFER_BACKOFF_MS,
  type GatewayReadinessSignals,
} from './spawn-readiness';

const sig = (over: Partial<GatewayReadinessSignals> = {}): GatewayReadinessSignals => ({
  serviceableAccounts: 3,
  admissionQueued: 0,
  admissionMaxQueued: 256,
  ...over,
});

describe('decideSpawnAdmission (WI-390 deterministic readiness gate)', () => {
  it('ADMITS when ≥1 account is serviceable and the admission queue is below the shed cap', () => {
    expect(decideSpawnAdmission(sig())).toEqual({ admit: true });
    expect(decideSpawnAdmission(sig({ serviceableAccounts: 1, admissionQueued: 255 }))).toEqual({ admit: true });
  });

  it('DEFERS with no_serviceable_account when zero accounts can serve (the dominant wedge cause)', () => {
    const d = decideSpawnAdmission(sig({ serviceableAccounts: 0 }));
    expect(d).toMatchObject({ admit: false, defer: true, reason: 'no_serviceable_account' });
    expect((d as { retryAfterMs: number }).retryAfterMs).toBe(DEFAULT_SPAWN_DEFER_BACKOFF_MS);
  });

  it('DEFERS with admission_shedding when the queue is AT or OVER the shed cap', () => {
    expect(decideSpawnAdmission(sig({ admissionQueued: 256 }))).toMatchObject({
      admit: false,
      defer: true,
      reason: 'admission_shedding',
    });
    expect(decideSpawnAdmission(sig({ admissionQueued: 9999 }))).toMatchObject({ reason: 'admission_shedding' });
  });

  it('no_serviceable_account takes priority over admission_shedding (an empty pool is the worse signal)', () => {
    expect(decideSpawnAdmission(sig({ serviceableAccounts: 0, admissionQueued: 9999 }))).toMatchObject({
      reason: 'no_serviceable_account',
    });
  });

  it('an unknown/zero shed cap disables the shedding check (don\'t gate on a cap we don\'t know)', () => {
    expect(decideSpawnAdmission(sig({ admissionMaxQueued: 0, admissionQueued: 5000 }))).toEqual({ admit: true });
  });

  it('a non-finite serviceable count is treated as not-serviceable (fail-closed on a bad read)', () => {
    expect(decideSpawnAdmission(sig({ serviceableAccounts: Number.NaN }))).toMatchObject({
      reason: 'no_serviceable_account',
    });
  });

  it('honors a custom backoff', () => {
    const d = decideSpawnAdmission(sig({ serviceableAccounts: 0 }), { backoffMs: 12_000 });
    expect((d as { retryAfterMs: number }).retryAfterMs).toBe(12_000);
  });

  it('isGatewayReadyForSpawn is the boolean projection', () => {
    expect(isGatewayReadyForSpawn(sig())).toBe(true);
    expect(isGatewayReadyForSpawn(sig({ serviceableAccounts: 0 }))).toBe(false);
    expect(isGatewayReadyForSpawn(sig({ admissionQueued: 256 }))).toBe(false);
  });
});

describe('fetchGatewayReadinessSignals (WI-390 wiring: gateway GET /stats → signals)', () => {
  const origFetch = global.fetch;
  afterEach(() => {
    global.fetch = origFetch;
  });

  it('maps a healthy /stats response into GatewayReadinessSignals', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ healthyAccounts: 3, admission: { queued: 5 }, maxQueued: 256 }), { status: 200 }),
    ) as unknown as typeof fetch;
    const s = await fetchGatewayReadinessSignals({ gatewayBase: 'http://x' });
    expect(s).toEqual({ serviceableAccounts: 3, admissionQueued: 5, admissionMaxQueued: 256 });
  });

  it('returns null (fail-open) on a non-ok HTTP status', async () => {
    global.fetch = vi.fn(async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;
    expect(await fetchGatewayReadinessSignals({ gatewayBase: 'http://x' })).toBeNull();
  });

  it('returns null (fail-open) when the gateway is unreachable', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(await fetchGatewayReadinessSignals({ gatewayBase: 'http://x' })).toBeNull();
  });

  it('returns null (fail-open) on a malformed / missing healthyAccounts field', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ admission: { queued: 0 } }), { status: 200 })) as unknown as typeof fetch;
    expect(await fetchGatewayReadinessSignals({ gatewayBase: 'http://x' })).toBeNull();
  });

  it('defaults missing admission.queued / maxQueued to 0', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ healthyAccounts: 2 }), { status: 200 })) as unknown as typeof fetch;
    const s = await fetchGatewayReadinessSignals({ gatewayBase: 'http://x' });
    expect(s).toEqual({ serviceableAccounts: 2, admissionQueued: 0, admissionMaxQueued: 0 });
  });
});

describe('logSpawnReadinessShadow (WI-390 SHADOW-mode wiring: non-enforcing telemetry only)', () => {
  const origFetch = global.fetch;
  const origEnv = process.env.PAPERCUSP_SPAWN_READINESS_SHADOW;
  beforeEach(() => {
    delete process.env.PAPERCUSP_SPAWN_READINESS_SHADOW;
  });
  afterEach(() => {
    global.fetch = origFetch;
    if (origEnv === undefined) delete process.env.PAPERCUSP_SPAWN_READINESS_SHADOW;
    else process.env.PAPERCUSP_SPAWN_READINESS_SHADOW = origEnv;
  });

  it('logs a "would DEFER" line when the live signals say not-ready', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ healthyAccounts: 0, admission: { queued: 0 }, maxQueued: 256 }), { status: 200 }),
    ) as unknown as typeof fetch;
    const logFn = vi.fn();
    await logSpawnReadinessShadow({ role: 'cup', spawnId: 'sp-1' }, logFn);
    expect(logFn).toHaveBeenCalledTimes(1);
    const msg = logFn.mock.calls[0][0] as string;
    expect(msg).toContain('[spawn-readiness][SHADOW]');
    expect(msg).toContain('would DEFER');
    expect(msg).toContain('role=cup');
    expect(msg).toContain('spawnId=sp-1');
    expect(msg).toContain('no_serviceable_account');
    expect(msg).toContain('NOT enforced');
  });

  it('does NOT log when the live signals say ready', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ healthyAccounts: 3, admission: { queued: 0 }, maxQueued: 256 }), { status: 200 }),
    ) as unknown as typeof fetch;
    const logFn = vi.fn();
    await logSpawnReadinessShadow({ role: 'cup' }, logFn);
    expect(logFn).not.toHaveBeenCalled();
  });

  it('never throws / logs when the gateway is unreachable (fail-open, no opinion)', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const logFn = vi.fn();
    await expect(logSpawnReadinessShadow({ role: 'cup' }, logFn)).resolves.toBeUndefined();
    expect(logFn).not.toHaveBeenCalled();
  });

  it('is disabled entirely via PAPERCUSP_SPAWN_READINESS_SHADOW=0 — never fetches, never logs', async () => {
    process.env.PAPERCUSP_SPAWN_READINESS_SHADOW = '0';
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ healthyAccounts: 0 }), { status: 200 }),
    ) as unknown as typeof fetch;
    const logFn = vi.fn();
    await logSpawnReadinessShadow({ role: 'cup' }, logFn);
    expect(logFn).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
