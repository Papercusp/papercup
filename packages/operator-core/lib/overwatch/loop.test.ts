/**
 * Unit tests for the overwatch wake-loop (overwatch-role-2026-06-15 B-04, owns C-3).
 *
 * The gating (flag B-10 / started B-07), brief precompute (B-03/B-02), wake-state
 * (./liveness), and dispatch (loopbackFetch) seams are mocked. These pin C-3's
 * contract: the action is INERT until flag+started, it injects the computed brief
 * into a role=overwatch launch on the OVERWATCH wake channel (bpkind=overwatch,
 * BLUEPRINT_ID=coding), it is fail-soft (a degraded brief still launches; the handler
 * never throws — a throw after firing would double-launch on the DBOS-step retry),
 * it registers the `system:overwatch-launch` action, and it wires the B-07 waker.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const overwatchEnabled = vi.fn();
vi.mock('./watchdog', () => ({ overwatchEnabled: (...a: unknown[]) => overwatchEnabled(...a) }));

const getOverwatchStarted = vi.fn();
vi.mock('./control-state', () => ({ getOverwatchStarted: (...a: unknown[]) => getOverwatchStarted(...a) }));

const computeOverwatchBrief = vi.fn();
vi.mock('./compute-brief', () => ({ computeOverwatchBrief: (...a: unknown[]) => computeOverwatchBrief(...a) }));

const renderOverwatchBrief = vi.fn();
vi.mock('./brief-types', () => ({ renderOverwatchBrief: (...a: unknown[]) => renderOverwatchBrief(...a) }));

const declareOverwatchTimeWake = vi.fn();
const clearOverwatchTimeWake = vi.fn();
vi.mock('./liveness', () => ({
  OVERWATCH_ROLE: 'overwatch',
  OVERWATCH_BLUEPRINT_ID: 'coding',
  OVERWATCH_WAKE_TARGET_ACTION: 'system:overwatch-launch',
  declareOverwatchTimeWake: (...a: unknown[]) => declareOverwatchTimeWake(...a),
  clearOverwatchTimeWake: (...a: unknown[]) => clearOverwatchTimeWake(...a),
}));

const loopbackFetch = vi.fn();
vi.mock('../loopback-fetch', () => ({ loopbackFetch: (...a: unknown[]) => loopbackFetch(...a) }));

const overwatchScorecardEndCheck = vi.fn();
vi.mock('./scorecard-backstop', () => ({ overwatchScorecardEndCheck: (...a: unknown[]) => overwatchScorecardEndCheck(...a) }));

const recordFire = vi.fn();
vi.mock('../operator-api-base', () => ({ operatorApiBase: () => 'http://op' }));
vi.mock('../autoloop', () => ({ recordFire: (...a: unknown[]) => recordFire(...a) }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: () => Promise.resolve([]) }) }));
const resolveHiveHomeSlug = vi.fn();
vi.mock('../hive/wake', () => ({ resolveHiveHomeSlug: (...a: unknown[]) => resolveHiveHomeSlug(...a) }));
const operatorHomeHarnessSlug = vi.fn();
vi.mock('../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: (...a: unknown[]) => operatorHomeHarnessSlug(...a) }));

import { handleOverwatchLaunch, setOverwatchLaunchFire, OVERWATCH_INVOKE_TIMEOUT_MS, type OverwatchLaunchFireInput } from './loop';
import { getSystemAction } from '../harness/routines/system-actions';
import { isOverwatchWakerWired, requestOverwatchWake, clearOverwatchWake } from './wake-bridge';

const WS = 'ws-1';
const SLUG = 'papercup-hive';
const ctx = { installSlug: SLUG, workspaceId: WS, triggerConfig: {}, payloadTemplate: { kickoff: 'why-i-woke' } };

beforeEach(() => {
  vi.clearAllMocks();
  // (PAPERCUSP_HIVE_HOME_SLUG cross-file leak is scrubbed centrally in
  // @papercusp/test-config setup-hermetic-env.ts — no per-file guard needed.)
  // The loop is fail-soft: degraded-brief + skip paths log warn/log. Silence them
  // (the repo's vitest-fail-on-console plugin fails any test that logs).
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  setOverwatchLaunchFire(null);
  overwatchEnabled.mockResolvedValue(true);
  getOverwatchStarted.mockResolvedValue(true);
  computeOverwatchBrief.mockResolvedValue({ hiveSlug: SLUG, anomalies: [] });
  renderOverwatchBrief.mockReturnValue('RENDERED-BRIEF');
  declareOverwatchTimeWake.mockImplementation(async (_sql: unknown, opts: { at: Date }) => ({ at: opts.at, clamped: false }));
  resolveHiveHomeSlug.mockReturnValue('papercup-hive');
  operatorHomeHarnessSlug.mockReturnValue('papercusp');
  recordFire.mockResolvedValue(undefined);
  overwatchScorecardEndCheck.mockResolvedValue({ outcome: 'synthesized', reason: 'test backstop' });
  loopbackFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve('') });
});

describe('handleOverwatchLaunch — gating (the load-bearing flag, B-10/D-009/D-013)', () => {
  it('flag OFF ⇒ no brief, no launch (the role stays dark)', async () => {
    overwatchEnabled.mockResolvedValue(false);
    const fire = vi.fn();
    setOverwatchLaunchFire(fire);
    await handleOverwatchLaunch(ctx);
    expect(computeOverwatchBrief).not.toHaveBeenCalled();
    expect(fire).not.toHaveBeenCalled();
  });

  it('not started ⇒ no launch (B-07 pause stops the loop)', async () => {
    getOverwatchStarted.mockResolvedValue(false);
    const fire = vi.fn();
    setOverwatchLaunchFire(fire);
    await handleOverwatchLaunch(ctx);
    expect(fire).not.toHaveBeenCalled();
  });
});

describe('handleOverwatchLaunch — brief-injected launch (C-3)', () => {
  it('flag on + started ⇒ computes the brief and fires role=overwatch with it', async () => {
    let captured: OverwatchLaunchFireInput | null = null;
    setOverwatchLaunchFire((input) => {
      captured = input;
    });
    await handleOverwatchLaunch(ctx);
    expect(computeOverwatchBrief).toHaveBeenCalledWith(WS, SLUG, { wokeBy: 'why-i-woke' });
    expect(renderOverwatchBrief).toHaveBeenCalledWith({ hiveSlug: SLUG, anomalies: [] });
    expect(captured).not.toBeNull();
    expect(captured!.role).toBe('overwatch');
    expect(captured!.brief).toBe('RENDERED-BRIEF');
    expect(captured!.kickoff).toBe('why-i-woke');
    expect(captured!.installSlug).toBe(SLUG);
    expect(captured!.workspaceId).toBe(WS);
  });

  it('workspace-sentinel routine rows launch against the payload hive slug, not the workspace id', async () => {
    let captured: OverwatchLaunchFireInput | null = null;
    setOverwatchLaunchFire((input) => {
      captured = input;
    });
    await handleOverwatchLaunch({
      ...ctx,
      installSlug: WS,
      payloadTemplate: { kickoff: 'workspace wake', hiveSlug: SLUG },
    });
    expect(getOverwatchStarted).toHaveBeenCalledWith(WS, SLUG);
    expect(computeOverwatchBrief).toHaveBeenCalledWith(WS, SLUG, { wokeBy: 'workspace wake' });
    expect(captured!.installSlug).toBe(SLUG);
  });

  it('old workspace-sentinel rows without hiveSlug fall back to the configured hive home', async () => {
    let captured: OverwatchLaunchFireInput | null = null;
    setOverwatchLaunchFire((input) => {
      captured = input;
    });
    await handleOverwatchLaunch({
      ...ctx,
      installSlug: WS,
      payloadTemplate: { kickoff: 'old workspace wake' },
    });
    expect(computeOverwatchBrief).toHaveBeenCalledWith(WS, SLUG, { wokeBy: 'old workspace wake' });
    expect(captured!.installSlug).toBe(SLUG);
  });

  // EI-5842 regression: the meta-monitor was DEAD 5 days on HTTP 404 "unknown
  // project". Root cause — a workspace-sentinel row (installSlug === workspaceId)
  // resolved to resolveHiveHomeSlug(null,null), which returns NULL when
  // PAPERCUSP_HIVE_HOME_SLUG is unset, so the `?? ctx.installSlug` chain
  // re-produced the WORKSPACE ID as the invoke target → resolveProject 404. Now it
  // must fall back to operatorHomeHarnessSlug() (never the workspace id).
  it('sentinel row + null hive-home env falls back to operatorHomeHarnessSlug, NOT the workspace id (EI-5842)', async () => {
    resolveHiveHomeSlug.mockReturnValue(null); // PAPERCUSP_HIVE_HOME_SLUG unset in the bg-host
    operatorHomeHarnessSlug.mockReturnValue('papercusp');
    let captured: OverwatchLaunchFireInput | null = null;
    setOverwatchLaunchFire((input) => {
      captured = input;
    });
    await handleOverwatchLaunch({
      ...ctx,
      installSlug: WS, // installSlug === workspaceId (the sentinel row)
      payloadTemplate: { kickoff: 'sentinel wake' },
    });
    expect(captured!.installSlug).toBe('papercusp');
    expect(captured!.installSlug).not.toBe(WS); // never the workspace id (the 404 slug)
    expect(computeOverwatchBrief).toHaveBeenCalledWith(WS, 'papercusp', { wokeBy: 'sentinel wake' });
  });

  // EI-5842 regression: the second 404 row carried the `*` cross-workspace wildcard
  // as its install slug. It skips the `installSlug === workspaceId` branch, so it
  // must ALSO be treated as a sentinel and resolve to the concrete hive home.
  it('a `*` cross-workspace wildcard install slug resolves to the hive home, not `*` (EI-5842)', async () => {
    let captured: OverwatchLaunchFireInput | null = null;
    setOverwatchLaunchFire((input) => {
      captured = input;
    });
    await handleOverwatchLaunch({
      ...ctx,
      installSlug: '*',
      payloadTemplate: { kickoff: 'wildcard wake' },
    });
    expect(captured!.installSlug).toBe(SLUG); // resolveHiveHomeSlug default → papercup-hive
    expect(captured!.installSlug).not.toBe('*');
  });

  it('a default kickoff is supplied when the payload has none', async () => {
    let captured: OverwatchLaunchFireInput | null = null;
    setOverwatchLaunchFire((input) => {
      captured = input;
    });
    await handleOverwatchLaunch({ ...ctx, payloadTemplate: {} });
    expect(captured!.kickoff).toMatch(/overwatch wake/i);
  });

  it('brief precompute failure ⇒ launches with brief:null (fail-soft, the persona self-gathers)', async () => {
    computeOverwatchBrief.mockRejectedValue(new Error('survey down'));
    let captured: OverwatchLaunchFireInput | null = null;
    setOverwatchLaunchFire((input) => {
      captured = input;
    });
    await handleOverwatchLaunch(ctx);
    expect(captured).not.toBeNull();
    expect(captured!.brief).toBeNull();
  });

  it('NEVER throws even when the fire itself throws (no double-launch on DBOS retry)', async () => {
    setOverwatchLaunchFire(() => {
      throw new Error('dispatch boom');
    });
    await expect(handleOverwatchLaunch(ctx)).resolves.toBeUndefined();
  });
});

describe('the default fire — the real launch wiring (URL + body shape)', () => {
  it('POSTs the invoke route on the OVERWATCH channel with the brief + BLUEPRINT_ID=coding', async () => {
    // no injected fire → exercise defaultOverwatchFire
    await handleOverwatchLaunch(ctx);
    expect(loopbackFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = loopbackFetch.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe('http://op/api/harness/papercup-hive/invoke?role=overwatch&ws=ws-1&bpkind=overwatch');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.kickoff).toBe('why-i-woke');
    expect(body.timeoutMs).toBe(180_000);
    expect(body.extra).toEqual(['BLUEPRINT_ID=coding']); // persona resolves at blueprints/coding/prompts/overwatch.md
    expect(body.overwatchBrief).toBe('RENDERED-BRIEF');
  });

  it('default fire for a workspace-scoped wake posts to the concrete hive invoke route', async () => {
    await handleOverwatchLaunch({
      ...ctx,
      installSlug: WS,
      payloadTemplate: { kickoff: 'workspace wake', hiveSlug: SLUG },
    });
    const [url] = loopbackFetch.mock.calls[0] as [string, unknown];
    expect(url).toBe('http://op/api/harness/papercup-hive/invoke?role=overwatch&ws=ws-1&bpkind=overwatch');
  });

  // EI-5842 regression at the wire: a sentinel row with a null hive-home env must
  // NOT POST /api/harness/<workspaceId>/invoke — that is the exact URL that 404'd
  // "unknown project" and gated the overwatch dark. It must target the home hive.
  it('default fire for a sentinel row + null hive-home env posts to the home hive, not the workspace id (EI-5842)', async () => {
    resolveHiveHomeSlug.mockReturnValue(null);
    operatorHomeHarnessSlug.mockReturnValue('papercusp');
    await handleOverwatchLaunch({
      ...ctx,
      installSlug: WS,
      payloadTemplate: { kickoff: 'sentinel wake' },
    });
    const [url] = loopbackFetch.mock.calls[0] as [string, unknown];
    expect(url).toBe('http://op/api/harness/papercusp/invoke?role=overwatch&ws=ws-1&bpkind=overwatch');
    expect(url).not.toContain('/api/harness/ws-1/invoke');
  });

  it('omits overwatchBrief from the body when the brief degraded to null', async () => {
    computeOverwatchBrief.mockRejectedValue(new Error('down'));
    await handleOverwatchLaunch(ctx);
    const body = JSON.parse((loopbackFetch.mock.calls[0] as [string, { body: string }])[1].body);
    expect(body.overwatchBrief).toBeUndefined();
  });

  it('HTTP 200 + invoke ok:false records a no-turn error and runs the scorecard backstop', async () => {
    loopbackFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ ok: false, error: 'agent timed out', exitCode: 143, timedOut: true })),
    });

    await handleOverwatchLaunch(ctx);

    await vi.waitFor(() => {
      expect(recordFire).toHaveBeenCalledWith(
        SLUG,
        'overwatch',
        expect.stringContaining('invoke produced no Overwatch turn'),
        'error',
      );
    });
    expect(recordFire).not.toHaveBeenCalledWith(SLUG, 'overwatch', 'ok', 'ok');
    expect(overwatchScorecardEndCheck).toHaveBeenCalledWith({ workspaceId: WS, installSlug: SLUG });
  });

  it('HTTP 200 + empty invoke body is a no-turn error for Overwatch, not ok', async () => {
    loopbackFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(''),
    });

    await handleOverwatchLaunch(ctx);

    await vi.waitFor(() => {
      expect(recordFire).toHaveBeenCalledWith(
        SLUG,
        'overwatch',
        expect.stringContaining('empty invoke response body'),
        'error',
      );
    });
    expect(recordFire).not.toHaveBeenCalledWith(SLUG, 'overwatch', 'ok', 'ok');
    expect(overwatchScorecardEndCheck).toHaveBeenCalledWith({ workspaceId: WS, installSlug: SLUG });
  });

  it('HTTP 200 + ok:true but empty agentOutput is a no-turn error, not ok', async () => {
    loopbackFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ ok: true, agentOutput: '   ', exitCode: 0, timedOut: false })),
    });

    await handleOverwatchLaunch(ctx);

    await vi.waitFor(() => {
      expect(recordFire).toHaveBeenCalledWith(
        SLUG,
        'overwatch',
        expect.stringContaining('produced no Overwatch turn'),
        'error',
      );
    });
    expect(recordFire).not.toHaveBeenCalledWith(SLUG, 'overwatch', 'ok', 'ok');
    expect(overwatchScorecardEndCheck).toHaveBeenCalledWith({ workspaceId: WS, installSlug: SLUG });
  });

  it('transport failure records an error and runs the scorecard backstop', async () => {
    loopbackFetch.mockRejectedValue(new Error('connection refused'));

    await handleOverwatchLaunch(ctx);

    await vi.waitFor(() => {
      expect(recordFire).toHaveBeenCalledWith(SLUG, 'overwatch', expect.stringContaining('connection refused'), 'error');
    });
    await vi.waitFor(() => {
      expect(overwatchScorecardEndCheck).toHaveBeenCalledWith({ workspaceId: WS, installSlug: SLUG });
    });
  });

  it('a stuck invoke promise hits the scorecard deadline backstop instead of staying firing forever', async () => {
    vi.useFakeTimers();
    try {
      loopbackFetch.mockReturnValue(new Promise(() => {}));

      await handleOverwatchLaunch(ctx);
      await vi.advanceTimersByTimeAsync(OVERWATCH_INVOKE_TIMEOUT_MS + 15_001);

      await vi.waitFor(() => {
        expect(overwatchScorecardEndCheck).toHaveBeenCalledWith({ workspaceId: WS, installSlug: SLUG });
      });
      expect(recordFire).toHaveBeenCalledWith(
        SLUG,
        'overwatch',
        expect.stringContaining('no complete scorecard within 180000ms launch deadline'),
        'error',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('module-load wiring', () => {
  it('registers the system:overwatch-launch action under its stripped name', () => {
    expect(getSystemAction('overwatch-launch')).toBe(handleOverwatchLaunch);
  });

  it('wires the B-07 wake-bridge waker (no longer the fail-soft no-op)', () => {
    expect(isOverwatchWakerWired()).toBe(true);
  });

  it('requestWake arms an immediate time-wake via declareOverwatchTimeWake', async () => {
    const before = Date.now();
    const out = await requestOverwatchWake({ harness: SLUG, workspaceId: WS, reason: 'start now' });
    expect(out.wired).toBe(true);
    expect(declareOverwatchTimeWake).toHaveBeenCalledTimes(1);
    const opts = declareOverwatchTimeWake.mock.calls[0][1] as { installSlug: string; workspaceId: string; at: Date; kickoff: string };
    expect(opts.installSlug).toBe(SLUG);
    expect(opts.workspaceId).toBe(WS);
    expect(opts.kickoff).toBe('start now');
    expect(opts.at.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('clearWake clears the pending time-wake via clearOverwatchTimeWake', async () => {
    const out = await clearOverwatchWake({ harness: SLUG, workspaceId: WS });
    expect(out.wired).toBe(true);
    expect(clearOverwatchTimeWake).toHaveBeenCalledTimes(1);
    expect(clearOverwatchTimeWake.mock.calls[0][1]).toBe(SLUG);
  });
});
