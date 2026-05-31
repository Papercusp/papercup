import { describe, test, expect } from 'vitest';
import { decidePipelineStart, epochOf } from './orchestrator-start';

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
