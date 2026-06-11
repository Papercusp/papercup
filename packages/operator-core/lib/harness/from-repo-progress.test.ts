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
});
