import { describe, expect, it, vi } from 'vitest';
import {
  extractPlanDecisionRefs,
  MAX_PLAN_DECISION_REFS,
  unresolvedPlanDecisionRefs,
} from './decision-ref-advisory';

describe('decision-ref-advisory', () => {
  it('extracts only qualified refs and leaves bare decision ids unknown', () => {
    expect(
      extractPlanDecisionRefs(
        'Per D-001, use real-plan#D-004; the duplicate real-plan#D-004 is still the same ruling.',
      ),
    ).toEqual(['real-plan#D-004']);
  });

  it('accepts punctuation around a qualified ref without changing its identity', () => {
    expect(extractPlanDecisionRefs('See `(real-plan-2026-09-13#D-7).`')).toEqual(['real-plan-2026-09-13#D-7']);
  });

  it('warns for a cleanly missing plan and decision', async () => {
    const probe = vi.fn(async (slug: string, decisionId: string) =>
      slug === 'real-plan'
        ? { planExists: true, decisionExists: decisionId === 'D-004' }
        : { planExists: false, decisionExists: false },
    );

    const advisory = await unresolvedPlanDecisionRefs(
      'real-plan#D-999 and ghost-plan#D-001',
      { probe },
    );

    expect(probe).toHaveBeenCalledTimes(2);
    expect(advisory).toMatchObject({
      flagged: true,
      refs: [
        { ref: 'real-plan#D-999', reason: 'missing-decision' },
        { ref: 'ghost-plan#D-001', reason: 'missing-plan' },
      ],
    });
    expect(advisory?.note).toContain('Bare D-NNN remains intentionally unknown');
  });

  it('stays silent for resolved, bare, malformed, and probe-failure refs', async () => {
    const probe = vi.fn(async () => ({ planExists: true, decisionExists: true }));
    await expect(
      unresolvedPlanDecisionRefs('D-001; malformed#P-001; real-plan#D-004', { probe }),
    ).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(1);

    const failedProbe = vi.fn(async () => {
      throw new Error('database unavailable');
    });
    await expect(unresolvedPlanDecisionRefs('real-plan#D-004', { probe: failedProbe })).resolves.toBeUndefined();
  });

  it('deduplicates and bounds probes before invoking the resolver', async () => {
    const probe = vi.fn(async () => ({ planExists: false, decisionExists: false }));
    const refs = Array.from({ length: MAX_PLAN_DECISION_REFS + 2 }, (_, i) => `plan-${i}#D-001`);

    const advisory = await unresolvedPlanDecisionRefs(refs.join(' '), { probe });

    expect(probe).toHaveBeenCalledTimes(MAX_PLAN_DECISION_REFS);
    expect(advisory?.refs).toHaveLength(MAX_PLAN_DECISION_REFS);
  });
});
