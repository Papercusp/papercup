import { describe, it, expect } from 'vitest';
import { realFeatureToAnchorTask, type RealFeatureDescriptor } from '../real-anchor';

/**
 * Real-feature correlation anchor (P-028, D-014): a small FIXED set of real shipped
 * features replayed as `real-anchor` tasks — scored but NEVER optimized. The
 * falsifiability check: if gym score rises while the real-anchor doesn't move, the
 * loop is optimizing a proxy. This maps a real-feature descriptor → a gym task at
 * the commit BEFORE the feature was implemented.
 */
const desc: RealFeatureDescriptor = {
  harnessSlug: 'papercup',
  featureId: 'F-123',
  repoUrl: '/repos/papercup',
  baseCommit: '0123456789abcdef0123456789abcdef01234567',
  intent: 'Operators need a budget cap per harness',
  spec: 'Add maxCostUsd to harness config and enforce it.',
};

describe('realFeatureToAnchorTask', () => {
  it('maps a real shipped feature to a real-anchor task at its base commit', () => {
    const task = realFeatureToAnchorTask(desc);
    expect(task.pool).toBe('real-anchor');
    expect(task.repoUrl).toBe('/repos/papercup');
    expect(task.repoCommit).toBe('0123456789abcdef0123456789abcdef01234567');
    expect(task.intent).toBe(desc.intent);
    expect(task.spec).toBe(desc.spec);
    expect(task.generatedBy).toBe('real-feature-replay');
    expect(task.taskId).toContain('papercup');
    expect(task.taskId).toContain('F-123');
  });

  it('is deterministic in its task id', () => {
    expect(realFeatureToAnchorTask(desc).taskId).toBe(realFeatureToAnchorTask(desc).taskId);
  });

  it('requires the base commit to be a pinned SHA (D-009)', () => {
    expect(() => realFeatureToAnchorTask({ ...desc, baseCommit: 'main' })).toThrow();
  });

  it('requires a non-empty intent and spec', () => {
    expect(() => realFeatureToAnchorTask({ ...desc, intent: '' })).toThrow();
    expect(() => realFeatureToAnchorTask({ ...desc, spec: '   ' })).toThrow();
  });

  it('can replay a real feature as a training-pool task (P-026), default stays real-anchor', () => {
    expect(realFeatureToAnchorTask(desc, 'train').pool).toBe('train');
    expect(realFeatureToAnchorTask(desc).pool).toBe('real-anchor');
  });
});
