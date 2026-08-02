import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/db-org', () => ({ getOrgPg: vi.fn(() => ({ sql: vi.fn() })) }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-test') }));
vi.mock('../../pot/watchdog', () => ({
  recentWatchdogFires: vi.fn(),
  claimWatchdogFire: vi.fn(),
}));
vi.mock('../improvements/capture-core', () => ({ captureImprovement: vi.fn() }));
vi.mock('../../blueprint/learning-loop-read', () => ({ readLearningLoopHealth: vi.fn() }));

import {
  selectLearningLoopsNeedingEscalation,
  learningLoopHealthSweep,
} from './learning-loop-health-sweep';
import { summarizeLearningLoopHealth, type LearningLoopHealth } from '../../blueprint/learning-loop-health';
import { recentWatchdogFires, claimWatchdogFire } from '../../pot/watchdog';
import { captureImprovement } from '../improvements/capture-core';
import { readLearningLoopHealth } from '../../blueprint/learning-loop-read';

function loop(over: Partial<LearningLoopHealth>): LearningLoopHealth {
  return {
    blueprintId: 'scout',
    alwaysOn: true,
    singletonRow: null,
    legacyRow: null,
    collision: false,
    active: false,
    lastFiredAt: null,
    daysSinceFire: null,
    activityLastAt: null,
    daysSinceActivity: null,
    activitySource: null,
    status: 'firing',
    expectedMaterialized: true,
    ...over,
  };
}

describe('selectLearningLoopsNeedingEscalation (EI-19281872822982156)', () => {
  it('the motivating case: an always-on loop paused (should-be-on-but-dark) is selected', () => {
    const rows = [loop({ blueprintId: 'scout', status: 'should-be-on-but-dark' })];
    expect(selectLearningLoopsNeedingEscalation(rows).map((r) => r.blueprintId)).toEqual(['scout']);
  });

  it('a wedged active loop (stale) is selected', () => {
    const rows = [loop({ blueprintId: 'gym-x', status: 'stale', daysSinceFire: 5 })];
    expect(selectLearningLoopsNeedingEscalation(rows).map((r) => r.blueprintId)).toEqual(['gym-x']);
  });

  it('an expected-but-never-materialized loop (absent + expectedMaterialized) is selected', () => {
    const rows = [loop({ blueprintId: 'transfer', status: 'absent', expectedMaterialized: true })];
    expect(selectLearningLoopsNeedingEscalation(rows).map((r) => r.blueprintId)).toEqual(['transfer']);
  });

  it('an absent-but-NOT-expected loop (platform-mode-off gate) is NOT selected', () => {
    const rows = [loop({ blueprintId: 'memory-precision', status: 'absent', expectedMaterialized: false })];
    expect(selectLearningLoopsNeedingEscalation(rows)).toEqual([]);
  });

  it('a collision (both @singleton and legacy rows exist) is selected regardless of status', () => {
    const rows = [loop({ blueprintId: 'red-queen', status: 'firing', collision: true })];
    expect(selectLearningLoopsNeedingEscalation(rows).map((r) => r.blueprintId)).toEqual(['red-queen']);
  });

  it('firing / pending / dark-by-design are NOT selected — healthy or expected states', () => {
    const rows = [
      loop({ blueprintId: 'a', status: 'firing' }),
      loop({ blueprintId: 'b', status: 'pending' }),
      loop({ blueprintId: 'c', status: 'dark-by-design', alwaysOn: false }),
    ];
    expect(selectLearningLoopsNeedingEscalation(rows)).toEqual([]);
  });

  it('never drifts from summarizeLearningLoopHealth\'s own needsAttention predicate', () => {
    const rows = [
      loop({ blueprintId: 'a', status: 'firing' }),
      loop({ blueprintId: 'b', status: 'should-be-on-but-dark' }),
      loop({ blueprintId: 'c', status: 'stale' }),
      loop({ blueprintId: 'd', status: 'dark-by-design', alwaysOn: false }),
      loop({ blueprintId: 'e', status: 'absent', expectedMaterialized: true }),
      loop({ blueprintId: 'f', status: 'absent', expectedMaterialized: false }),
      loop({ blueprintId: 'g', status: 'firing', collision: true }),
    ];
    const selected = selectLearningLoopsNeedingEscalation(rows).map((r) => r.blueprintId).sort();
    const summarized = summarizeLearningLoopHealth(rows).needsAttention.slice().sort();
    expect(selected).toEqual(summarized);
  });
});

describe('learningLoopHealthSweep (EI-19281872822982156, defect 2)', () => {
  beforeEach(() => {
    vi.mocked(recentWatchdogFires).mockResolvedValue(0);
    vi.mocked(claimWatchdogFire).mockResolvedValue(true);
    vi.mocked(captureImprovement).mockResolvedValue({} as never);
  });
  afterEach(() => vi.clearAllMocks());

  it('the motivating case: scout paused (should-be-on-but-dark) — files ONE major-severity observation', async () => {
    vi.mocked(readLearningLoopHealth).mockResolvedValue([
      loop({ blueprintId: 'scout', status: 'should-be-on-but-dark', alwaysOn: true, lastFiredAt: '2026-07-27T22:33:06.115Z' }),
    ]);

    const results = await learningLoopHealthSweep();

    expect(results).toEqual([
      expect.objectContaining({ blueprintId: 'scout', outcome: 'escalated', status: 'should-be-on-but-dark' }),
    ]);
    expect(captureImprovement).toHaveBeenCalledTimes(1);
    expect(captureImprovement).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'bug',
        severity: 'major',
        title: expect.stringContaining('scout'),
      }),
    );
  });

  it('a non-always-on stale loop escalates at minor severity', async () => {
    vi.mocked(readLearningLoopHealth).mockResolvedValue([
      loop({ blueprintId: 'graduation', status: 'stale', alwaysOn: false, daysSinceFire: 5 }),
    ]);

    await learningLoopHealthSweep();

    expect(captureImprovement).toHaveBeenCalledWith(expect.objectContaining({ severity: 'minor' }));
  });

  it('a collision reports status "collision", not the underlying LearningLoopStatus', async () => {
    vi.mocked(readLearningLoopHealth).mockResolvedValue([
      loop({ blueprintId: 'red-queen', status: 'firing', collision: true }),
    ]);

    const results = await learningLoopHealthSweep();

    expect(results[0]).toMatchObject({ blueprintId: 'red-queen', status: 'collision', outcome: 'escalated' });
  });

  it('a healthy loop set escalates nothing', async () => {
    vi.mocked(readLearningLoopHealth).mockResolvedValue([loop({ blueprintId: 'scout', status: 'firing' })]);

    const results = await learningLoopHealthSweep();

    expect(results).toEqual([]);
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('debounced (already fired within 24h): never re-files', async () => {
    vi.mocked(recentWatchdogFires).mockResolvedValue(1);
    vi.mocked(readLearningLoopHealth).mockResolvedValue([
      loop({ blueprintId: 'scout', status: 'should-be-on-but-dark' }),
    ]);

    const results = await learningLoopHealthSweep();

    expect(results[0].outcome).toBe('debounced');
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('a raced claim (claimWatchdogFire returns false) reports debounced, never files twice', async () => {
    vi.mocked(claimWatchdogFire).mockResolvedValue(false);
    vi.mocked(readLearningLoopHealth).mockResolvedValue([
      loop({ blueprintId: 'scout', status: 'should-be-on-but-dark' }),
    ]);

    const results = await learningLoopHealthSweep();

    expect(results[0].outcome).toBe('debounced');
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('fully fail-soft: a read failure never throws — returns [] and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(readLearningLoopHealth).mockRejectedValue(new Error('pg down'));

    const results = await learningLoopHealthSweep();

    expect(results).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('sweep failed'));
    warn.mockRestore();
  });

  it('one loop erroring during capture never blocks the others', async () => {
    vi.mocked(readLearningLoopHealth).mockResolvedValue([
      loop({ blueprintId: 'scout', status: 'should-be-on-but-dark' }),
      loop({ blueprintId: 'change-ledger', status: 'should-be-on-but-dark' }),
    ]);
    vi.mocked(captureImprovement)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({} as never);

    const results = await learningLoopHealthSweep();

    expect(results.map((r) => r.outcome)).toEqual(['error', 'escalated']);
  });
});
