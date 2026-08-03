/**
 * learning-loop-read.test.ts — pins the production WIRING `readLearningLoopHealth`
 * passes to the pure classifier (`computeLearningLoopHealth` is mocked; its own
 * behavior is covered by learning-loop-health.test.ts).
 *
 * EI-19370813549389199: `routines.last_fired_at` is stamped at CLAIM time
 * (harness/routines/claim.ts), before the handler body runs — while Scout's
 * `scout_ticks` activity is only recorded once a REAL (non-gated) cycle completes,
 * which legitimately takes up to `DEFAULT_SCOUT_CYCLE_TIMEOUT_MS` (20min). The
 * generic 5min `activityLagGraceMs` default false-pages Scout as `stale` on almost
 * every fire while a cycle is still in flight (reproduced live: a fire read `stale`
 * with a 27min lag, then posted a normal `ran` tick 5min later). This test pins that
 * `readLearningLoopHealth` widens the grace to the cycle's own ceiling + a buffer
 * instead of the classifier's tight generic default.
 *
 * Run: cd packages/operator-core && npx vitest run lib/blueprint/learning-loop-read.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SCOUT_CYCLE_TIMEOUT_MS } from '../scout/scheduler';

const h = vi.hoisted(() => ({ routineRows: [] as unknown[], scoutTickRows: [] as unknown[] }));

vi.mock('./seed-learning-singletons', () => ({
  LEARNING_SINGLETONS: [{ blueprintId: 'scout', legacyRoutine: 'scout-legacy' }],
}));
vi.mock('../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: vi.fn(() => 'acme-home') }));
vi.mock('./materialize-triggers', () => ({
  platformImprovementLoopsEnabled: vi.fn(async () => true),
  isPlatformImprovementLoop: vi.fn(() => false),
}));
vi.mock('./learning-loop-health', async (orig) => ({
  ...(await orig<typeof import('./learning-loop-health')>()),
  computeLearningLoopHealth: vi.fn(() => []),
}));

import { computeLearningLoopHealth } from './learning-loop-health';
const computeM = vi.mocked(computeLearningLoopHealth);
import { readLearningLoopHealth } from './learning-loop-read';

beforeEach(() => {
  vi.clearAllMocks();
  h.routineRows = [
    {
      install_slug: '@singleton',
      name: 'bp-singleton-scout-0',
      active: true,
      last_fired_at: new Date('2026-08-03T00:30:02.510Z'),
      next_fire_at: new Date('2026-08-03T01:00:00.000Z'),
      pause_review_by: null,
    },
  ];
  h.scoutTickRows = [{ last_tick_at: new Date('2026-08-03T00:12:10.846Z') }];
});

// Same dual-shape sql mock as learning-loops.test.ts: a tagged-template call (first
// arg has .raw) resolves rows in call order; sql([...]) IN-clause helper calls return
// an opaque fragment.
function fakeSql() {
  let call = 0;
  const fn = (first: unknown) => {
    if (first && (first as { raw?: unknown }).raw) {
      call += 1;
      return Promise.resolve(call === 1 ? h.routineRows : h.scoutTickRows);
    }
    return { __frag: first };
  };
  return fn as unknown as import('postgres').Sql;
}

describe('readLearningLoopHealth wiring', () => {
  it('widens activityLagGraceMs past the generic 5min default to cover a full Scout cycle', async () => {
    await readLearningLoopHealth(fakeSql(), 'ws-1', { nowMs: Date.parse('2026-08-03T00:35:33.291Z') });

    expect(computeM).toHaveBeenCalledTimes(1);
    const opts = computeM.mock.calls[0]![2] as { activityLagGraceMs?: number };
    expect(opts.activityLagGraceMs).toBeGreaterThanOrEqual(DEFAULT_SCOUT_CYCLE_TIMEOUT_MS);
    // Comfortably above the live-observed 27min false-positive lag.
    expect(opts.activityLagGraceMs).toBeGreaterThan(27 * 60_000);
  });

  it('passes the live-observed lag shape (27min) as within the widened grace, not past it', async () => {
    await readLearningLoopHealth(fakeSql(), 'ws-1', { nowMs: Date.parse('2026-08-03T00:35:33.291Z') });
    const opts = computeM.mock.calls[0]![2] as { activityLagGraceMs?: number };
    const firedMs = Date.parse('2026-08-03T00:30:02.510Z');
    const activityMs = Date.parse('2026-08-03T00:12:10.846Z');
    expect(firedMs - activityMs).toBeLessThan(opts.activityLagGraceMs!);
  });

  it('passes the scout activity ledger through unchanged (regression guard)', async () => {
    await readLearningLoopHealth(fakeSql(), 'ws-1', {});
    const opts = computeM.mock.calls[0]![2] as {
      activityByBlueprintId?: Record<string, { lastActivityAt: string | null; source: string }>;
    };
    expect(opts.activityByBlueprintId?.scout).toEqual({
      lastActivityAt: '2026-08-03T00:12:10.846Z',
      source: 'scout_ticks',
    });
  });
});
