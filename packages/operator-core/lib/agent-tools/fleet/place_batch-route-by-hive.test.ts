/**
 * place_batch-route-by-hive.test.ts — P-003 Phase B: the cross-hive routing
 * tally for the central dispatcher (D-002). `routeByHive` resolves each task's
 * harness → its home hive (the P-001 source/target-hive tag) and tallies the
 * batch's target hives — routing VISIBILITY (the per-task `harness` already
 * routes spawn/affinity onto that harness's, hence that hive's, bees). It runs
 * ONLY when WORKSPACE_COORDINATION is ON, so it adds no reads to the dark default.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ hiveHomeSlugForHarness: vi.fn() }));

vi.mock('../../hive-federation', () => ({ hiveHomeSlugForHarness: h.hiveHomeSlugForHarness }));

import { routeByHive } from './place_batch';
import type { PlacementTask } from '../../fleet/placement-affinity';

const task = (id: string, harness: string | null): PlacementTask => ({
  id,
  harness,
  title: id,
  files: [],
  planSlug: null,
  brief: null,
});

beforeEach(() => h.hiveHomeSlugForHarness.mockReset());

describe('routeByHive (P-003 Phase B)', () => {
  it('tallies a cross-hive batch by each task\'s home hive (harness→hive tag)', async () => {
    h.hiveHomeSlugForHarness.mockImplementation(async (_ws: string, harness: string) =>
      harness === 'proj-a' ? 'hive-a' : harness === 'proj-b' ? 'hive-b' : null,
    );
    const byHive = await routeByHive(
      [task('WI-1', 'proj-a'), task('WI-2', 'proj-a'), task('WI-3', 'proj-b')],
      'ws',
    );
    expect(byHive).toEqual({ 'hive-a': 2, 'hive-b': 1 });
  });

  it('buckets an un-tagged harness under its own slug (never silently dropped)', async () => {
    h.hiveHomeSlugForHarness.mockResolvedValue(null); // no hive_slug → not a member
    const byHive = await routeByHive([task('WI-1', 'standalone')], 'ws');
    expect(byHive).toEqual({ standalone: 1 });
  });

  it('buckets a harness-less (operator-scope) task under (no-harness)', async () => {
    const byHive = await routeByHive([task('EI-9', null)], 'ws');
    expect(byHive).toEqual({ '(no-harness)': 1 });
    expect(h.hiveHomeSlugForHarness).not.toHaveBeenCalled();
  });

  it('fails soft per task (a resolve error falls back to the harness slug)', async () => {
    h.hiveHomeSlugForHarness.mockRejectedValue(new Error('pg down'));
    const byHive = await routeByHive([task('WI-1', 'proj-a')], 'ws');
    expect(byHive).toEqual({ 'proj-a': 1 });
  });
});
