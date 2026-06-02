import { describe, test, expect } from 'vitest';
import { decidePipelineStart, epochOf, pickHomeWorkspace } from './orchestrator-start';

describe('epochOf', () => {
  test('parses the :e<N> suffix', () => {
    expect(epochOf('pipeline:papercup:F-1:e0')).toBe(0);
    expect(epochOf('pipeline:papercup:F-1:e7')).toBe(7);
    expect(epochOf('pipeline:papercup:F-12:e23')).toBe(23);
  });
  test('no suffix → 0', () => {
    expect(epochOf('pipeline:papercup:F-1')).toBe(0);
    expect(epochOf('garbage')).toBe(0);
  });
});

describe('decidePipelineStart — ownership + epoch (D-011)', () => {
  const slug = 'papercup';
  const fid = 'F-1';

  test('no prior pipelines → start at epoch 0', () => {
    expect(decidePipelineStart([], slug, fid)).toEqual({
      action: 'start',
      workflowID: 'pipeline:papercup:F-1:e0',
      epoch: 0,
    });
  });

  test('one completed pipeline → start a FRESH epoch (re-pipeline after SUCCESS)', () => {
    const prior = [{ workflowID: 'pipeline:papercup:F-1:e0', status: 'SUCCESS' }];
    expect(decidePipelineStart(prior, slug, fid)).toEqual({
      action: 'start',
      workflowID: 'pipeline:papercup:F-1:e1',
      epoch: 1,
    });
  });

  test('multiple completed (SUCCESS/ERROR) → epoch = count of prior lifetimes', () => {
    const prior = [
      { workflowID: 'pipeline:papercup:F-1:e0', status: 'SUCCESS' },
      { workflowID: 'pipeline:papercup:F-1:e1', status: 'ERROR' },
    ];
    expect(decidePipelineStart(prior, slug, fid)).toEqual({
      action: 'start',
      workflowID: 'pipeline:papercup:F-1:e2',
      epoch: 2,
    });
  });

  test('a PENDING pipeline owns the feature → reuse it, do NOT start', () => {
    const prior = [{ workflowID: 'pipeline:papercup:F-1:e0', status: 'PENDING' }];
    expect(decidePipelineStart(prior, slug, fid)).toEqual({
      action: 'reuse',
      workflowID: 'pipeline:papercup:F-1:e0',
      epoch: 0,
    });
  });

  test('an ENQUEUED pipeline also owns the feature → reuse', () => {
    const prior = [{ workflowID: 'pipeline:papercup:F-1:e3', status: 'ENQUEUED' }];
    expect(decidePipelineStart(prior, slug, fid).action).toBe('reuse');
  });

  test('mixed: a completed e0 + a live e1 → reuse the live one (no double-dispatch)', () => {
    const prior = [
      { workflowID: 'pipeline:papercup:F-1:e0', status: 'SUCCESS' },
      { workflowID: 'pipeline:papercup:F-1:e1', status: 'PENDING' },
    ];
    expect(decidePipelineStart(prior, slug, fid)).toEqual({
      action: 'reuse',
      workflowID: 'pipeline:papercup:F-1:e1',
      epoch: 1,
    });
  });
});

// Regression guard for the workspace-resolution bug found by the agent-e2e: a
// durable pipeline PINS its workspace at start time, and `ensureFeaturePipeline`
// used to pin `activeWorkspaceId()` — so a feature in a harness whose home
// workspace != the (volatile) active one nulled `resolveProject`, the director
// invoke got empty output, and the pipeline ERRORed. `pickHomeWorkspace` is the
// pure selector that fixed it (the async wrapper feeds it active + members).
describe('pickHomeWorkspace — pin the harness home workspace, not the active one', () => {
  test('active IS a member → keep active (common case, behavior preserved)', () => {
    expect(pickHomeWorkspace('default', ['default'])).toBe('default');
    expect(pickHomeWorkspace('ws-a', ['ws-b', 'ws-a'])).toBe('ws-a');
  });

  test('active is NOT a member → the harness home (first member) — THE BUG FIX', () => {
    // active=papercusp-workspace, but `sheets` lives only in `default`: must pin
    // `default`, not the active one (which would null resolveProject).
    expect(pickHomeWorkspace('papercusp-workspace', ['default'])).toBe('default');
  });

  test('multiple members, active not among them → first member', () => {
    expect(pickHomeWorkspace('other', ['ws1', 'ws2'])).toBe('ws1');
  });

  test('no members (unknown/unresolvable harness) → fall back to active', () => {
    expect(pickHomeWorkspace('default', [])).toBe('default');
  });

  test('active membership wins even when other members exist (no needless switch)', () => {
    expect(pickHomeWorkspace('ws2', ['ws1', 'ws2', 'ws3'])).toBe('ws2');
  });
});
