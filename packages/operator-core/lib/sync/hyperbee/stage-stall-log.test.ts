/**
 * stage-stall-log.test.ts — the shared named-hop pipeline observability
 * primitive (fleet-reliability-verification-2026-07-10 P-012), generalized
 * out of `outbox-drain.ts`'s WI-3619 fix. Pins: (1) silent on the healthy
 * path — a promise that settles before the threshold never logs; (2) a
 * still-pending promise past the threshold logs a named, grep-able line
 * naming BOTH the scope and the stage; (3) the wrapped promise's own
 * resolve/reject value is untouched either way (this is an observability
 * side-channel, never a timeout — a slow-but-eventually-successful await
 * still resolves normally after logging).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setBuildStampResolver, resetBuildStampResolver } from '../../../../../libs/papercusp/libs/db/src/build-stamp';
import {
  createStageAttempt,
  logIfStageStalls,
  STAGE_STALL_LOG_MS,
  traceStageSync,
  type StageAttempt,
  type StageAttemptContext,
  type StageDiagnosticEvent,
} from './stage-stall-log';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  resetBuildStampResolver();
});

describe('logIfStageStalls — named-hop pipeline observability (P-012)', () => {
  it('a promise that settles BEFORE the threshold never logs', async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const p = logIfStageStalls('scope-A', 'fast-stage', Promise.resolve('ok'));
      await vi.advanceTimersByTimeAsync(0);
      expect(await p).toBe('ok');
      // Advancing well past the threshold AFTER settle must not fire the timer
      // (it was cleared in the `finally`).
      await vi.advanceTimersByTimeAsync(STAGE_STALL_LOG_MS + 1000);
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('a promise STILL PENDING past the threshold logs a line naming the scope + stage', async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let resolveIt: (v: string) => void;
      const hung = new Promise<string>((res) => {
        resolveIt = res;
      });
      const p = logIfStageStalls('ws::harness-A', "merge-apply (features-by-id::k1)", hung);

      // Not yet at the threshold — silent.
      await vi.advanceTimersByTimeAsync(STAGE_STALL_LOG_MS - 1);
      expect(errSpy).not.toHaveBeenCalled();

      // Crosses the threshold — the named stall line fires exactly once.
      await vi.advanceTimersByTimeAsync(2);
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(errSpy.mock.calls[0][0]).toContain('ws::harness-A');
      expect(errSpy.mock.calls[0][0]).toContain('merge-apply (features-by-id::k1)');
      expect(errSpy.mock.calls[0][0]).toContain('STAGE STALL');

      // The wrapped promise still resolves normally once the underlying await
      // settles — this is observability only, never a forced timeout/reject.
      resolveIt!('finally landed');
      await expect(p).resolves.toBe('finally landed');
    } finally {
      errSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('a rejecting promise still rejects with its own error (stall-logging never swallows or replaces it)', async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let rejectIt: (e: Error) => void;
      const hung = new Promise<string>((_, rej) => {
        rejectIt = rej;
      });
      const p = logIfStageStalls('ws::harness-B', 'hypercore-append (row id=1)', hung);
      await vi.advanceTimersByTimeAsync(STAGE_STALL_LOG_MS + 1);
      expect(errSpy).toHaveBeenCalledTimes(1);

      rejectIt!(new Error('wedged connection'));
      await expect(p).rejects.toThrow('wedged connection');
    } finally {
      errSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('respects an explicit thresholdMs override instead of the shared default', async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const hung = new Promise<void>(() => {});
      void logIfStageStalls('scope-C', 'custom-stage', hung, 5_000);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(errSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2);
      expect(errSpy).toHaveBeenCalledTimes(1);
    } finally {
      errSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('assigns a distinct process/row/attempt identity and links named hops without retaining secrets', () => {
    const events: StageDiagnosticEvent[] = [];
    const attempt = createStageAttempt({ rowId: 42, onEvent: (event) => { events.push(event); } });
    const span = attempt.begin('epoch-query', 'await');
    span.end('fulfilled');
    attempt.finish();

    expect(attempt.context).toMatchObject({ rowId: '42' });
    expect(attempt.context.attemptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(attempt.context.processInstanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(events.map((event) => event.attemptId)).size).toBe(1);
    expect(events.map((event) => event.event)).toEqual([
      'attempt-start', 'hop-start', 'hop-end', 'attempt-end',
    ]);
    expect(JSON.stringify(events)).not.toMatch(/secret|SELECT|parameter/i);
  });

  it('keeps disabled and throwing sinks observational and preserves the business promise', async () => {
    const disabled = createStageAttempt({ rowId: 1, enabled: false });
    await expect(logIfStageStalls('scope', 'epoch-query', Promise.resolve('ok'), 1, {
      attempt: disabled,
      stage: 'epoch-query',
    })).resolves.toBe('ok');
    expect(disabled.snapshot().status).toBe('disabled');

    const throwing = createStageAttempt({ rowId: 2, onEvent: () => { throw new Error('sink'); } });
    await expect(logIfStageStalls('scope', 'epoch-query', Promise.resolve('ok'), 1, {
      attempt: throwing,
      stage: 'epoch-query',
    })).resolves.toBe('ok');
    expect(throwing.snapshot().status).toBe('active');
    throwing.finish();
  });

  it('does not let a late completion close a finished/expired attempt', async () => {
    vi.useFakeTimers();
    const events: StageDiagnosticEvent[] = [];
    try {
      const attempt = createStageAttempt({ rowId: 3, maxAgeMs: 5, onEvent: (event) => { events.push(event); } });
      let resolveIt!: (value: string) => void;
      const pending = new Promise<string>((resolve) => { resolveIt = resolve; });
      const wrapped = logIfStageStalls('scope', 'epoch-query', pending, 100, {
        attempt,
        stage: 'epoch-query',
      });
      await vi.advanceTimersByTimeAsync(6);
      expect(attempt.snapshot().status).toBe('expired');
      expect(attempt.snapshot().activeHops).toEqual([]);
      resolveIt('late');
      await expect(wrapped).resolves.toBe('late');
      expect(events.filter((event) => event.event === 'hop-end')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('records synchronous serialization/native boundaries separately from awaited timing', () => {
    const events: StageDiagnosticEvent[] = [];
    const attempt = createStageAttempt({ rowId: 4, onEvent: (event) => { events.push(event); } });
    expect(traceStageSync(attempt, 'serialize', () => 'encoded')).toBe('encoded');
    expect(events.filter((event) => event.event === 'hop-start')[0]).toMatchObject({
      stage: 'serialize', boundary: 'sync',
    });
    expect(events.filter((event) => event.event === 'hop-end')[0]).toMatchObject({
      stage: 'serialize', boundary: 'sync', outcome: 'fulfilled',
    });
    attempt.finish();
  });

  it('separates retry and concurrent row identities even when an older promise settles late', async () => {
    vi.useFakeTimers();
    const events: StageDiagnosticEvent[] = [];
    const onEvent = (event: StageDiagnosticEvent) => { events.push(event); };
    const first = createStageAttempt({ rowId: 10, onEvent });
    const retry = createStageAttempt({ rowId: 10, onEvent });
    const otherRow = createStageAttempt({ rowId: 11, onEvent });
    expect(new Set([first, retry, otherRow].map((a) => a.context.attemptId)).size).toBe(3);
    expect(new Set([first, retry, otherRow].map((a) => a.context.processInstanceId)).size).toBe(1);
    let resolveOld!: () => void;
    const old = logIfStageStalls('scope', 'old', new Promise<void>((resolve) => { resolveOld = resolve; }),
      100, { attempt: first, stage: 'epoch-query' });
    const newSpan = retry.begin('epoch-query', 'await');
    first.finish('abandoned');
    resolveOld();
    await old;
    expect(first.snapshot()).toMatchObject({ status: 'abandoned', activeHops: [] });
    expect(retry.snapshot().activeHops).toHaveLength(1);
    newSpan.end('fulfilled');
    retry.finish();
    otherRow.finish();
    expect(events.filter((e) => e.event === 'hop-end').map((e) => e.attemptId)).toEqual([retry.context.attemptId]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves exact return and rejection identity for synchronous and awaited work', async () => {
    vi.useFakeTimers();
    const secret = new Error('private-key-and-plaintext');
    const result = { secret: 'private-value' };
    const events: StageDiagnosticEvent[] = [];
    const attempt = createStageAttempt({ rowId: 12, onEvent: (event) => { events.push(event); } });
    const run = vi.fn(() => result);
    expect(traceStageSync(attempt, 'serialize', run)).toBe(result);
    expect(run).toHaveBeenCalledTimes(1);
    try {
      traceStageSync(attempt, 'native-encrypt', () => { throw secret; });
      expect.fail('must throw the business error');
    } catch (error) { expect(error).toBe(secret); }
    await expect(logIfStageStalls('scope', 'reject', Promise.reject(secret), 100,
      { attempt, stage: 'key-provider' })).rejects.toBe(secret);
    expect(attempt.snapshot().activeHops).toEqual([]);
    expect(events.filter((e) => e.outcome === 'rejected')).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain('private-');
    attempt.finish('rejected');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('contains async observer failures and avoids all attempt timers when disabled', async () => {
    vi.useFakeTimers();
    const sink = vi.fn();
    const disabled = createStageAttempt({ rowId: 1, enabled: false, onEvent: sink });
    expect(traceStageSync(disabled, 'serialize', () => 17)).toBe(17);
    expect(sink).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const broken = createStageAttempt({ rowId: 2, onEvent: async () => { throw new Error('observer'); } });
    expect(traceStageSync(broken, 'serialize', () => 18)).toBe(18);
    broken.finish();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds active retention and reports unobserved capacity without relabeling retained hops', () => {
    const events: StageDiagnosticEvent[] = [];
    const attempt = createStageAttempt({ rowId: 13, onEvent: (event) => { events.push(event); } });
    const spans = Array.from({ length: 70 }, () => attempt.begin('epoch-load', 'await'));
    expect(attempt.snapshot()).toMatchObject({ unobservedHops: 6 });
    expect(attempt.snapshot().activeHops).toHaveLength(64);
    expect(events.filter((e) => e.event === 'hop-unobserved')).toHaveLength(6);
    spans.forEach((span) => span.end('fulfilled'));
    expect(events.filter((e) => e.event === 'hop-end')).toHaveLength(64);
    expect(attempt.snapshot().activeHops).toEqual([]);
    attempt.finish();
  });

  it('delivers immutable snapshots and allowlisted records with explicit unknown provenance', () => {
    vi.stubEnv('PAPERCUSP_BUILD_SHA', 'unknown-with-private-path');
    const events: StageDiagnosticEvent[] = [];
    const attempt = createStageAttempt({ rowId: 'SELECT secret', onEvent: (event) => { events.push(event); } });
    const span = attempt.begin('epoch-query', 'await');
    const snapshot = attempt.snapshot();
    expect(snapshot.context).toMatchObject({ buildSha: null, rowId: null });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.context)).toBe(true);
    expect(Object.isFrozen(snapshot.activeHops)).toBe(true);
    expect(Object.isFrozen(snapshot.activeHops[0])).toBe(true);
    expect(Object.isFrozen(events[0])).toBe(true);
    attempt.begin('SELECT secret' as never, 'await');
    expect(JSON.stringify(events)).not.toContain('secret');
    span.end('fulfilled');
    expect(snapshot.activeHops).toHaveLength(1);
    expect(attempt.snapshot().activeHops).toEqual([]);
    attempt.finish();
    vi.stubEnv('PAPERCUSP_BUILD_SHA', 'aabbccddee11');
    expect(createStageAttempt({ rowId: 1 }).context.buildSha).toBeNull();
    setBuildStampResolver(() => 'aabbccddee11');
    expect(createStageAttempt({ rowId: 1 }).context.buildSha).toBe('aabbccddee11');
  });

  it('separates timer delivery delay from the requested await threshold', async () => {
    vi.useFakeTimers();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const events: StageDiagnosticEvent[] = [];
    const attempt = createStageAttempt({ rowId: 14, onEvent: (event) => { events.push(event); } });
    let resolve!: () => void;
    const wrapped = logIfStageStalls('scope', 'stage', new Promise<void>((done) => { resolve = done; }),
      10, { attempt, stage: 'epoch-query' });
    clock.mockReturnValue(25);
    await vi.advanceTimersByTimeAsync(10);
    expect(events.find((e) => e.event === 'hop-stall')).toMatchObject({
      boundary: 'await', thresholdMs: 10, elapsedMs: 25, timerDeliveryDelayMs: 15,
    });
    expect(events.some((e) => e.stage === 'native-encrypt')).toBe(false);
    resolve();
    await wrapped;
    attempt.finish();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('counterexample: the identity oracle rejects a retry reusing the preceding attempt identity', () => {
    const first = createStageAttempt({ rowId: 15 });
    const retry = createStageAttempt({ rowId: 15 });
    const assertRetry = (contexts: StageAttemptContext[]) => {
      expect(new Set(contexts.map((c) => c.attemptId)).size, 'retry attempt IDs must differ').toBe(contexts.length);
      expect(new Set(contexts.map((c) => c.processInstanceId)).size).toBe(1);
      expect(contexts.map((c) => c.rowId)).toEqual(['15', '15']);
    };
    assertRetry([first.context, retry.context]);
    // Permanent broken implementation: row identity reused as attempt identity.
    expect(() => assertRetry([first.context, { ...retry.context, attemptId: first.context.attemptId }]))
      .toThrow('retry attempt IDs must differ');
  });

  it('counterexample: the boundary oracle rejects synchronous native work relabeled as an await', () => {
    const events: StageDiagnosticEvent[] = [];
    const attempt = createStageAttempt({ rowId: 16, onEvent: (event) => { events.push(event); } });
    traceStageSync(attempt, 'native-encrypt', () => 1);
    attempt.finish();
    const hops = events.filter((e) => e.hopId !== null);
    const assertSync = (records: StageDiagnosticEvent[]) => {
      expect(records.map((e) => e.event)).toEqual(['hop-start', 'hop-end']);
      expect(records.map((e) => e.boundary), 'native boundaries must be synchronous').toEqual(['sync', 'sync']);
      expect(records.every((e) => e.timerDeliveryDelayMs === null)).toBe(true);
    };
    assertSync(hops);
    expect(() => assertSync(hops.map((e) => ({ ...e, boundary: 'await' }))))
      .toThrow('native boundaries must be synchronous');
  });

  it('counterexample: the rejection oracle rejects a diagnostic wrapper replacing the business error', async () => {
    const error = new Error('original');
    const attempt = createStageAttempt({ rowId: 17, onEvent: () => { throw new Error('sink'); } });
    const assertRejection = async (wrap: () => Promise<unknown>) => {
      let received: unknown;
      try { await wrap(); } catch (caught) { received = caught; }
      expect(received, 'original rejection object must survive').toBe(error);
    };
    await assertRejection(() => logIfStageStalls('scope', 'stage', Promise.reject(error), 100,
      { attempt, stage: 'key-provider' }));
    // Permanent broken wrapper: catches and re-creates the original business error.
    await expect(assertRejection(async () => { throw new Error(error.message); }))
      .rejects.toThrow('original rejection object must survive');
    attempt.finish('rejected');
  });

  it('counterexample: the lifecycle oracle rejects retained spans after expiry', async () => {
    vi.useFakeTimers();
    const attempt = createStageAttempt({ rowId: 18, maxAgeMs: 1, onEvent: () => {} });
    attempt.begin('epoch-query', 'await');
    const active = attempt.snapshot();
    await vi.advanceTimersByTimeAsync(1);
    const assertExpired = (snapshot: ReturnType<StageAttempt['snapshot']>) => {
      expect(snapshot.status).toBe('expired');
      expect(snapshot.activeHops, 'expired observations must release spans').toEqual([]);
    };
    assertExpired(attempt.snapshot());
    // Permanent broken lifecycle: status changed but the pending observations leaked.
    expect(() => assertExpired({ ...active, status: 'expired' }))
      .toThrow('expired observations must release spans');
    expect(vi.getTimerCount()).toBe(0);
  });
});
