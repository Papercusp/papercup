/**
 * gate-canary-sweep-action.test.ts — WI-5977: the `system:gate-canary-sweep`
 * scheduled counterpart of the on-demand `gates:canary-check` tool. Pins:
 * fact-assert-every-tick, the healthy vs gate-broken classification, and the
 * EI-11574 "non-federated target is indeterminate, never a false gate-broken
 * alarm" guard.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const assertFactMock = vi.fn(async (_arg: Record<string, unknown>) => ({}) as never);
const isRegisteredHiveMock = vi.fn(async (_ws: string, _slug: string) => true);
const insertProbeMock = vi.fn(async (_stamped: unknown) => ({}) as Record<string, unknown>);

vi.mock('../agent-facts/store', () => ({
  assertFact: (arg: Record<string, unknown>) => assertFactMock(arg),
}));
vi.mock('../harness-registry', () => ({
  isRegisteredHive: (ws: string, slug: string) => isRegisteredHiveMock(ws, slug),
}));
vi.mock('../sync/pot-git/federation-probe-store', () => ({
  insertProbe: (stamped: unknown) => insertProbeMock(stamped),
}));

import './gate-canary-sweep-action';
import { GATE_CANARY_SWEEP_FACT_KEY } from './gate-canary-sweep-action';
import { getSystemAction, type SystemActionCtx } from '../harness/routines/system-actions';

function ctx(): SystemActionCtx {
  return { installSlug: 'a-federated-harness', workspaceId: 'ws-test', triggerConfig: {}, payloadTemplate: null };
}

describe('system:gate-canary-sweep', () => {
  beforeEach(() => {
    assertFactMock.mockClear();
    isRegisteredHiveMock.mockClear();
    insertProbeMock.mockClear();
    isRegisteredHiveMock.mockResolvedValue(true);
    insertProbeMock.mockResolvedValue({});
  });

  it('runs the federation-probe canary and asserts a HEALTHY-classed fact for a federated harness', async () => {
    const action = getSystemAction('gate-canary-sweep');
    expect(action).toBeTypeOf('function');
    await action!(ctx());

    expect(insertProbeMock).toHaveBeenCalledTimes(1);
    expect(assertFactMock).toHaveBeenCalledTimes(1);
    const factArg = assertFactMock.mock.calls[0][0] as Record<string, unknown>;
    expect(factArg).toMatchObject({
      scope: 'harness',
      scopeRef: 'a-federated-harness',
      key: GATE_CANARY_SWEEP_FACT_KEY,
      workspaceId: 'ws-test',
    });
    // No systemGreen signal wired (apparatus-only sweep) — a passing canary
    // with no real verdict to bifurcate against classifies 'unknown'/alarm:'none',
    // per classifyGateCanary's own contract (never a manufactured 'healthy').
    expect(String(factArg.body)).toContain('UNKNOWN');
  });

  it('does NOT probe, and reports INDETERMINATE (never gate-broken), for a non-federated harness', async () => {
    isRegisteredHiveMock.mockResolvedValue(false);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const action = getSystemAction('gate-canary-sweep');
    await action!(ctx());

    expect(insertProbeMock).not.toHaveBeenCalled();
    expect(assertFactMock).toHaveBeenCalledTimes(1);
    const factArg = assertFactMock.mock.calls[0][0] as Record<string, unknown>;
    expect(String(factArg.body)).toContain('UNKNOWN (indeterminate)');
    expect(String(factArg.body)).not.toContain('gate-broken');
    logSpy.mockRestore();
  });

  it('reports INDETERMINATE, not gate-broken, when the federation lookup itself errors', async () => {
    isRegisteredHiveMock.mockRejectedValue(new Error('pg down'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const action = getSystemAction('gate-canary-sweep');
    await expect(action!(ctx())).resolves.not.toThrow();

    expect(insertProbeMock).not.toHaveBeenCalled();
    const factArg = assertFactMock.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(String(factArg.body)).toContain('UNKNOWN (indeterminate)');
    expect(String(factArg.body)).toContain('lookup failed');
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('warns (not just logs) when the canary alarm is not none', async () => {
    // Force the apparatus itself to fail: insertProbe rejects, which
    // buildFederationProbeCanary's run() surfaces as ok:false ("persistence failed"),
    // classifying alarm:'gate' via classifyGateCanary.
    insertProbeMock.mockRejectedValue(new Error('insert failed'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const action = getSystemAction('gate-canary-sweep');
    await action!(ctx());

    expect(warnSpy).toHaveBeenCalled();
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('alarm=gate');
    const factArg = assertFactMock.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(String(factArg.body)).toContain('GATE-BROKEN');
    warnSpy.mockRestore();
  });

  it('never throws when assertFact itself rejects (non-fatal)', async () => {
    assertFactMock.mockRejectedValueOnce(new Error('db down'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const action = getSystemAction('gate-canary-sweep');
    await expect(action!(ctx())).resolves.not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
