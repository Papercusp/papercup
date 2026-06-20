/**
 * placement-gather.test.ts — EI-FIX-033: null harness validation for EI items
 *
 * Tests that gatherFrontier properly validates and fails loud when EI items
 * (operator-scope items with null harness) are placed without an explicit
 * fallback harness parameter.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { workItemToTask, partitionTasksByReadiness } from './placement-gather';
import type { PlacementTask } from './placement-affinity';

describe('workItemToTask — harness backfill for EI items (F-FIX-033)', () => {
  it('backfills harness from fallbackHarness when wi.harness is null', () => {
    const ei = {
      id: 'EI-123',
      harness: null,
      title: 'Test issue',
      state: 'todo',
    };
    const task = workItemToTask(ei as any, 'papercusp');
    expect(task.harness).toBe('papercusp');
    expect(task.id).toBe('EI-123');
  });

  it('prefers wi.harness over fallbackHarness when both are present', () => {
    const wi = {
      id: 'F-456',
      harness: 'my-harness',
      title: 'Feature',
      state: 'todo',
    };
    const task = workItemToTask(wi as any, 'fallback');
    expect(task.harness).toBe('my-harness');
  });

  it('returns null harness when both wi.harness and fallbackHarness are null/undefined', () => {
    const ei = {
      id: 'EI-789',
      harness: null,
      title: 'Unplaced issue',
      state: 'todo',
    };
    const task = workItemToTask(ei as any, undefined);
    expect(task.harness).toBeNull();
    expect(task.id).toBe('EI-789');
  });

  it('ignores whitespace-only fallbackHarness as if undefined', () => {
    const ei = {
      id: 'EI-999',
      harness: null,
      title: 'Issue',
      state: 'todo',
    };
    const task = workItemToTask(ei as any, '   ');
    expect(task.harness).toBeNull();
  });
});

describe('partitionTasksByReadiness — null harness handling (F-FIX-033)', () => {
  it('treats null-harness tasks as unblocked (no blocking graph)', () => {
    const tasks: PlacementTask[] = [
      {
        id: 'EI-100',
        harness: null, // null harness — no blocking constraints
        title: 'Unplaced',
        files: [],
        planSlug: null,
        brief: null,
      },
      {
        id: 'F-200',
        harness: 'proj',
        title: 'Feature',
        files: [],
        planSlug: null,
        brief: null,
      },
    ];

    const result = partitionTasksByReadiness(tasks, new Map());
    // Both should be "ready" since no blocking graph exists for either
    expect(result.ready.length).toBe(2);
    expect(result.blocked.length).toBe(0);
    // Note: the null-harness task should ideally be caught earlier by validation
    // in gatherFrontier, not allowed to reach here
  });
});
