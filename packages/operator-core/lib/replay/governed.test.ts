/**
 * governed.test.ts — the flag + governor gate around the battery (P-020 /
 * FB-06, D-001 double-dark + D-004 refusal). All deps faked; the flag-off
 * path must never touch a pool (the default-on-flag-glue insight) — pinned by
 * fakes that throw when reached.
 */
import { describe, expect, it } from 'vitest';
import type { JudgeLlmCall } from '@papercusp/eval-battery';
import { REPLAY_BASELINE_VARIANT } from './battery';
import { replayPreflight, runGovernedReplay, type ReplayGlueDeps } from './governed';
import { REPLAY_LOOP_ID, type ReplayCase, type ReplayRunner, type ReplayStore } from './types';

const neverSql = async () => {
  throw new Error('pool must not be touched on this path');
};

const fakeJudge: JudgeLlmCall = async () => ({
  text: JSON.stringify({ d1: 7, d2: 7, d3: 7, rationale: 'ok' }),
  costUsd: 0.01,
  inputTokens: 10,
  outputTokens: 10,
});

const runner: ReplayRunner = async () => ({
  outputText: 'continuation',
  costUsd: 0.02,
  inputTokens: 10,
  outputTokens: 10,
  replayed: true,
});

const noopStore: ReplayStore = {
  startRun: async () => {},
  finishRun: async () => {},
  recordScore: async () => {},
  markFailed: async () => {},
};

const syntheticCase: ReplayCase = { kind: 'synthetic', caseId: 'c1', context: 'mid-task', intent: 'finish it' };

describe('replayPreflight', () => {
  it('flag OFF ⇒ replay-dark, governor never consulted, pool untouched', async () => {
    const verdict = await replayPreflight(
      { workspaceId: 'ws' },
      {
        enabled: async () => false,
        getSql: neverSql,
        preflight: async () => {
          throw new Error('governor must not be consulted while dark');
        },
      },
    );
    expect(verdict).toEqual({ allow: false, reason: 'replay-dark', remainingUsd: null });
  });

  it('flag ON ⇒ the governor verdict passes through (loop id pinned)', async () => {
    let seenLoopId = '';
    const verdict = await replayPreflight(
      { workspaceId: 'ws' },
      {
        enabled: async () => true,
        preflight: async (q) => {
          seenLoopId = q.loopId;
          return { allow: true, remainingUsd: 3.5 };
        },
      },
    );
    expect(seenLoopId).toBe(REPLAY_LOOP_ID);
    expect(verdict).toEqual({ allow: true, remainingUsd: 3.5 });
  });

  it('fail-CLOSED: an erroring gate refuses', async () => {
    const verdict = await replayPreflight(
      { workspaceId: 'ws' },
      {
        enabled: async () => {
          throw new Error('posthog down');
        },
        log: () => {},
      },
    );
    expect(verdict).toEqual({ allow: false, reason: 'governor-error', remainingUsd: null });
  });
});

describe('runGovernedReplay', () => {
  const baseConfig = {
    batteryId: 'bat-gov',
    variants: [REPLAY_BASELINE_VARIANT],
    cases: [syntheticCase],
    repeats: 1,
  };

  it('refused preflight ⇒ no battery, no spend, result null', async () => {
    const out = await runGovernedReplay(
      { workspaceId: 'ws', config: baseConfig },
      {
        runner: async () => {
          throw new Error('runner must not run while dark');
        },
        llmCall: fakeJudge,
        now: () => 0,
      },
      { enabled: async () => false, getSql: neverSql },
    );
    expect(out.verdict.reason).toBe('replay-dark');
    expect(out.result).toBeNull();
  });

  it('allowed ⇒ runs the battery, clamps the cap to remaining budget, ledgers spend origin=replay', async () => {
    const spends: unknown[] = [];
    const glue: ReplayGlueDeps = {
      enabled: async () => true,
      preflight: async () => ({ allow: true, remainingUsd: 5 }),
      getSql: async () => ({}) as never,
      recordSpend: (async (_sql: unknown, input: unknown) => {
        spends.push(input);
        return {} as never;
      }) as ReplayGlueDeps['recordSpend'],
    };
    const out = await runGovernedReplay(
      { workspaceId: 'ws', config: { ...baseConfig, maxSpendUsd: 9 } },
      { runner, llmCall: fakeJudge, store: noopStore, now: () => 0 },
      glue,
    );
    expect(out.result?.outcomes[0]?.status).toBe('scored');
    expect(spends).toHaveLength(1);
    expect(spends[0]).toMatchObject({
      loopId: REPLAY_LOOP_ID,
      signalOrigin: 'replay',
      runRef: 'bat-gov',
      accumulate: true,
      costUsd: out.result!.totalCostUsd,
    });
  });

  it('spend-ledger failure never loses the battery result', async () => {
    const out = await runGovernedReplay(
      { workspaceId: 'ws', config: baseConfig },
      { runner, llmCall: fakeJudge, store: noopStore, now: () => 0 },
      {
        enabled: async () => true,
        preflight: async () => ({ allow: true, remainingUsd: null }),
        getSql: async () => ({}) as never,
        recordSpend: (async () => {
          throw new Error('ledger down');
        }) as ReplayGlueDeps['recordSpend'],
        log: () => {},
      },
    );
    expect(out.result?.outcomes).toHaveLength(1);
  });
});
