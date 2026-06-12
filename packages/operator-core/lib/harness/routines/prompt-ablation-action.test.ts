import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/flags', () => ({
  FLAGS: {
    PROMPT_ABLATION: 'papercusp-prompt-ablation',
    REPLAY_HARNESS: 'papercusp-replay-harness',
    CHANGE_LEDGER: 'papercusp-change-ledger',
    LEARNING_GOVERNOR: 'papercusp-learning-governor',
  },
}));
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: vi.fn(() => ({ sql: {} })) }));

// Importing the module registers the `prompt-ablation` system action.
import {
  setPromptAblationCycleRunner,
  setPromptAblationGovernorGate,
  setPromptAblationSpendRecorder,
} from './prompt-ablation-action';
import { getSystemAction } from './system-actions';
import { getFlag } from '@papercusp/flags/server';
import type { AblationCycleConfig, AblationCycleResult } from '../../ablation/runner';

const ctx = (over: Record<string, unknown> = {}) => ({
  installSlug: 'pot',
  workspaceId: 'ws-1',
  triggerConfig: {},
  payloadTemplate: null,
  ...over,
});
const run = (over: Record<string, unknown> = {}) => getSystemAction('prompt-ablation')!(ctx(over) as never);

function fakeResult(over: Partial<AblationCycleResult> = {}): AblationCycleResult {
  return {
    runRowId: 'row-1',
    ruleKey: 'rules/some-rule',
    ruleHash: 'aaaaaaaaaaaa',
    ruleLead: 'Some rule',
    score: { verdict: 'no-delta' } as AblationCycleResult['score'],
    costUsd: 1.25,
    capped: false,
    replayLegRan: false,
    ...over,
  };
}

let runner: ReturnType<typeof vi.fn>;
let spend: ReturnType<typeof vi.fn>;
beforeEach(() => {
  runner = vi.fn(async (_cfg: AblationCycleConfig) => fakeResult());
  spend = vi.fn(async () => {});
  setPromptAblationCycleRunner(runner as never);
  setPromptAblationSpendRecorder(spend as never);
  // Governor allows by default — the gate's own verdicts live in
  // lib/ablation/governor.test.ts; here we pin the action's wiring.
  setPromptAblationGovernorGate(async () => ({ allow: true, remainingUsd: 8 }));
  vi.mocked(getFlag).mockResolvedValue(true as never);
});
afterEach(() => {
  setPromptAblationCycleRunner(null);
  setPromptAblationGovernorGate(null);
  setPromptAblationSpendRecorder(null);
  vi.clearAllMocks();
});

describe('system:prompt-ablation (self-learning-frontier P-023 / FB-09)', () => {
  it('registers as a system action', () => {
    expect(getSystemAction('prompt-ablation')).toBeTypeOf('function');
  });

  it('flag OFF → no cycle (the frontier D-001 arming gate)', async () => {
    vi.mocked(getFlag).mockResolvedValue(false as never);
    await run();
    expect(runner).not.toHaveBeenCalled();
  });

  it('governor refuses → no cycle (D-004 unattended-refusal, FB-01)', async () => {
    setPromptAblationGovernorGate(async () => ({ allow: false, reason: 'unbudgeted', remainingUsd: null }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run();
      expect(runner).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('learning-governor refused (unbudgeted)'));
    } finally {
      log.mockRestore();
    }
  });

  it("the governor's per-cycle budget becomes the runner's hard cap; payload tunes the cycle", async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run({
        payloadTemplate: { scenarioIds: ['su-S01-harness-scope'], repeat: 2, ruleKey: 'a/b', ledgerWindowDays: 7 },
      });
    } finally {
      log.mockRestore();
    }
    expect(runner).toHaveBeenCalledTimes(1);
    const cfg = runner.mock.calls[0]![0] as AblationCycleConfig;
    expect(cfg).toMatchObject({
      workspaceId: 'ws-1',
      maxCycleCostUsd: 8,
      scenarioIds: ['su-S01-harness-scope'],
      repeat: 2,
      ruleKey: 'a/b',
      ledgerWindowDays: 7,
    });
    // the replay leg is wired at this registrar (production glue), not defaulted in the lib
    const deps = runner.mock.calls[0]![1] as { replayLeg?: unknown };
    expect(deps.replayLeg).toBeTypeOf('function');
  });

  it('ledgers realized spend on the prompt-ablation loop (accumulate — the scout pattern)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run();
    } finally {
      log.mockRestore();
    }
    expect(spend).toHaveBeenCalledWith({ workspaceId: 'ws-1', costUsd: 1.25, runRef: 'row-1' });
  });

  it('zero-cost cycles ledger nothing; spend-ledger failures never sink the cycle', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      runner.mockResolvedValueOnce(fakeResult({ costUsd: 0 }));
      await run();
      expect(spend).not.toHaveBeenCalled();

      spend.mockRejectedValueOnce(new Error('ledger down'));
      await expect(run()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('spend ledgering failed'),
        'ledger down',
      );
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  it('a cycle failure never throws out of the durable step', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      runner.mockRejectedValue(new Error('llm down'));
      await expect(run()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith('[prompt-ablation] cycle FAILED:', 'llm down');
    } finally {
      warn.mockRestore();
    }
  });
});
