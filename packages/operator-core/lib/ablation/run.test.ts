import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runPromptAblation } from './run';
import { runAblationCycle } from './runner';

// Unit: the cap-bound cycle + replay leg have their own suites; this pins the
// SHARED orchestration — the two gates (flag → governor), the payload→cycle-config
// mapping (the governor cap is the hard bound), and the best-effort spend ledger
// (deterministic-blueprints-migration-2026-06-13 P-121, D-004 behavior-neutral).
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getOrgPg: () => ({ sql: {} }) };
});
vi.mock('./replay-leg', () => ({ makeAblationReplayLeg: vi.fn(() => ({ replay: 'leg' })) }));
vi.mock('./runner', () => ({ runAblationCycle: vi.fn() }));
vi.mock('./governor', () => ({ promptAblationGovernorGate: vi.fn(), PROMPT_ABLATION_LOOP_ID: 'prompt-ablation' }));
vi.mock('../learning-governor/store', () => ({ recordLearningSpend: vi.fn() }));

const mockCycle = vi.mocked(runAblationCycle);

const INPUT = { workspaceId: 'ws-1', installSlug: 'papercup' };
const CYCLE_RESULT = { runRowId: 'run-9', costUsd: 1.25, verdict: 'dead-weight-candidate' };

function deps(over: Record<string, unknown> = {}) {
  return {
    flag: async () => true,
    governorGate: async () => ({ allow: true, remainingUsd: 5 }) as never,
    runner: mockCycle as never,
    recordSpend: vi.fn(),
    ...over,
  };
}

describe('runPromptAblation — flag → governor → cap-bound cycle → spend ledger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCycle.mockResolvedValue(CYCLE_RESULT as unknown as Awaited<ReturnType<typeof runAblationCycle>>);
  });

  it('skips with flag-off (governor never consulted)', async () => {
    const gate = vi.fn();
    const out = await runPromptAblation(INPUT, deps({ flag: async () => false, governorGate: gate }));
    expect(out).toEqual({ ran: false, skipReason: 'flag-off' });
    expect(gate).not.toHaveBeenCalled();
    expect(mockCycle).not.toHaveBeenCalled();
  });

  it('skips with governor-refused (carrying the reason)', async () => {
    const out = await runPromptAblation(INPUT, deps({ governorGate: async () => ({ allow: false, reason: 'cap hit' }) as never }));
    expect(out).toEqual({ ran: false, skipReason: 'governor-refused', governorReason: 'cap hit' });
    expect(mockCycle).not.toHaveBeenCalled();
  });

  it('runs the cycle with the governor remainingUsd as the HARD per-cycle cap + maps the payload', async () => {
    await runPromptAblation(
      { ...INPUT, payload: { scenarioIds: ['s1', 's2'], repeat: 3, ruleKey: ' rule-x ', ledgerWindowDays: 30 } },
      deps(),
    );
    expect(mockCycle).toHaveBeenCalledWith(
      {
        workspaceId: 'ws-1',
        maxCycleCostUsd: 5,
        scenarioIds: ['s1', 's2'],
        repeat: 3,
        ruleKey: 'rule-x', // trimmed
        ledgerWindowDays: 30,
      },
      expect.objectContaining({ replayLeg: { replay: 'leg' } }),
    );
  });

  it('ignores out-of-range payload knobs (repeat must be 1..5 int)', async () => {
    await runPromptAblation({ ...INPUT, payload: { repeat: 99 } }, deps());
    const cfg = mockCycle.mock.calls[0][0];
    expect(cfg).not.toHaveProperty('repeat');
  });

  it('ledgers realized spend when costUsd > 0', async () => {
    const recordSpend = vi.fn();
    const out = await runPromptAblation(INPUT, deps({ recordSpend }));
    expect(recordSpend).toHaveBeenCalledWith({ workspaceId: 'ws-1', costUsd: 1.25, runRef: 'run-9' });
    expect(out).toEqual({ ran: true, result: CYCLE_RESULT });
  });

  it('does NOT ledger when the cycle was free (costUsd === 0)', async () => {
    mockCycle.mockResolvedValue({ runRowId: 'r0', costUsd: 0 } as unknown as Awaited<ReturnType<typeof runAblationCycle>>);
    const recordSpend = vi.fn();
    await runPromptAblation(INPUT, deps({ recordSpend }));
    expect(recordSpend).not.toHaveBeenCalled();
  });

  it('survives a spend-ledger failure (cycle result still returned)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const recordSpend = vi.fn().mockRejectedValue(new Error('ledger down'));
    const out = await runPromptAblation(INPUT, deps({ recordSpend }));
    expect(out).toEqual({ ran: true, result: CYCLE_RESULT });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
