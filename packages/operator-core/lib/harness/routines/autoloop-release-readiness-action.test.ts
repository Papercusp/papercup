/**
 * autoloop-release-readiness-action.test.ts — WI-5144: the `system:autoloop-release-
 * readiness-monitor` system action wires evaluateAutoloopReleaseProfile() onto a
 * recurring cadence. Pins: marker parsing, fact-assert-every-tick, and the
 * go-only event emission (never on a fail).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const assertFactMock = vi.fn(async () => ({}) as never);
const emitAwaitedEventMock = vi.fn(async () => ({ ok: true, key: 'k', woken: 0, notified: [], msgId: null, waiters: 0 }) as never);

vi.mock('../../agent-facts/store', () => ({
  assertFact: (...args: unknown[]) => assertFactMock(...args),
}));
vi.mock('../../events/await/engine', () => ({
  emitAwaitedEvent: (...args: unknown[]) => emitAwaitedEventMock(...args),
}));

import {
  parseAutoloopVerdictMarker,
  setAutoloopReleaseReadinessRunner,
  AUTOLOOP_RELEASE_READINESS_FACT_KEY,
  AUTOLOOP_RELEASE_PASS_EVENT_KEY,
} from './autoloop-release-readiness-action';
import { getSystemAction } from './system-actions';

const RESULT_MARKER = '__AUTOLOOP_RELEASE_PROFILE_RESULT__';

function ctx(): Parameters<NonNullable<ReturnType<typeof getSystemAction>>>[0] {
  return { installSlug: 'papercusp', workspaceId: 'ws-test', triggerConfig: {}, payloadTemplate: null };
}

describe('parseAutoloopVerdictMarker', () => {
  it('parses the JSON on the marker line, ignoring surrounding output', () => {
    const stdout = `some noise\n${RESULT_MARKER} ${JSON.stringify({ go: true, reason: 'ok' })}\nmore noise`;
    expect(parseAutoloopVerdictMarker(stdout)).toEqual({ go: true, reason: 'ok' });
  });

  it('returns null when the marker is absent', () => {
    expect(parseAutoloopVerdictMarker('no marker here')).toBeNull();
  });

  it('returns null on unparseable JSON after the marker', () => {
    expect(parseAutoloopVerdictMarker(`${RESULT_MARKER} {not json`)).toBeNull();
  });
});

describe('system:autoloop-release-readiness-monitor', () => {
  beforeEach(() => {
    assertFactMock.mockClear();
    emitAwaitedEventMock.mockClear();
  });
  afterEach(() => {
    setAutoloopReleaseReadinessRunner(null);
  });

  it('asserts a fact every tick, and emits release-pass:autoloop on go:true', async () => {
    const verdict = { go: true, reason: 'all mandatory components pass', profileRef: 'x', evaluatedAt: 'now', components: [] };
    setAutoloopReleaseReadinessRunner(async () => ({
      code: 0,
      stdout: `${RESULT_MARKER} ${JSON.stringify(verdict)}`,
      stderr: '',
    }));

    const action = getSystemAction('autoloop-release-readiness-monitor');
    expect(action).toBeTypeOf('function');
    await action!(ctx());

    expect(assertFactMock).toHaveBeenCalledTimes(1);
    const factArg = assertFactMock.mock.calls[0][0] as Record<string, unknown>;
    expect(factArg).toMatchObject({ scope: 'workspace', key: AUTOLOOP_RELEASE_READINESS_FACT_KEY, workspaceId: 'ws-test' });
    expect(String(factArg.body)).toContain('GO');

    expect(emitAwaitedEventMock).toHaveBeenCalledTimes(1);
    const eventArg = emitAwaitedEventMock.mock.calls[0][0] as Record<string, unknown>;
    expect(eventArg).toMatchObject({ key: AUTOLOOP_RELEASE_PASS_EVENT_KEY, workspaceId: 'ws-test' });
  });

  it('asserts a fact but does NOT emit release-pass:autoloop on go:false', async () => {
    const verdict = { go: false, reason: 'production-soak-health: fail', profileRef: 'x', evaluatedAt: 'now', components: [] };
    setAutoloopReleaseReadinessRunner(async () => ({
      code: 0,
      stdout: `${RESULT_MARKER} ${JSON.stringify(verdict)}`,
      stderr: '',
    }));

    const action = getSystemAction('autoloop-release-readiness-monitor');
    await action!(ctx());

    expect(assertFactMock).toHaveBeenCalledTimes(1);
    expect(String((assertFactMock.mock.calls[0][0] as Record<string, unknown>).body)).toContain('NO-GO');
    expect(emitAwaitedEventMock).not.toHaveBeenCalled();
  });

  it('neither asserts nor emits when the evaluator run produced no parseable verdict', async () => {
    setAutoloopReleaseReadinessRunner(async () => ({ code: 1, stdout: 'garbage, no marker', stderr: 'boom' }));

    const action = getSystemAction('autoloop-release-readiness-monitor');
    await action!(ctx());

    expect(assertFactMock).not.toHaveBeenCalled();
    expect(emitAwaitedEventMock).not.toHaveBeenCalled();
  });

  it('never throws when assertFact rejects (non-fatal, still tries the event on go:true)', async () => {
    assertFactMock.mockRejectedValueOnce(new Error('db down'));
    const verdict = { go: true, reason: 'ok', profileRef: 'x', evaluatedAt: 'now', components: [] };
    setAutoloopReleaseReadinessRunner(async () => ({
      code: 0,
      stdout: `${RESULT_MARKER} ${JSON.stringify(verdict)}`,
      stderr: '',
    }));

    const action = getSystemAction('autoloop-release-readiness-monitor');
    await expect(action!(ctx())).resolves.not.toThrow();
    expect(emitAwaitedEventMock).toHaveBeenCalledTimes(1);
  });
});
