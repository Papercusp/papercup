import { describe, expect, it } from 'vitest';
import {
  classifyScheduledWatchdogStatus,
  type ScheduledWatchdogStatus,
} from './status';

function base(
  patch: Partial<Pick<ScheduledWatchdogStatus, 'config' | 'scheduler' | 'eligibility' | 'fire'>> = {},
) {
  return {
    id: 'su-ideate-ungraded' as const,
    scope: { workspaceId: 'ws', harnessSlug: 'pot' },
    config: {
      enabled: true,
      effectiveThresholdSec: 604_800,
      overrideSource: 'default' as const,
      overrideEnv: 'PAPERCUSP_SU_IDEATE_UNGRADED_STALE_SEC' as const,
      rawOverride: null,
      epochMs: 1,
      batchCap: 10,
      ...patch.config,
    },
    scheduler: {
      kind: 'dbos-operation' as const,
      parentWorkflow: 'routinesTick' as const,
      operation: 'su-ideate-ungraded-sweep' as const,
      lastExecutionAt: '2026-07-19T00:01:00.000Z',
      lastWorkflowStatus: 'SUCCESS',
      lastError: null,
      internalErrorCount: 0,
      ...patch.scheduler,
    },
    eligibility: {
      pendingCount: 0,
      eligibleCount: 0,
      oldestRoutedAt: null,
      firstEligibleAt: null,
      ...patch.eligibility,
    },
    fire: {
      source: 'su-ideate-ungraded' as const,
      count: 0,
      lastFireAt: null,
      lastReason: null,
      ...patch.fire,
    },
  };
}

describe('classifyScheduledWatchdogStatus', () => {
  it('makes zero fires healthy before any scoped row is eligible', () => {
    expect(classifyScheduledWatchdogStatus(base())).toMatchObject({
      ok: true,
      effectiveState: 'healthy-idle',
      nextVerb: null,
    });
  });

  it('reports a deliberate <=0 kill switch as disabled, not broken', () => {
    expect(
      classifyScheduledWatchdogStatus(base({ config: { enabled: false, effectiveThresholdSec: 0 } as never })),
    ).toMatchObject({ ok: true, effectiveState: 'disabled' });
  });

  it('treats a fail-soft internal sweep error as a scheduler error', () => {
    expect(classifyScheduledWatchdogStatus(base({ scheduler: { internalErrorCount: 1 } as never }))).toMatchObject({
      ok: false,
      effectiveState: 'scheduler-error',
      nextVerb: { name: 'notifications:recent' },
    });
  });

  it('distinguishes eligible-awaiting-sweep from eligible-no-fire', () => {
    const eligibility = {
      pendingCount: 1,
      eligibleCount: 1,
      oldestRoutedAt: '2026-07-11T00:00:00.000Z',
      firstEligibleAt: '2026-07-18T00:00:00.000Z',
    } as const;
    expect(
      classifyScheduledWatchdogStatus(
        base({ eligibility, scheduler: { lastExecutionAt: '2026-07-17T23:59:00.000Z' } as never }),
      ).effectiveState,
    ).toBe('eligible-awaiting-sweep');
    expect(
      classifyScheduledWatchdogStatus(
        base({ eligibility, scheduler: { lastExecutionAt: '2026-07-18T00:01:00.000Z' } as never }),
      ),
    ).toMatchObject({
      ok: false,
      effectiveState: 'eligible-no-fire',
      nextVerb: { name: 'coord:presence', args: { harness: 'pot' } },
    });
  });

  it('is healthy-fired when no eligible rows remain after a recorded fire', () => {
    expect(
      classifyScheduledWatchdogStatus(
        base({ fire: { count: 1, lastFireAt: '2026-07-18T00:01:00.000Z', lastReason: 'nudged' } as never }),
      ).effectiveState,
    ).toBe('healthy-fired');
  });
});
