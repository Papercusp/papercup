/**
 * PORTABLE-P-010 (portable-identity-packages-2026-09-26 P-010; D-009):
 * each sink invocation enforces ONE aggregate, priority-allocated token and
 * wall-clock budget across identity contributions, with bounded concurrency.
 *
 * Falsifier under test: "adding providers multiplies the sink budget or
 * unbounded concurrency exceeds its declared limit". Every case runs real
 * providers on real timers against the real host semaphores — nothing in the
 * evaluator is mocked.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { InjectionPoint } from '@papercusp/orchestrator/blueprint';
import { validateInjectionPoint } from '@papercusp/orchestrator/blueprint';
import {
  evaluateSinkInvocation,
  isSinkResultCurrent,
  resetSinkEvaluatorForTests,
  SinkDeadlineError,
  sinkHostStatus,
  type SinkContributionRequest,
  type SinkHostLimits,
} from './sink-evaluator';

const LIMITS: SinkHostLimits = {
  sinkBudget: { tokens: 400, wallClockMs: 2_000 },
  turnCeiling: { tokens: 10_000, wallClockMs: 60_000 },
  perSessionConcurrency: 2,
};

let seq = 0;
const invocation = (overrides: Partial<{ sessionId: string; turnId: string; attachmentRevision: string }> = {}) => ({
  sessionId: overrides.sessionId ?? `sess-${++seq}`,
  turnId: overrides.turnId ?? 'turn-1',
  invocationId: `inv-${++seq}`,
  sink: 'turn-start' as const,
  attachmentRevision: overrides.attachmentRevision ?? 'rev-1',
});
const point = (tokenBudget: number, priority = 50, overBudget: InjectionPoint['overBudget'] = 'truncate'): InjectionPoint =>
  ({ sinks: ['turn-start'], trigger: 'every-turn', tokenBudget, priority, overBudget });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A provider that fills exactly its granted allowance and records that it ran. */
function filling(identityId: string, tokenBudget: number, ran: string[], priority = 50): SinkContributionRequest {
  return {
    identityId, contributionId: 'ctx', injection: point(tokenBudget, priority),
    produce: async ({ tokenAllowance }) => {
      ran.push(identityId);
      return 'x'.repeat(tokenAllowance * 4);
    },
  };
}

afterEach(() => resetSinkEvaluatorForTests());

describe('PORTABLE-P-010 aggregate sink budget', () => {
  it('COUNTEREXAMPLE: adding providers never multiplies the sink allowance', async () => {
    const oneRan: string[] = [];
    const one = await evaluateSinkInvocation({
      invocation: invocation(), limits: LIMITS, currentAttachmentRevision: () => 'rev-1',
      contributions: [filling('id-a', 300, oneRan)],
    });
    const manyRan: string[] = [];
    const many = await evaluateSinkInvocation({
      invocation: invocation(), limits: LIMITS, currentAttachmentRevision: () => 'rev-1',
      contributions: Array.from({ length: 8 }, (_, i) => filling(`id-${String.fromCharCode(97 + i)}`, 300, manyRan)),
    });
    const allowed = (r: typeof many) => r.allocation.reduce((sum, row) => sum + row.allowance, 0);
    expect(allowed(one)).toBe(300);
    // Eight providers each asking 300 still share the single 400-token pool.
    expect(allowed(many)).toBe(400);
    expect(many.deliveredTokens).toBeLessThanOrEqual(400);
    expect(many.deliveries.map((d) => [d.identityId, d.allowance])).toEqual([['id-a', 300], ['id-b', 100]]);
    // A contribution ranked after the pool is spent is never STARTED, not merely trimmed.
    expect(manyRan.sort()).toEqual(['id-a', 'id-b']);
    expect(many.omissions.filter((o) => o.reason === 'budget-exhausted').map((o) => o.identityId))
      .toEqual(['id-c', 'id-d', 'id-e', 'id-f', 'id-g', 'id-h']);
    expect(many.omissions.every((o) => o.marker.includes('omitted: budget-exhausted'))).toBe(true);
  });

  it('allocates in deterministic priority order, independent of declaration order', async () => {
    const ran: string[] = [];
    const contributions = [filling('low', 300, ran, 10), filling('high', 300, ran, 90), filling('mid', 300, ran, 50)];
    const forward = await evaluateSinkInvocation({ invocation: invocation(), limits: LIMITS,
      currentAttachmentRevision: () => 'rev-1', contributions });
    const reversed = await evaluateSinkInvocation({ invocation: invocation(), limits: LIMITS,
      currentAttachmentRevision: () => 'rev-1', contributions: contributions.slice().reverse() });
    expect(forward.allocation).toEqual(reversed.allocation);
    expect(forward.allocation.map((a) => [a.identityId, a.allowance])).toEqual([['high', 300], ['mid', 100], ['low', 0]]);
  });

  it('the per-turn host ceiling bounds the SUM across sink invocations of one turn', async () => {
    const limits = { ...LIMITS, turnCeiling: { tokens: 500, wallClockMs: 60_000 } };
    const inv = invocation();
    const first = await evaluateSinkInvocation({ invocation: inv, limits, currentAttachmentRevision: () => 'rev-1',
      contributions: [filling('a', 400, [])] });
    const second = await evaluateSinkInvocation({ invocation: { ...inv, invocationId: 'second', sink: 'agent-orders' },
      limits, currentAttachmentRevision: () => 'rev-1', contributions: [filling('b', 400, [])] });
    expect(first.deliveredTokens).toBe(400);
    expect(second.budget.tokens).toBe(100);
    expect(first.deliveredTokens + second.deliveredTokens).toBeLessThanOrEqual(500);
  });

  it('per-session concurrency never exceeds its declared limit', async () => {
    let live = 0;
    let peak = 0;
    const slow = (id: string): SinkContributionRequest => ({
      identityId: id, contributionId: 'ctx', injection: point(20),
      produce: async () => {
        live += 1;
        peak = Math.max(peak, live);
        await sleep(40);
        live -= 1;
        return 'ok';
      },
    });
    const result = await evaluateSinkInvocation({ invocation: invocation(), limits: LIMITS,
      currentAttachmentRevision: () => 'rev-1', contributions: ['a', 'b', 'c', 'd', 'e', 'f'].map(slow) });
    expect(result.deliveries).toHaveLength(6);
    expect(peak).toBe(2);
    expect(result.peakSessionInFlight).toBeLessThanOrEqual(2);
  });

  it('a provider that ignores its abort keeps its session admission slot until it settles', async () => {
    const limits = { ...LIMITS, sinkBudget: { tokens: 400, wallClockMs: 80 }, perSessionConcurrency: 1 };
    const sessionId = `sess-orphan-${++seq}`;
    let observedAbort = false;
    let release!: () => void;
    const settled = new Promise<void>((resolve) => { release = resolve; });
    const stubborn: SinkContributionRequest = {
      identityId: 'stubborn', contributionId: 'ctx', injection: point(50),
      produce: async ({ signal }) => {
        signal.addEventListener('abort', () => { observedAbort = true; });
        await settled; // non-cooperative: does not stop on abort
        return 'late';
      },
    };
    const started = Date.now();
    const first = await evaluateSinkInvocation({ invocation: invocation({ sessionId, turnId: 'turn-1' }), limits,
      currentAttachmentRevision: () => 'rev-1', contributions: [stubborn] });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(observedAbort).toBe(true);
    expect(first.omissions.map((o) => o.reason)).toEqual(['deadline']);
    expect(first.unsettledAtReturn).toBe(1);
    expect(sinkHostStatus()).toMatchObject({ hostInFlight: 1, sessionsInFlight: { [sessionId]: 1 } });

    // The orphan still counts: the same session's next turn cannot be admitted.
    const nextTurnRan: string[] = [];
    const nextTurn = await evaluateSinkInvocation({ invocation: invocation({ sessionId, turnId: 'turn-2' }), limits,
      currentAttachmentRevision: () => 'rev-1', contributions: [filling('next', 50, nextTurnRan)] });
    expect(nextTurnRan).toEqual([]);
    expect(nextTurn.omissions.map((o) => o.reason)).toEqual(['queued-past-deadline']);

    // No hidden host-wide cap: one session's orphan never starves another session.
    const otherRan: string[] = [];
    const other = await evaluateSinkInvocation({ invocation: invocation(), limits,
      currentAttachmentRevision: () => 'rev-1', contributions: [filling('other', 50, otherRan)] });
    expect(otherRan).toEqual(['other']);
    expect(other.deliveries.map((d) => d.identityId)).toEqual(['other']);

    release();
    await sleep(10);
    expect(sinkHostStatus()).toEqual({ hostInFlight: 0, sessionsInFlight: {} });
  });

  it('no nested dispatch begins after the deadline, and the late result is fenced out', async () => {
    const limits = { ...LIMITS, sinkBudget: { tokens: 400, wallClockMs: 50 } };
    let nestedRan = false;
    let nestedError: unknown = null;
    let finished!: () => void;
    const done = new Promise<void>((resolve) => { finished = resolve; });
    const result = await evaluateSinkInvocation({ invocation: invocation(), limits,
      currentAttachmentRevision: () => 'rev-1', contributions: [{
        identityId: 'nesting', contributionId: 'ctx', injection: point(50),
        produce: async ({ nested }) => {
          await sleep(120);
          try {
            await nested(async () => { nestedRan = true; return 'x'; });
          } catch (error) {
            nestedError = error;
          }
          finished();
          return 'late text that must never be injected';
        },
      }] });
    await done;
    expect(nestedRan).toBe(false);
    expect(nestedError).toBeInstanceOf(SinkDeadlineError);
    expect(result.deliveries).toEqual([]);
    expect(result.omissions.map((o) => o.reason)).toEqual(['deadline']);
  });

  it('a result evaluated against a superseded attachment is never delivered', async () => {
    let revision = 'rev-1';
    const result = await evaluateSinkInvocation({ invocation: invocation({ attachmentRevision: 'rev-1' }), limits: LIMITS,
      currentAttachmentRevision: () => revision, contributions: [{
        identityId: 'detached', contributionId: 'ctx', injection: point(50),
        produce: async () => { revision = 'rev-2'; return 'stale'; },
      }] });
    expect(result.deliveries).toEqual([]);
    expect(result.omissions.map((o) => o.reason)).toEqual(['superseded']);
    expect(isSinkResultCurrent(result, { sessionId: result.invocation.sessionId, turnId: 'turn-2',
      attachmentRevision: 'rev-1' })).toBe(false);
  });

  it('over-budget output is truncated or omitted as declared, never delivered past its allowance', async () => {
    const big = (id: string, overBudget: InjectionPoint['overBudget']): SinkContributionRequest => ({
      identityId: id, contributionId: 'ctx', injection: point(25, 50, overBudget),
      produce: async () => 'y'.repeat(4_000),
    });
    const result = await evaluateSinkInvocation({ invocation: invocation(), limits: LIMITS,
      currentAttachmentRevision: () => 'rev-1', contributions: [big('cut', 'truncate'), big('drop', 'omit')] });
    expect(result.deliveries).toHaveLength(1);
    expect(result.deliveries[0]).toMatchObject({ identityId: 'cut', truncated: true });
    expect(result.deliveries[0]!.tokens).toBeLessThanOrEqual(25);
    expect(result.omissions.map((o) => [o.identityId, o.reason])).toEqual([['drop', 'over-budget']]);
  });

  it('a provider failure fails open as a visible omission', async () => {
    const result = await evaluateSinkInvocation({ invocation: invocation(), limits: LIMITS,
      currentAttachmentRevision: () => 'rev-1', contributions: [{
        identityId: 'broken', contributionId: 'ctx', injection: point(50),
        produce: async () => { throw new Error('provider exploded'); },
      }, filling('fine', 50, [])] });
    expect(result.deliveries.map((d) => d.identityId)).toEqual(['fine']);
    expect(result.omissions[0]).toMatchObject({ identityId: 'broken', reason: 'provider-error' });
  });
});

describe('PORTABLE-P-010 compile validation of declared injection points', () => {
  const base = { id: 'ctx', purpose: 'prompt', source: 'provider', refresh: 'turn', inputKind: 'prompt-file' };
  it('accepts a provider prompt contribution at a renderable sink', () => {
    expect(validateInjectionPoint({ ...base, injection: point(100) })).toEqual([]);
  });
  it('refuses structured sinks, fixed content and a trigger/refresh mismatch', () => {
    const messages = validateInjectionPoint({ ...base, source: 'fixed', refresh: 'on-demand',
      injection: { ...point(100), sinks: ['leader-brief'] } }).map((issue) => issue.message).join('\n');
    expect(messages).toMatch(/only provider output/);
    expect(messages).toMatch(/leader-brief is a structured sink/);
    expect(messages).toMatch(/evaluated on refresh 'turn'/);
  });
  it('refuses a token budget above the host clamp', () => {
    expect(validateInjectionPoint({ ...base, injection: point(5_000) })).not.toEqual([]);
  });
});
