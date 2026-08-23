import { afterEach, describe, expect, it } from 'vitest';
import type { DispatchProjectedResult } from '@papercusp/agent-mcp';
import {
  FAILURE_LOOP_DEBOUNCE_MS,
  FAILURE_LOOP_WINDOW_MS,
  __resetFailureLoopCircuitBreakerForTests,
  argumentShapeFingerprint,
  failureClassOf,
  observeFailureLoop,
  takePendingFailureLoopHint,
} from './failure-loop-circuit-breaker';

const dispatchFailure = (code = 'invalid_input'): DispatchProjectedResult => ({
  ok: false,
  error: { code: code as never, message: 'raw detail must not enter the hint' },
});
const refusal = (body: unknown): DispatchProjectedResult => ({
  ok: true,
  result: {
    isError: true,
    content: [{ type: 'text', text: typeof body === 'string' ? body : JSON.stringify(body) }],
  },
});
const success: DispatchProjectedResult = {
  ok: true,
  result: { content: [{ type: 'text', text: 'ok' }] },
};

afterEach(() => __resetFailureLoopCircuitBreakerForTests());

describe('failure-loop circuit breaker', () => {
  it('fingerprints argument SHAPE, independent of object order and scalar values', () => {
    expect(argumentShapeFingerprint({ path: '/a', opts: { n: 1, force: true } })).toBe(
      argumentShapeFingerprint({ opts: { force: false, n: 999 }, path: '/secret' }),
    );
    expect(argumentShapeFingerprint({ path: '/a' })).not.toBe(argumentShapeFingerprint({ query: '/a' }));
  });

  it('normalizes dispatcher errors and structured handler refusals without prose guessing', () => {
    expect(failureClassOf(dispatchFailure('INVALID_INPUT'))).toBe('dispatch:invalid_input');
    expect(failureClassOf(refusal({ error: 'harness_required', message: 'long prose' }))).toBe(
      'refused:harness_required',
    );
    expect(failureClassOf(refusal('plain-text refusal'))).toBe('refused');
    expect(failureClassOf(success)).toBeNull();
  });

  it('queues one hint on the third same-tool + args-shape + error-class failure', () => {
    for (let i = 0; i < 2; i++) {
      expect(
        observeFailureLoop({
          ownerId: 'su-1',
          toolName: 'docs:get',
          args: { slug: `value-${i}` },
          result: dispatchFailure(),
          now: i * 100,
        }),
      ).toBeNull();
    }
    const fired = observeFailureLoop({
      ownerId: 'su-1',
      toolName: 'docs:get',
      args: { slug: 'third-value-same-shape' },
      result: dispatchFailure(),
      now: 200,
    });
    expect(fired).toMatchObject({
      ownerId: 'su-1',
      toolName: 'docs:get',
      errorClass: 'dispatch:invalid_input',
      count: 3,
    });
    expect(takePendingFailureLoopHint('su-1', 201)).toEqual(fired);
    expect(takePendingFailureLoopHint('su-1', 202)).toBeNull();
  });

  it('does not let unrelated successful tools interrupt the failing tool streak', () => {
    observeFailureLoop({ ownerId: 'su-1', toolName: 'bad', args: {}, result: dispatchFailure(), now: 0 });
    observeFailureLoop({ ownerId: 'su-1', toolName: 'good', args: {}, result: success, now: 1 });
    observeFailureLoop({ ownerId: 'su-1', toolName: 'bad', args: {}, result: dispatchFailure(), now: 2 });
    expect(
      observeFailureLoop({ ownerId: 'su-1', toolName: 'bad', args: {}, result: dispatchFailure(), now: 3 }),
    ).not.toBeNull();
  });

  it('resets on a success or changed shape/error class for the same tool', () => {
    observeFailureLoop({ ownerId: 'su-1', toolName: 'x', args: { a: 1 }, result: dispatchFailure(), now: 0 });
    observeFailureLoop({ ownerId: 'su-1', toolName: 'x', args: { a: 2 }, result: success, now: 1 });
    observeFailureLoop({ ownerId: 'su-1', toolName: 'x', args: { a: 3 }, result: dispatchFailure(), now: 2 });
    observeFailureLoop({ ownerId: 'su-1', toolName: 'x', args: { b: 3 }, result: dispatchFailure(), now: 3 });
    observeFailureLoop({ ownerId: 'su-1', toolName: 'x', args: { b: 4 }, result: dispatchFailure('timeout'), now: 4 });
    expect(takePendingFailureLoopHint('su-1', 5)).toBeNull();
  });

  it('drops failures outside the sliding window', () => {
    observeFailureLoop({ ownerId: 'su-1', toolName: 'x', args: {}, result: dispatchFailure(), now: 0 });
    observeFailureLoop({ ownerId: 'su-1', toolName: 'x', args: {}, result: dispatchFailure(), now: 1 });
    observeFailureLoop({
      ownerId: 'su-1',
      toolName: 'x',
      args: {},
      result: dispatchFailure(),
      now: FAILURE_LOOP_WINDOW_MS + 2,
    });
    expect(takePendingFailureLoopHint('su-1', FAILURE_LOOP_WINDOW_MS + 3)).toBeNull();
  });

  it('debounces the same signal, then permits a later fresh intervention', () => {
    const fail = (now: number) =>
      observeFailureLoop({ ownerId: 'su-1', toolName: 'x', args: {}, result: dispatchFailure(), now });
    fail(0);
    fail(1);
    expect(fail(2)).not.toBeNull();
    expect(fail(3)).toBeNull();
    expect(fail(FAILURE_LOOP_DEBOUNCE_MS + 3)).toBeNull(); // window reset: first new failure
    expect(fail(FAILURE_LOOP_DEBOUNCE_MS + 4)).toBeNull();
    expect(fail(FAILURE_LOOP_DEBOUNCE_MS + 5)).not.toBeNull();
  });
});
