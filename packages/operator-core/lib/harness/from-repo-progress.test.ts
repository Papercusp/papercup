/**
 * from-repo-progress.test.ts — the P-008 in-process step store.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordFromRepoStep,
  getFromRepoProgress,
  __resetFromRepoProgress,
} from './from-repo-progress';

beforeEach(() => __resetFromRepoProgress());

describe('from-repo-progress store (P-008)', () => {
  it('records transitions in order, per progressId', () => {
    recordFromRepoStep('a', 'lookup', 'running');
    recordFromRepoStep('a', 'lookup', 'done');
    recordFromRepoStep('b', 'clone', 'running');
    expect(getFromRepoProgress('a').map((r) => `${r.step}:${r.status}`)).toEqual([
      'lookup:running',
      'lookup:done',
    ]);
    expect(getFromRepoProgress('b')).toHaveLength(1);
    expect(getFromRepoProgress('unknown')).toEqual([]);
  });

  it('an empty progressId is a no-op', () => {
    recordFromRepoStep('', 'lookup', 'running');
    expect(getFromRepoProgress('')).toEqual([]);
  });

  it('caps the entry count (oldest dropped first)', () => {
    for (let i = 0; i < 230; i++) recordFromRepoStep(`id-${i}`, 'lookup', 'running');
    expect(getFromRepoProgress('id-0')).toEqual([]); // swept
    expect(getFromRepoProgress('id-229')).toHaveLength(1); // newest kept
  });

  it('coalesces a same-step running progress stream into ONE evolving row', () => {
    recordFromRepoStep('c', 'clone', 'running', { percent: 0 });
    recordFromRepoStep('c', 'clone', 'running', { percent: 40 });
    recordFromRepoStep('c', 'clone', 'running', { percent: 90, detail: '90%' });
    const rows = getFromRepoProgress('c');
    expect(rows).toHaveLength(1); // not 3
    expect(rows[0]).toMatchObject({ step: 'clone', status: 'running', percent: 90, detail: '90%' });
  });

  it('a status transition (running→done) appends a new row, not coalesced', () => {
    recordFromRepoStep('d', 'clone', 'running', { percent: 50 });
    recordFromRepoStep('d', 'clone', 'done', { percent: 100 });
    recordFromRepoStep('d', 'submodules', 'running', { percent: 0, detail: '0/27' });
    const rows = getFromRepoProgress('d');
    expect(rows.map((r) => `${r.step}:${r.status}`)).toEqual(['clone:running', 'clone:done', 'submodules:running']);
    expect(rows[2].detail).toBe('0/27');
  });

  it('clamps percent to 0–100 and rounds', () => {
    recordFromRepoStep('e', 'clone', 'running', { percent: 150 });
    expect(getFromRepoProgress('e')[0].percent).toBe(100);
    recordFromRepoStep('f', 'clone', 'running', { percent: -5 });
    expect(getFromRepoProgress('f')[0].percent).toBe(0);
    recordFromRepoStep('g', 'clone', 'running', { percent: 42.7 });
    expect(getFromRepoProgress('g')[0].percent).toBe(43);
  });
});
